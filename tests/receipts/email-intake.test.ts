// Tests for ADR 0011 email receipt intake (lib/receipts/email-intake.ts).
//
// Coverage follows the repo convention (see month-lock.test.ts / receipt-locks):
// pure helpers + D1-injected functions are unit-tested with a fake D1; the
// promoteIntake orchestrator is getReceiptsDb()-coupled (it calls
// createReceiptRecord, which resolves its own binding) and is exercised by the
// live §8 verification, not here — same convention by which createReceiptRecord
// itself has no unit test. Its pure pieces (buildPromoteReceiptInput,
// assertPromotable) ARE covered below.

import test from "node:test";
import assert from "node:assert/strict";
import {
  INTAKE_MAX_MESSAGE_BYTES,
  classifyAttachment,
  generateIntakeR2Key,
  recordIntake,
  listPendingIntake,
  rejectIntake,
  buildPromoteReceiptInput,
  assertPromotable,
} from "@/lib/receipts/email-intake";
import { MAX_RECEIPT_FILE_BYTES } from "@/lib/receipts/upload-policy";
import type { EmailReceiptIntake } from "@/lib/receipts/types";

// ─── Fake D1 + R2 ────────────────────────────────────────────────────────────
//
// A structural fake that models just the SQL shapes email-intake.ts issues
// against email_receipt_intake (and the audit log). SELECTs read from an
// in-memory rows array; INSERT/UPDATE mutate it. Captured statements are
// exposed for assertions where state isn't enough (e.g. "the invalid
// attachment was not put to R2").

interface FakeDb {
  rows: EmailReceiptIntake[];
  auditInserts: number;
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
  // D1Database members not exercised by email-intake.ts; stubbed so the fake
  // structurally satisfies D1Database (createAuditEntry takes a full D1Database).
  batch(_statements: unknown[]): Promise<unknown[]>;
  exec(_query: string): Promise<unknown>;
  withSession(): unknown;
  dump(): Promise<ArrayBuffer>;
}

interface FakeBucket {
  puts: Array<{ key: string; contentType: string; bytes: number }>;
  deleted: string[];
  put(key: string, data: ArrayBuffer, opts: { httpMetadata?: { contentType?: string } }): Promise<void>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
}

function createFakeDb(initial: EmailReceiptIntake[] = []): FakeDb {
  const db: FakeDb = {
    rows: initial.map((r) => ({ ...r })),
    auditInserts: 0,
    batch: async () => [],
    exec: async () => ({}),
    withSession: () => ({}),
    dump: async () => new ArrayBuffer(0),
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (/FROM email_receipt_intake WHERE id = \?/.test(sql)) {
                const id = String(args[0]);
                return (db.rows.find((r) => r.id === id) ?? null) as T | null;
              }
              return null as T | null;
            },
            async all<T>(): Promise<{ results: T[] }> {
              if (/status = 'pending_triage'/.test(sql)) {
                const rows = db.rows
                  .filter((r) => r.status === "pending_triage")
                  .sort((a, b) => b.received_at.localeCompare(a.received_at));
                return { results: rows as unknown as T[] };
              }
              return { results: [] };
            },
            async run(): Promise<unknown> {
              if (/INSERT INTO email_receipt_intake/.test(sql)) {
                db.rows.push(rowFromInsertBinds(args));
              } else if (/UPDATE email_receipt_intake/.test(sql)) {
                applyIntakeUpdate(db.rows, sql, args);
              } else if (/INSERT INTO receipt_audit_log/.test(sql)) {
                db.auditInserts += 1;
              }
              return {};
            },
          };
        },
      };
    },
  };
  return db;
}

