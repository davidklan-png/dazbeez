// Tests for recordBlockedIntake() row shape — verifies the minimal rejected
// row stores ONLY the required metadata and the audit is atomic with the row.
import test from "node:test";
import assert from "node:assert/strict";
import { recordBlockedIntake, BLOCKED_SUBJECT_MAX_CHARS } from "@/lib/receipts/email-intake";

// Structural fake D1 that captures the batch statements + binds for inspection.
function makeCaptureDb() {
  const batchCalls: { sql: string; binds: unknown[] }[] = [];
  return {
    prepare(sql: string) {
      const captured = sql;
      return {
        bind(...args: unknown[]) {
          return {
            run: () => ({ meta: { changes: 1 } }),
            first: () => null,
            all: () => ({ results: [] }),
            _sql: captured,
            _binds: args,
          };
        },
      };
    },
    batch(stmts: Array<{ _sql: string; _binds: unknown[]; run: () => unknown }>) {
      for (const stmt of stmts) {
        batchCalls.push({ sql: stmt._sql, binds: stmt._binds });
      }
      return stmts.map((s) => s.run());
    },
    _batchCalls: batchCalls,
  } as any;
}

function getRowBinds(db: any): unknown[] {
  const call = db._batchCalls.find((c: { sql: string }) => c.sql.includes("INSERT INTO email_receipt_intake"));
  return call?.binds ?? [];
}

function getAuditBinds(db: any): unknown[] {
  const call = db._batchCalls.find((c: { sql: string }) => c.sql.includes("INSERT INTO receipt_audit_log"));
  return call?.binds ?? [];
}

test("recordBlockedIntake: status is rejected", async () => {
  const db = makeCaptureDb();
  await recordBlockedIntake(db, {
    receivedAt: "2026-07-22T00:00:00Z", fromAddress: "spam@evil.com", toAddress: null,
    subject: "Test", spfPass: false, dkimPass: false, blockedSenderEmail: "spam@evil.com",
  });
  const rowSql = db._batchCalls[0].sql;
  assert.match(rowSql, /'rejected'/);
});

test("recordBlockedIntake: reason is blocked_sender", async () => {
  const db = makeCaptureDb();
  await recordBlockedIntake(db, {
    receivedAt: "2026-07-22T00:00:00Z", fromAddress: "spam@evil.com", toAddress: null,
    subject: "Test", spfPass: false, dkimPass: false, blockedSenderEmail: "spam@evil.com",
  });
  const rowSql = db._batchCalls[0].sql;
  assert.match(rowSql, /'blocked_sender'/);
});

test("recordBlockedIntake: normalized blocked_sender_email stored", async () => {
  const db = makeCaptureDb();
  await recordBlockedIntake(db, {
    receivedAt: "2026-07-22T00:00:00Z", fromAddress: "visible@harmless.com", toAddress: null,
    subject: "Test", spfPass: true, dkimPass: true, blockedSenderEmail: "  Spam@Evil.COM  ",
  });
  const binds = getRowBinds(db);
  // Last bind is the blocked_sender_email (normalized)
  assert.equal(binds[binds.length - 1], "spam@evil.com");
});

test("recordBlockedIntake: subject bounded to BLOCKED_SUBJECT_MAX_CHARS", async () => {
  const db = makeCaptureDb();
  const longSubject = "A".repeat(BLOCKED_SUBJECT_MAX_CHARS + 100);
  await recordBlockedIntake(db, {
    receivedAt: "2026-07-22T00:00:00Z", fromAddress: "spam@evil.com", toAddress: null,
    subject: longSubject, spfPass: false, dkimPass: false, blockedSenderEmail: "spam@evil.com",
  });
  const binds = getRowBinds(db);
  const subject = binds[3] as string;
  assert.equal(subject.length, BLOCKED_SUBJECT_MAX_CHARS);
});

test("recordBlockedIntake: raw headers NULL (SQL has NULL literal)", async () => {
  const db = makeCaptureDb();
  await recordBlockedIntake(db, {
    receivedAt: "2026-07-22T00:00:00Z", fromAddress: "spam@evil.com", toAddress: null,
    subject: null, spfPass: false, dkimPass: false, blockedSenderEmail: "spam@evil.com",
  });
  const rowSql = db._batchCalls[0].sql;
  // raw_headers_json is column 15 in the INSERT — should be NULL literal
  assert.match(rowSql, /NULL, NULL, \?, \?, NULL, NULL, 0, \?/);
});

test("recordBlockedIntake: body + attachment fields NULL (SQL literals)", async () => {
  const db = makeCaptureDb();
  await recordBlockedIntake(db, {
    receivedAt: "2026-07-22T00:00:00Z", fromAddress: "spam@evil.com", toAddress: null,
    subject: null, spfPass: false, dkimPass: false, blockedSenderEmail: "spam@evil.com",
  });
  const rowSql = db._batchCalls[0].sql.toUpperCase();
  // attachment fields are NULLs, body fields are NULL, body_truncated is 0
  assert.match(rowSql, /NULL, NULL, NULL, NULL, NULL/);
  assert.match(rowSql, /NULL, NULL, 0/);
});

test("recordBlockedIntake: audit contains blocked_sender_email", async () => {
  const db = makeCaptureDb();
  await recordBlockedIntake(db, {
    receivedAt: "2026-07-22T00:00:00Z", fromAddress: "visible@harmless.com", toAddress: null,
    subject: "Test", spfPass: false, dkimPass: false, blockedSenderEmail: "env@evil.com",
  });
  const auditBinds = getAuditBinds(db);
  // The audit INSERT binds are [auditId, id, auditJson, now]
  // new_value_json is the 3rd bind (index 2)
  const auditJson = auditBinds[2] as string;
  assert.match(auditJson, /blocked_sender_email/);
  assert.match(auditJson, /env@evil\.com/);
});

test("recordBlockedIntake: malformed blockedSenderEmail rejected", async () => {
  const db = makeCaptureDb();
  await assert.rejects(
    () => recordBlockedIntake(db, {
      receivedAt: "2026-07-22T00:00:00Z", fromAddress: "spam@evil.com", toAddress: null,
      subject: "Test", spfPass: false, dkimPass: false, blockedSenderEmail: "",
    }),
    /valid normalized blockedSenderEmail/,
  );
  await assert.rejects(
    () => recordBlockedIntake(db, {
      receivedAt: "2026-07-22T00:00:00Z", fromAddress: "spam@evil.com", toAddress: null,
      subject: "Test", spfPass: false, dkimPass: false, blockedSenderEmail: "not-email",
    }),
    /valid normalized blockedSenderEmail/,
  );
});

test("recordBlockedIntake: row + audit in ONE batch (atomic)", async () => {
  const db = makeCaptureDb();
  await recordBlockedIntake(db, {
    receivedAt: "2026-07-22T00:00:00Z", fromAddress: "spam@evil.com", toAddress: null,
    subject: "Test", spfPass: false, dkimPass: false, blockedSenderEmail: "spam@evil.com",
  });
  // Exactly 2 statements in the batch: the row INSERT + the audit INSERT
  assert.equal(db._batchCalls.length, 2);
  assert.ok(db._batchCalls[0].sql.includes("INSERT INTO email_receipt_intake"));
  assert.ok(db._batchCalls[1].sql.includes("INSERT INTO receipt_audit_log"));
});
