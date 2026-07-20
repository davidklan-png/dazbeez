import test from "node:test";
import assert from "node:assert/strict";
import { unfinalizeReconciliation } from "@/lib/receipts/db";

// ─── Recording fake D1 ───────────────────────────────────────────────────────
//
// unfinalizeReconciliation issues three statements against the binding:
//   1. SELECT id FROM amex_reconciliations WHERE statement_month=? AND status='finalized'
//   2. UPDATE amex_reconciliations SET status='draft', finalized_by=NULL, finalized_at=NULL WHERE id=?
//   3. INSERT INTO receipt_audit_log ... (via createAuditEntry)
//
// This codebase unit-tests db functions by injecting a fake D1 — see
// email-intake, crm-reply-monitor, and month-lock tests. unfinalizeReconciliation
// takes `db` as an optional 4th param purely as this testability seam (production
// callers omit it; the default resolves the live binding). Live-D1 mutation
// semantics are additionally exercised when the operator unfinalizes 2026-06.

type RunCall = { sql: string; args: unknown[] };

function createRecordingDb(finalizedRow: { id: string } | null) {
  const runs: RunCall[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T = unknown>(): Promise<T | null> {
              // Only the finalized-row SELECT reads via .first(); the UPDATE and
              // the audit INSERT use .run(). The SELECT is identified by its
              // status='finalized' predicate (the UPDATE sets status='draft').
              const isFinalizedSelect =
                /FROM amex_reconciliations/i.test(sql) &&
                /status = 'finalized'/i.test(sql);
              return (isFinalizedSelect ? finalizedRow : null) as T | null;
            },
            async run(): Promise<{ meta: { changes: number } }> {
              runs.push({ sql, args });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, runs };
}

// ─── Happy path ──────────────────────────────────────────────────────────────

test("unfinalizeReconciliation: finalized row → status 'draft', finalized_by/at NULL, audit 'amended'", async () => {
  const { db, runs } = createRecordingDb({ id: "rec-2026-06" });

  await unfinalizeReconciliation(
    "2026-06",
    "david@example.com",
    "beta review — receipt corrections before accountant delivery",
    db,
  );

  // UPDATE targets the right row and clears the finalize fields.
  const update = runs.find((r) => /UPDATE amex_reconciliations/i.test(r.sql));
  assert.ok(update, "expected an UPDATE against amex_reconciliations");
  assert.equal(update!.args[0], "rec-2026-06");
  assert.match(update!.sql, /status = 'draft'/i);
  assert.match(update!.sql, /finalized_by = NULL/i);
  assert.match(update!.sql, /finalized_at = NULL/i);
  assert.match(update!.sql, /WHERE id = \?/i);

  // Audit INSERT carries the pre-declared amended action + reconciliation ref.
  const audit = runs.find((r) => /INSERT INTO receipt_audit_log/i.test(r.sql));
  assert.ok(audit, "expected an audit INSERT");
  // bind order: id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at
  assert.equal(audit!.args[1], "david@example.com");
  assert.equal(audit!.args[2], "amex.reconciliation_amended");
  assert.equal(audit!.args[3], "amex_reconciliation");
  assert.equal(audit!.args[4], "rec-2026-06");
  assert.deepEqual(JSON.parse(String(audit!.args[6])), {
    reason: "beta review — receipt corrections before accountant delivery",
    statementMonth: "2026-06",
    unfinalized: true,
  });
});

// ─── Throw path: nothing to unfinalize ───────────────────────────────────────

test("unfinalizeReconciliation: no finalized row → throws, writes nothing", async () => {
  const { db, runs } = createRecordingDb(null);

  await assert.rejects(
    unfinalizeReconciliation("2026-06", "david@example.com", "noop", db),
    /No finalized reconciliation found for 2026-06/,
  );
  assert.equal(
    runs.length,
    0,
    "no UPDATE or audit INSERT should fire when no finalized row exists",
  );
});