// INSERT column order in recordIntake (see the SQL in email-intake.ts).
function rowFromInsertBinds(args: unknown[]): EmailReceiptIntake {
  return {
    id: String(args[0]),
    received_at: String(args[1]),
    from_address: String(args[2]),
    subject: (args[3] as string | null) ?? null,
    spf_pass: Number(args[4]),
    dkim_pass: Number(args[5]),
    attachment_r2_key: (args[6] as string | null) ?? null,
    attachment_sha256: (args[7] as string | null) ?? null,
    attachment_content_type: (args[8] as string | null) ?? null,
    attachment_size_bytes: (args[9] as number | null) ?? null,
    attachment_filename: (args[10] as string | null) ?? null,
    status: (args[11] as EmailReceiptIntake["status"]) ?? "pending_triage",
    reject_reason: (args[12] as string | null) ?? null,
    promoted_receipt_id: (args[13] as string | null) ?? null,
    raw_headers_json: (args[14] as string | null) ?? null,
    created_at: String(args[15]),
    to_address: (args[16] as string | null) ?? null,
  };
}

function applyIntakeUpdate(rows: EmailReceiptIntake[], sql: string, args: unknown[]): void {
  // rejectIntake: SET status='rejected', reject_reason=? WHERE id=? AND status='pending_triage'
  if (/status = 'rejected'/.test(sql)) {
    const reason = String(args[0]);
    const id = String(args[1]);
    for (const r of rows) {
      if (r.id === id && r.status === "pending_triage") {
        r.status = "rejected";
        r.reject_reason = reason;
      }
    }
  }
}

// email-intake.ts takes a full D1Database; the fake models only the prepare()
// subset those functions actually issue. Cast through unknown once here instead
// of fighting D1Database's abstract-class shape (D1PreparedStatement/D1Result)
// at every call site. Mirrors how a rich abstract class is faked elsewhere.
function asD1(db: FakeDb): D1Database {
  return db as unknown as D1Database;
}

// R2Bucket is another rich abstract class (head/list/multipart/…); cast the
// fake at the call site, keep the rich FakeBucket for assertions.
function asR2(bucket: FakeBucket): R2Bucket {
  return bucket as unknown as R2Bucket;
}

function createFakeBucket(): FakeBucket {
  const store = new Map<string, ArrayBuffer>();
  const bucket: FakeBucket = {
    puts: [],
    deleted: [],
    async put(key, data, opts) {
      bucket.puts.push({
        key,
        contentType: opts.httpMetadata?.contentType ?? "",
        bytes: data.byteLength,
      });
      store.set(key, data);
    },
    async get(key) {
      const data = store.get(key);
      return data ? { arrayBuffer: async () => data } : null;
    },
    async delete(key) {
      bucket.deleted.push(key);
      store.delete(key);
    },
  };
  return bucket;
}

function intakeRow(over: Partial<EmailReceiptIntake> = {}): EmailReceiptIntake {
  return {
    id: "intake-1",
    received_at: "2026-07-19T00:00:00.000Z",
    from_address: "vendor@example.com",
    to_address: "receipts@dazbeez.com",
    subject: "Receipt",
    spf_pass: 1,
    dkim_pass: 0,
    attachment_r2_key: "receipts-intake/2026/07/intake-1/abc.pdf",
    attachment_sha256: "deadbeef",
    attachment_content_type: "application/pdf",
    attachment_size_bytes: 1234,
    attachment_filename: "r.pdf",
    status: "pending_triage",
    reject_reason: null,
    promoted_receipt_id: null,
    raw_headers_json: null,
    created_at: "2026-07-19T00:00:00.000Z",
    ...over,
  };
}

const baseInput = {
  receivedAt: "2026-07-19T00:00:00.000Z",
  fromAddress: "vendor@example.com",
  toAddress: "receipts@dazbeez.com",
  subject: "Your receipt",
  spfPass: true,
  dkimPass: false,
  rawHeadersJson: null,
};

// ─── classifyAttachment ─────────────────────────────────────────────────────

test("classifyAttachment: valid PDF accepted", () => {
  const v = classifyAttachment({ filename: "a.pdf", contentType: "application/pdf", sizeBytes: 100 });
  assert.equal(v.valid, true);
  assert.equal(v.rejectReason, null);
});

test("classifyAttachment: valid JPEG accepted", () => {
  const v = classifyAttachment({ filename: "a.jpg", contentType: "image/jpeg", sizeBytes: 100 });
  assert.equal(v.valid, true);
});

