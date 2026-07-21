import test from "node:test";
import assert from "node:assert/strict";
import { applyDuplicateMerge, MergeError } from "@/lib/receipts/duplicate-merge";
import type { ReceiptAttendee, ReceiptRecord } from "@/lib/receipts/types";

function receipt(id: string, over: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    id, captured_at: "2026-05-03T00:00:00Z", captured_by: "test", source: "mobile_capture",
    original_filename: "r.jpg", payment_path: "AMEX", expense_type: "UNKNOWN",
    transaction_date: "2026-05-03", merchant: "THE MIURA ROOFTOP TERRACE",
    amount_minor: 7362, currency: "JPY", tax_amount_minor: null, business_purpose: null,
    alcohol_present: 0, attendees_required: 0, status: "reviewed",
    original_r2_key: `${id}.jpg`, original_sha256: id, original_content_type: "image/jpeg",
    original_size_bytes: 10, processed_r2_key: null, extraction_json: null, legacy: 0,
    exported_month: null, expense_category_code: null, deleted_at: null, deleted_by: null,
    delete_reason: null, updated_at: `${id}-v1`, tax_rate: null,
    invoice_registration_number: null, invoice_registration_status: null,
    qualified_invoice_status: "not_checked", counterparty_name: null,
    extraction_state: "completed", ...over,
  } as ReceiptRecord;
}

function attendee(receiptId: string, name: string, over: Partial<ReceiptAttendee> = {}): ReceiptAttendee {
  return {
    id: `${receiptId}-${name}`, receipt_id: receiptId, attendee_name: name,
    company: null, relationship: null, is_dazbeez_employee: 0, notes: null,
    created_at: "2026-07-01T00:00:00Z", ...over,
  };
}

interface Fixture {
  receipts: Record<string, ReceiptRecord>;
  attendees: Record<string, ReceiptAttendee[]>;
  batchError?: Error;
}

function makeDb(fixture: Fixture) {
  const batches: Array<Array<{ sql: string; binds: unknown[] }>> = [];
  function response(sql: string, binds: unknown[]) {
    const compact = sql.replace(/\s+/g, " ").trim();
    const id = String(binds[0] ?? "");
    if (compact.includes("FROM receipt_records WHERE id = ?") || compact.includes("FROM receipt_records WHERE id=?")) {
      const row = fixture.receipts[id];
      return { first: row ?? null, results: row ? [row] : [] };
    }
    if (compact.includes("FROM amex_statement_lines WHERE matched_receipt_id = ?")) {
      return compact.includes("COUNT(*)")
        ? { first: { n: 0 }, results: [] }
        : { first: null, results: [] };
    }
    if (compact.includes("FROM receipt_export_items WHERE item_type='receipt'")) return { first: { n: 0 }, results: [] };
    if (compact.includes("DISTINCT e.export_month")) return { first: null, results: [] };
    if (compact.includes("DISTINCT business_trip_report_id")) return { first: null, results: [] };
    if (compact.includes("FROM email_receipt_intake")) return { first: null, results: [] };
    if (compact.includes("FROM receipt_attendees WHERE receipt_id = ?")) {
      return { first: null, results: fixture.attendees[id] ?? [] };
    }
    if (compact.includes("role='proof_copy'")) return { first: null, results: [] };
    if (compact.includes("SELECT export_month AS month")) return { first: null, results: [] };
    if (compact.includes("FROM receipt_files")) return { first: null, results: [] };
    if (compact.includes("FROM receipt_settings")) return { first: null, results: [] };
    if (compact.includes("FROM receipt_compliance_checks")) return { first: null, results: [] };
    return { first: null, results: [] };
  }
  function prepare(sql: string): D1PreparedStatement {
    let binds: unknown[] = [];
    const statement = {
      _sql: sql,
      _binds: binds,
      bind(...values: unknown[]) { binds = values; this._binds = values; return this; },
      async first<T>() { return response(sql, binds).first as T | null; },
      async all<T>() { return { results: response(sql, binds).results as T[], success: true, meta: { changes: 0 } }; },
      async run() { return { success: true, meta: { changes: 1 } }; },
    };
    return statement as unknown as D1PreparedStatement;
  }
  return {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      batches.push(statements.map((statement) => ({
        sql: (statement as unknown as { _sql: string })._sql,
        binds: (statement as unknown as { _binds: unknown[] })._binds,
      })));
      if (fixture.batchError) throw fixture.batchError;
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
    batches,
  };
}

