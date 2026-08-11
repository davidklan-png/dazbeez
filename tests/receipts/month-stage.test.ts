import test from "node:test";
import assert from "node:assert/strict";

// Backlog #24 — the month-close stage derivation (pure core). The honest-green
// guarantee is the point: a finalized-but-undelivered month must derive Send as
// `current`, NEVER a fully-green pipeline (how 2026-06 sat unsent). Stages are
// monotonic — the active stage is the first not-done one; everything after is
// `pending` even if its raw flag is true (defensive against impossible states).

import { deriveMonthStageCore as derive, type MonthStageInput as Input } from "@/lib/receipts/month-stage";
import type { ExportBlocker } from "@/lib/receipts/month-closing";

const MONTH = "2026-06";
const reviewHref = `/receipts/export/${MONTH}/review`;

function blocker(code: ExportBlocker["code"] = "receipt_unreviewed"): ExportBlocker {
  return { code, message: `blocker ${code}` };
}

function input(over: Partial<Input> = {}): Input {
  return {
    month: MONTH,
    reconciled: false,
    draftBuilt: false,
    reviewBlockers: [],
    finalized: false,
    delivered: false,
    ...over,
  };
}

function byKey(stages: ReturnType<typeof derive>) {
  return Object.fromEntries(stages.map((s) => [s.key, s])) as Record<
    ReturnType<typeof derive>[number]["key"],
    (typeof stages)[number]
  >;
}

test("nothing done ⇒ Reconcile is current (the entry stage), rest pending", () => {
  const s = byKey(derive(input()));
  assert.equal(s.reconcile.status, "current");
  assert.equal(s.draft.status, "pending");
  assert.equal(s.review.status, "pending");
  assert.equal(s.finalize.status, "pending");
  assert.equal(s.send.status, "pending");
  assert.equal(s.closed.status, "pending");
});

test("reconciled only ⇒ Draft current; Reconcile done", () => {
  const s = byKey(derive(input({ reconciled: true })));
  assert.equal(s.reconcile.status, "done");
  assert.equal(s.draft.status, "current");
  assert.equal(s.review.status, "pending");
});

test("reconciled + draft built, no blockers ⇒ Review is DONE (a clean gate), Finalize current", () => {
  // Review is a gate: done when blockers empty, blocked when present — never
  // 'current'. So a built draft with a clean gate advances to Finalize.
  const s = byKey(derive(input({ reconciled: true, draftBuilt: true })));
  assert.equal(s.reconcile.status, "done");
  assert.equal(s.draft.status, "done");
  assert.equal(s.review.status, "done", "no blockers ⇒ review-clean ⇒ done, never 'current'");
  assert.equal(s.finalize.status, "current");
});

test("Review with gate blockers ⇒ Review BLOCKED, carries the blockers", () => {
  const bs = [blocker("receipt_unreviewed"), blocker("attendees_required")];
  const s = byKey(derive(input({ reconciled: true, draftBuilt: true, reviewBlockers: bs })));
  assert.equal(s.review.status, "blocked");
  assert.deepEqual(s.review.blockers, bs);
  assert.equal(s.finalize.status, "pending", "a blocked Review must not let Finalize read done/pending-green");
});

test("review clean, not finalized ⇒ Finalize current (the action is 確定する)", () => {
  const s = byKey(derive(input({ reconciled: true, draftBuilt: true })));
  // reviewBlockers empty ⇒ review done ⇒ finalize is the active stage
  assert.equal(s.review.status, "done");
  assert.equal(s.finalize.status, "current");
  assert.equal(s.finalize.primaryAction?.label, "確定する");
});

// THE point of #24 — the honest-green guarantee.
test("finalized but NOT delivered ⇒ Send current, pipeline NOT all green (the 2026-06 case)", () => {
  const s = byKey(derive(input({ reconciled: true, draftBuilt: true, finalized: true, delivered: false })));
  assert.equal(s.reconcile.status, "done");
  assert.equal(s.draft.status, "done");
  assert.equal(s.review.status, "done");
  assert.equal(s.finalize.status, "done");
  assert.equal(s.send.status, "current", "sealed-undelivered must read Send=current, never green");
  assert.equal(s.closed.status, "pending");
  assert.equal(s.send.primaryAction?.label, "送信する");
});

test("delivered ⇒ every stage done (Closed included); no active stage / no primary action", () => {
  const stages = derive(input({ reconciled: true, draftBuilt: true, finalized: true, delivered: true }));
  for (const s of stages) {
    assert.equal(s.status, "done", `${s.key} should be done for a delivered month`);
    assert.equal(s.primaryAction, undefined, `no primary action on a closed month (${s.key})`);
  }
});

test("primary action appears ONLY on the active stage", () => {
  const stages = derive(input({ reconciled: true, draftBuilt: true, finalized: false }));
  const withAction = stages.filter((s) => s.primaryAction !== undefined);
  assert.equal(withAction.length, 1, "exactly one primary action");
  assert.equal(withAction[0].status, "current", "the action is on the current stage");
});

test("each stage carries its destination href (done stages are navigable)", () => {
  const stages = derive(input({ reconciled: true, draftBuilt: true, finalized: true, delivered: true }));
  const hrefs = Object.fromEntries(stages.map((s) => [s.key, s.href]));
  assert.equal(hrefs.reconcile, `/receipts/reconcile?month=${MONTH}`);
  assert.equal(hrefs.draft, `/receipts/export?month=${MONTH}`);
  assert.equal(hrefs.review, reviewHref);
  assert.equal(hrefs.finalize, reviewHref);
  assert.equal(hrefs.send, `/receipts/export/${MONTH}/send`);
  assert.equal(hrefs.closed, `/receipts/export?month=${MONTH}`);
});

test("monotonicity: a stage after a not-done one is `pending` even if its flag is true (defensive)", () => {
  // Impossible in practice (can't finalize without building) but the derivation
  // must never show a green stage after a not-done one — that would mislead.
  const s = byKey(derive(input({ reconciled: false, draftBuilt: false, finalized: true, delivered: true })));
  assert.equal(s.reconcile.status, "current", "first not-done is the active stage");
  assert.equal(s.draft.status, "pending");
  assert.equal(s.finalize.status, "pending", "finalized flag is ignored — stage stays pending past the active one");
  assert.equal(s.closed.status, "pending");
});