test("classifyAttachment: oversized → invalid, flagged not dropped", () => {
  const v = classifyAttachment({
    filename: "a.pdf",
    contentType: "application/pdf",
    sizeBytes: MAX_RECEIPT_FILE_BYTES + 1,
  });
  assert.equal(v.valid, false);
  assert.match(v.rejectReason ?? "", /too large/i);
});

test("classifyAttachment: disallowed MIME → invalid (even with .pdf name)", () => {
  const v = classifyAttachment({ filename: "a.pdf", contentType: "text/html", sizeBytes: 100 });
  assert.equal(v.valid, false);
  assert.match(v.rejectReason ?? "", /not allowed/i);
});

test("classifyAttachment: generic MIME falls back to extension (.pdf ok)", () => {
  const v = classifyAttachment({
    filename: "a.pdf",
    contentType: "application/octet-stream",
    sizeBytes: 100,
  });
  assert.equal(v.valid, true);
});

test("classifyAttachment: generic MIME + disallowed extension → invalid", () => {
  const v = classifyAttachment({
    filename: "a.exe",
    contentType: "application/octet-stream",
    sizeBytes: 100,
  });
  assert.equal(v.valid, false);
});

// ─── generateIntakeR2Key ─────────────────────────────────────────────────────

test("generateIntakeR2Key: receipts-intake prefix, embeds intake id + month, sanitizes filename", () => {
  const key = generateIntakeR2Key("intake-9", "Re ceipt (1).PDF", "2026-07-19T00:00:00Z");
  // spaces and parens all collapse to '_': "Re ceipt (1).PDF" → "Re_ceipt__1_.PDF"
  assert.match(key, /^receipts-intake\/2026\/07\/intake-9\/[0-9a-f-]+-Re_ceipt__1_\.PDF$/);
});

test("generateIntakeR2Key: never collides with the promoted receipts/ prefix", () => {
  const key = generateIntakeR2Key("i", "x.pdf", "2026-01-01T00:00:00Z");
  assert.ok(!key.startsWith("receipts/"), "intake key must not use the promoted receipts/ prefix");
});

// ─── recordIntake ────────────────────────────────────────────────────────────

test("recordIntake: zero attachments → one row, 'no attachment', NULL key, pending_triage", async () => {
  const db = createFakeDb();
  const bucket = createFakeBucket();
  const ids = await recordIntake(asD1(db), asR2(bucket), { ...baseInput, attachments: [] });
  assert.equal(ids.length, 1);
  assert.equal(db.rows.length, 1);
  const row = db.rows[0];
  assert.equal(row.status, "pending_triage", "body-only stays pending_triage, not auto-rejected");
  assert.equal(row.attachment_r2_key, null);
  assert.equal(row.reject_reason, "no attachment");
  assert.equal(bucket.puts.length, 0, "nothing written to R2");
});

test("recordIntake: one valid attachment → row with R2 key + sha256, put to R2", async () => {
  const db = createFakeDb();
  const bucket = createFakeBucket();
  const data = new TextEncoder().encode("%PDF-1.4 hello").buffer;
  const ids = await recordIntake(asD1(db), asR2(bucket), {
    ...baseInput,
    attachments: [{ filename: "inv.pdf", contentType: "application/pdf", sizeBytes: data.byteLength, data }],
  });
  assert.equal(ids.length, 1);
  const row = db.rows[0];
  assert.equal(row.status, "pending_triage");
  assert.ok(row.attachment_r2_key, "valid attachment gets an R2 key");
  assert.ok(row.attachment_sha256 && row.attachment_sha256.length === 64, "sha256 hex recorded");
  assert.equal(row.attachment_filename, "inv.pdf");
  assert.equal(bucket.puts.length, 1, "valid attachment written to R2 exactly once");
  assert.equal(bucket.puts[0].contentType, "application/pdf");
});

