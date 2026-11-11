// Tests for the render-leg failure admission + deliberate recovery guards
// (lib/receipts/render-recovery.ts, backlog #22). The routes
// (/api/receipts/[id]/render-failed, /render-retry) are thin wrappers over
// these pure decisions; the guards are the part that must not drift:
//   - only render-pending receipts (needs_render=1) may be marked failed
//   - only the terminal render-failure state may be retried
//   - human-advanced rows (reviewed/reconciled/exported/archived — which is
//     what sealed/finalized months' rows always are) are refused on BOTH paths

import test from "node:test";
import assert from "node:assert/strict";
import {
  admitRenderFailure,
  admitRenderRetry,
} from "@/lib/receipts/render-recovery";
import type { ReceiptRecord } from "@/lib/receipts/types";

function receipt(partial: Partial<ReceiptRecord>): ReceiptRecord {
  return {
    id: "r1",
    status: "captured",
    needs_render: 1,
    extraction_state: "captured",
    ...partial,
  } as unknown as ReceiptRecord;
}

// ─── admitRenderFailure (consumer's terminal report) ────────────────────────

test("admitRenderFailure: render-pending captured receipt → ok", () => {
  const a = admitRenderFailure(
    receipt({ status: "captured", extraction_state: "captured" }),
  );
  assert.deepEqual(a, { ok: true });
});

test("admitRenderFailure: needs_review status still ok (pre-review)", () => {
  const a = admitRenderFailure(receipt({ status: "needs_review" }));
  assert.deepEqual(a, { ok: true });
});

test("admitRenderFailure: already-terminal row (idempotent re-report) → ok", () => {
  const a = admitRenderFailure(receipt({ extraction_state: "failed" }));
  assert.deepEqual(a, { ok: true });
});

test("admitRenderFailure: non-render receipt (needs_render=0) → 409, not awaiting render", () => {
  const a = admitRenderFailure(
    receipt({ needs_render: 0, extraction_state: "queued" }),
  );
  assert.equal(a.ok, false);
  if (!a.ok) {
    assert.equal(a.status, 409);
    assert.match(a.error, /not awaiting a render/);
    assert.match(a.error, /needs_render=0/);
  }
});

test("admitRenderFailure: human-advanced statuses refuse — sealed months are always past needs_review", () => {
  for (const status of ["reviewed", "categorized", "reconciled", "exported", "archived"]) {
    const a = admitRenderFailure(receipt({ status: status as ReceiptRecord["status"] }));
    assert.equal(a.ok, false, `${status} must be refused`);
    if (!a.ok) {
      assert.equal(a.status, 409);
      assert.match(a.error, new RegExp(`Receipt is ${status}`));
    }
  }
});

// ─── admitRenderRetry (operator's deliberate recovery) ──────────────────────

test("admitRenderRetry: terminal render failure → ok", () => {
  const a = admitRenderRetry(
    receipt({
      status: "captured",
      needs_render: 1,
      extraction_state: "failed",
    }),
  );
  assert.deepEqual(a, { ok: true });
});

test("admitRenderRetry: needs_review terminal row → ok (still pre-review)", () => {
  const a = admitRenderRetry(receipt({ status: "needs_review", extraction_state: "failed" }));
  assert.deepEqual(a, { ok: true });
});

test("admitRenderRetry: legacy stalled row (captured, never marked) → 409 — it already retries every cycle", () => {
  const a = admitRenderRetry(receipt({ extraction_state: "captured" }));
  assert.equal(a.ok, false);
  if (!a.ok) {
    assert.equal(a.status, 409);
    assert.match(a.error, /extraction_state='captured'/);
    assert.match(a.error, /retry automatically/);
  }
});

test("admitRenderRetry: non-render receipt → 409 (extraction failures are NOT retryable here)", () => {
  // An extraction-failed receipt (needs_render=0) must be refused: its retry
  // path would need to re-enqueue, which the /enqueue contract intentionally
  // does not admit. The dashboard surfaces the honest action instead.
  const a = admitRenderRetry(
    receipt({ needs_render: 0, extraction_state: "failed" }),
  );
  assert.equal(a.ok, false);
  if (!a.ok) {
    assert.equal(a.status, 409);
    assert.match(a.error, /needs_render=0/);
  }
});

test("admitRenderRetry: already-recovered row (captured) → 409", () => {
  const a = admitRenderRetry(receipt({ extraction_state: "captured" }));
  assert.equal(a.ok, false);
});

test("admitRenderRetry: human-advanced terminal row → 409 (no un-review)", () => {
  for (const status of ["reviewed", "reconciled", "exported", "archived"]) {
    const a = admitRenderRetry(
      receipt({ status: status as ReceiptRecord["status"], extraction_state: "failed" }),
    );
    assert.equal(a.ok, false, `${status} must be refused`);
    if (!a.ok) assert.equal(a.status, 409);
  }
});

test("admitRenderRetry: missing extraction_state reads as 'captured' (pre-0016 rows) → 409", () => {
  const a = admitRenderRetry(receipt({ extraction_state: undefined }));
  assert.equal(a.ok, false);
  if (!a.ok) assert.match(a.error, /extraction_state='captured'/);
});
