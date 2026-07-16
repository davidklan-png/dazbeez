import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPendingProcessingQuery,
  buildReconcileExtractionStateQuery,
} from "@/lib/receipts/extraction-queue-db";
import { PENDING_EXTRACTION_STATES } from "@/lib/receipts/types";

// Pending states as a plain array for comparison (the source is readonly).
const STATES = [...PENDING_EXTRACTION_STATES];

/** Count of "?" inside the single `IN (...)` clause of a SQL string. */
function inClausePlaceholderCount(sql: string): number {
  const match = sql.match(/IN \(([^)]*)\)/);
  assert.ok(match, "expected an IN (...) clause in the SQL");
  return (match[1]!.match(/\?/g) ?? []).length;
}

// ─── list query ─────────────────────────────────────────────────────────────

test("buildPendingProcessingQuery: one IN placeholder per pending state", () => {
  const { sql } = buildPendingProcessingQuery();
  assert.equal(inClausePlaceholderCount(sql), STATES.length);
});

test("buildPendingProcessingQuery: placeholders, not embedded state literals; states carried as bindings", () => {
  const { sql, bindings } = buildPendingProcessingQuery();
  for (const state of STATES) {
    assert.ok(
      !sql.includes(`'${state}'`),
      `SQL must not embed literal '${state}'`,
    );
  }
  assert.deepEqual(bindings.slice(0, STATES.length), STATES);
});

test("buildPendingProcessingQuery: bindings order = states..., custom limit", () => {
  const { bindings } = buildPendingProcessingQuery(50);
  assert.deepEqual([...bindings], [...STATES, 50]);
});

test("buildPendingProcessingQuery: defaults to limit 1000", () => {
  const { bindings } = buildPendingProcessingQuery();
  assert.equal(bindings[bindings.length - 1], 1000);
});

test("buildPendingProcessingQuery: SQL retains deleted-row filter, ordering, LIMIT", () => {
  const { sql } = buildPendingProcessingQuery();
  assert.match(sql, /deleted_at IS NULL/);
  assert.match(sql, /ORDER BY captured_at DESC/);
  assert.match(sql, /LIMIT \?/);
});

// ─── reconcile update ───────────────────────────────────────────────────────

test("buildReconcileExtractionStateQuery: bindings order for terminal 'processed'", () => {
  const { bindings } = buildReconcileExtractionStateQuery(
    "rid-1",
    "processed",
    "NOW",
  );
  assert.deepEqual([...bindings], ["processed", "NOW", "NOW", "rid-1", ...STATES]);
});

test("buildReconcileExtractionStateQuery: bindings order for terminal 'failed'", () => {
  const { bindings } = buildReconcileExtractionStateQuery(
    "rid-2",
    "failed",
    "NOW",
  );
  assert.deepEqual([...bindings], ["failed", "NOW", "NOW", "rid-2", ...STATES]);
});

test("buildReconcileExtractionStateQuery: one IN placeholder per state, no embedded literals", () => {
  const { sql } = buildReconcileExtractionStateQuery("rid", "processed", "NOW");
  assert.equal(inClausePlaceholderCount(sql), STATES.length);
  for (const state of STATES) {
    assert.ok(
      !sql.includes(`'${state}'`),
      `SQL must not embed literal '${state}'`,
    );
  }
});

test("buildReconcileExtractionStateQuery: SQL retains SET columns, id condition, pending guard", () => {
  const { sql } = buildReconcileExtractionStateQuery("rid", "processed", "NOW");
  assert.match(
    sql,
    /SET extraction_state = \?, extraction_processed_at = \?, updated_at = \?/,
  );
  assert.match(sql, /WHERE id = \?/);
  assert.match(sql, /AND extraction_state IN \(/);
});