test("recordIntake: oversized attachment → row recorded with NULL key + reason, NOT put to R2", async () => {
  const db = createFakeDb();
  const bucket = createFakeBucket();
  const big = new Uint8Array(MAX_RECEIPT_FILE_BYTES + 1);
  const ids = await recordIntake(asD1(db), asR2(bucket), {
    ...baseInput,
    attachments: [{ filename: "big.pdf", contentType: "application/pdf", sizeBytes: big.byteLength, data: big.buffer }],
  });
  assert.equal(ids.length, 1);
  const row = db.rows[0];
  assert.equal(row.status, "pending_triage", "invalid attachment stays pending_triage (not auto-rejected)");
  assert.equal(row.attachment_r2_key, null, "no R2 object for an invalid attachment");
  assert.match(row.reject_reason ?? "", /too large/i);
  assert.equal(bucket.puts.length, 0, "oversized attachment must not be written to R2");
});

test("recordIntake: to_address round-trips through all three row-insert branches", async () => {
  const valid = new TextEncoder().encode("%PDF-1.4").buffer;
  const big = new Uint8Array(MAX_RECEIPT_FILE_BYTES + 1);
  type Att = { filename: string; contentType: string; sizeBytes: number; data: ArrayBuffer };
  const input = (attachments: Att[]) => ({
    ...baseInput,
    toAddress: "receipt@dazbeez.com",
    attachments,
  });

  // zero-attachment branch
  let db = createFakeDb();
  await recordIntake(asD1(db), asR2(createFakeBucket()), input([]));
  assert.equal(db.rows[0].to_address, "receipt@dazbeez.com", "zero-attachment branch");

  // valid-attachment branch
  db = createFakeDb();
  await recordIntake(asD1(db), asR2(createFakeBucket()), input([
    { filename: "a.pdf", contentType: "application/pdf", sizeBytes: valid.byteLength, data: valid },
  ]));
  assert.equal(db.rows[0].to_address, "receipt@dazbeez.com", "valid-attachment branch");

  // invalid-attachment branch
  db = createFakeDb();
  await recordIntake(asD1(db), asR2(createFakeBucket()), input([
    { filename: "big.pdf", contentType: "application/pdf", sizeBytes: big.byteLength, data: big.buffer },
  ]));
  assert.equal(db.rows[0].to_address, "receipt@dazbeez.com", "invalid-attachment branch");
});

test("recordIntake: null to_address is accepted (defensive — message.to absent)", async () => {
  const db = createFakeDb();
  await recordIntake(asD1(db), asR2(createFakeBucket()), { ...baseInput, toAddress: null, attachments: [] });
  assert.equal(db.rows[0].to_address, null);
});

test("recordIntake: multiple attachments → one row per attachment (fan-out)", async () => {
  const db = createFakeDb();
  const bucket = createFakeBucket();
  const a = new TextEncoder().encode("pdf-A").buffer;
  const b = new TextEncoder().encode("png-B").buffer;
  const ids = await recordIntake(asD1(db), asR2(bucket), {
    ...baseInput,
    attachments: [
      { filename: "a.pdf", contentType: "application/pdf", sizeBytes: a.byteLength, data: a },
      { filename: "b.png", contentType: "image/png", sizeBytes: b.byteLength, data: b },
    ],
  });
  assert.equal(ids.length, 2, "one intake row per attachment");
  assert.equal(db.rows.length, 2);
  assert.equal(bucket.puts.length, 2, "each valid attachment put to R2");
});

test("recordIntake: SPF/DKIM verdicts captured onto each row", async () => {
  const db = createFakeDb();
  const bucket = createFakeBucket();
  const data = new TextEncoder().encode("x").buffer;
  await recordIntake(asD1(db), asR2(bucket), {
    ...baseInput,
    spfPass: false,
    dkimPass: true,
    attachments: [{ filename: "a.pdf", contentType: "application/pdf", sizeBytes: 1, data }],
  });
  assert.equal(db.rows[0].spf_pass, 0);
  assert.equal(db.rows[0].dkim_pass, 1);
});

test("INTAKE_MAX_MESSAGE_BYTES is 10 MiB and tighter than the 5 MiB receipt limit", () => {
  assert.equal(INTAKE_MAX_MESSAGE_BYTES, 10 * 1024 * 1024);
  assert.ok(INTAKE_MAX_MESSAGE_BYTES > MAX_RECEIPT_FILE_BYTES);
});

// ─── listPendingIntake ───────────────────────────────────────────────────────