function fixture(): Fixture {
  return {
    receipts: {
      retained: receipt("retained"),
      source: receipt("source", { tax_amount_minor: 829, tax_rate: "10.0" }),
    },
    attendees: { retained: [], source: [] },
  };
}

test("MIURA: tax amount and rate are merged in one guarded D1 batch", async () => {
  const data = fixture();
  const db = makeDb(data);
  const result = await applyDuplicateMerge({
    db: db as unknown as D1Database,
    retainedReceiptId: "retained",
    retainedExpectedUpdatedAt: "retained-v1",
    sources: [{ receiptId: "source", expectedUpdatedAt: "source-v1" }],
    resolutionPlan: [
      { field: "tax_amount", action: "copy_from_source", sourceReceiptIds: ["source"] },
      { field: "tax_rate", action: "copy_from_source", sourceReceiptIds: ["source"] },
    ],
    actor: "operator@example.com",
  });
  assert.deepEqual(result.updatedFields, ["tax_amount", "tax_rate"]);
  assert.equal(db.batches.length, 1);
  const batch = db.batches[0]!;
  assert.match(batch[0]!.sql, /INSERT INTO duplicate_merge_log/);
  const update = batch.find((statement) => statement.sql.includes("UPDATE receipt_records"))!;
  assert.match(update.sql, /tax_amount_minor=\?/);
  assert.match(update.sql, /tax_rate=\?/);
  assert.deepEqual(update.binds.slice(0, 2), [829, "10.0"]);
  assert.equal(batch.filter((statement) => statement.sql.includes("receipt_audit_log")).length, 2);
});

test("attendee copy appends only the missing person and preserves metadata", async () => {
  const data = fixture();
  data.receipts.retained.expense_category_code = "meeting";
  data.receipts.source.expense_category_code = "meeting";
  data.receipts.source.tax_amount_minor = null;
  data.receipts.source.tax_rate = null;
  data.attendees.retained = [attendee("retained", "Alice", { company: "Dazbeez" })];
  data.attendees.source = [attendee("source", "Bob", { company: "Client Co", relationship: "client", notes: "Host" })];
  const db = makeDb(data);
  const result = await applyDuplicateMerge({
    db: db as unknown as D1Database,
    retainedReceiptId: "retained",
    retainedExpectedUpdatedAt: "retained-v1",
    sources: [{ receiptId: "source", expectedUpdatedAt: "source-v1" }],
    resolutionPlan: [{ field: "attendees", action: "copy_from_source", sourceReceiptIds: ["source"] }],
    actor: "operator@example.com",
  });
  assert.equal(result.attendeeAdditions.length, 1);
  assert.equal(result.attendeeAdditions[0]!.attendeeName, "Bob");
  assert.equal(result.attendeeAdditions[0]!.company, "Client Co");
  const insert = db.batches[0]!.find((statement) => statement.sql.includes("INSERT INTO receipt_attendees"))!;
  assert.deepEqual(insert.binds.slice(2, 7), ["Bob", "Client Co", "client", 0, "Host"]);
  assert.equal(data.attendees.retained[0]!.company, "Dazbeez", "existing attendee is never deleted/recreated");
});

test("batch failure is reported as stale and never reported as applied", async () => {
  const data = fixture();
  data.batchError = new Error("duplicate-merge guard: source attendee set changed");
  const db = makeDb(data);
  await assert.rejects(
    applyDuplicateMerge({
      db: db as unknown as D1Database,
      retainedReceiptId: "retained",
      retainedExpectedUpdatedAt: "retained-v1",
      sources: [{ receiptId: "source", expectedUpdatedAt: "source-v1" }],
      resolutionPlan: [
        { field: "tax_amount", action: "copy_from_source", sourceReceiptIds: ["source"] },
        { field: "tax_rate", action: "copy_from_source", sourceReceiptIds: ["source"] },
      ],
      actor: "operator@example.com",
    }),
    (error: unknown) => error instanceof MergeError && error.code === "MERGE_STALE" && error.status === 409,
  );
});

test("manual tax amount rejects fractional values instead of rounding", async () => {
  const data = fixture();
  const db = makeDb(data);
  await assert.rejects(
    applyDuplicateMerge({
      db: db as unknown as D1Database,
      retainedReceiptId: "retained",
      retainedExpectedUpdatedAt: "retained-v1",
      sources: [{ receiptId: "source", expectedUpdatedAt: "source-v1" }],
      resolutionPlan: [{ field: "tax_amount", action: "manual_value", manualValue: 828.5 }],
      actor: "operator@example.com",
    }),
    /non-negative integer/i,
  );
  assert.equal(db.batches.length, 0);
});