test("listPendingIntake: returns only pending_triage, newest first", async () => {
  const db = createFakeDb([
    intakeRow({ id: "old", received_at: "2026-07-01T00:00:00Z", status: "pending_triage" }),
    intakeRow({ id: "new", received_at: "2026-07-18T00:00:00Z", status: "pending_triage" }),
    intakeRow({ id: "prom", status: "promoted" }),
    intakeRow({ id: "rej", status: "rejected" }),
  ]);
  const rows = await listPendingIntake(asD1(db));
  assert.deepEqual(
    rows.map((r) => r.id),
    ["new", "old"],
    "only pending_triage, newest first; promoted/rejected excluded",
  );
});

// ─── rejectIntake ─────────────────────────────────────────────────────────────

test("rejectIntake: requires a non-empty reason", async () => {
  const db = createFakeDb([intakeRow()]);
  await assert.rejects(() => rejectIntake(asD1(db), "intake-1", "   ", "actor"), /reject_reason is required/i);
  await assert.rejects(() => rejectIntake(asD1(db), "intake-1", "", "actor"), /reject_reason is required/i);
});

test("rejectIntake: flips pending → rejected with reason, audits, leaves receipt_records untouched", async () => {
  const db = createFakeDb([intakeRow()]);
  await rejectIntake(asD1(db), "intake-1", "personal expense", "david");
  assert.equal(db.rows[0].status, "rejected");
  assert.equal(db.rows[0].reject_reason, "personal expense");
  assert.equal(db.auditInserts, 1, "one audit entry written");
});

test("rejectIntake: refuses on a non-pending row", async () => {
  const db = createFakeDb([intakeRow({ status: "promoted" })]);
  await assert.rejects(() => rejectIntake(asD1(db), "intake-1", "x", "a"), /only pending_triage may be rejected/i);
});

test("rejectIntake: not-found row throws", async () => {
  const db = createFakeDb([]);
  await assert.rejects(() => rejectIntake(asD1(db), "nope", "x", "a"), /not found/i);
});

// ─── buildPromoteReceiptInput (pure half of promote) ────────────────────────

test("buildPromoteReceiptInput: source=email, sourceType=email_attachment, status=captured, capturedBy=from", () => {
  const input = buildPromoteReceiptInput(intakeRow({ from_address: "v@x.com" }));
  assert.equal(input.source, "email");
  assert.equal(input.sourceType, "email_attachment");
  assert.equal(input.status, "captured");
  assert.equal(input.capturedBy, "v@x.com");
});

test("buildPromoteReceiptInput: omits paymentPath/expenseType so UNKNOWN defaults apply", () => {
  const input = buildPromoteReceiptInput(intakeRow());
  assert.ok(!("paymentPath" in input && input.paymentPath !== undefined), "no explicit paymentPath");
  assert.ok(!("expenseType" in input && input.expenseType !== undefined), "no explicit expenseType");
});

test("buildPromoteReceiptInput: copies R2 metadata from the intake row", () => {
  const input = buildPromoteReceiptInput(
    intakeRow({
      attachment_r2_key: "k",
      attachment_sha256: "h",
      attachment_content_type: "application/pdf",
      attachment_size_bytes: 99,
      attachment_filename: "f.pdf",
    }),
  );
  assert.equal(input.originalR2Key, "k");
  assert.equal(input.originalSha256, "h");
  assert.equal(input.originalContentType, "application/pdf");
  assert.equal(input.originalSizeBytes, 99);
  assert.equal(input.originalFilename, "f.pdf");
});

// ─── assertPromotable (pure half of promote) ────────────────────────────────

test("assertPromotable: refuses when attachment_r2_key is NULL", () => {
  assert.throws(() => assertPromotable(intakeRow({ attachment_r2_key: null })), /no promotable attachment/i);
});

test("assertPromotable: refuses when status is not pending_triage", () => {
  assert.throws(() => assertPromotable(intakeRow({ status: "promoted" })), /already promoted/i);
  assert.throws(() => assertPromotable(intakeRow({ status: "rejected" })), /already rejected/i);
});

test("assertPromotable: passes for a pending row with an attachment", () => {
  assert.doesNotThrow(() => assertPromotable(intakeRow()));
});
