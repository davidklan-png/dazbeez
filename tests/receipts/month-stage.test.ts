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

test("reconciled only (no draft, no blockers) ⇒ Finalize reachable WITHOUT a draft; Draft is OPTIONAL, not a prerequisite", () => {
  // Architect ruling on the one-shot finalize: building a draft is a preview
  // affordance, not a gate. The one-shot path builds + seals in one request, so
  // a month with reconciliation done and a clean gate must reach Finalize even
  // when no draft has ever been built. Draft reads `pending` (available, not
  // required) — never `current`/`blocked` — and carries a preview side-action.
  const s = byKey(derive(input({ reconciled: true })));
  assert.equal(s.reconcile.status, "done");
  assert.equal(s.draft.status, "pending", "an unbuilt draft is optional — it must NOT gate Review/Finalize");
  assert.equal(s.review.status, "done", "no blockers ⇒ review-clean ⇒ done");
  assert.equal(s.finalize.status, "current", "Finalize is reachable without building a draft first");
  assert.equal(s.finalize.primaryAction?.label, "確定する");
  assert.ok(s.draft.secondaryAction, "Draft carries a preview side-action even though it is not the active stage");
  assert.equal(s.draft.secondaryAction?.kind, "secondary");
});

// ─── Optional Draft (architect ruling): Draft is a preview, not a gate ────────

test("optional Draft: no draft + Review blockers ⇒ Review is the active BLOCKED stage (Draft does not gate it)", () => {
  // The load-bearing change. Previously an unbuilt draft made Draft the active
  // stage, blocking Review. Now Review is reachable (and blockable) directly —
  // the operator clears review blockers without first building a draft.
  const s = byKey(
    derive(input({ reconciled: true, draftBuilt: false, reviewBlockers: [blocker("receipt_unreviewed")] })),
  );
  assert.equal(s.draft.status, "pending", "Draft optional + unbuilt ⇒ pending, never the active stage");
  assert.equal(s.draft.secondaryAction?.label, "ドラフトを作成", "preview side-action still offered");
  assert.equal(s.review.status, "blocked", "Review is the active blocked stage even with no draft built");
  assert.equal(s.finalize.status, "pending");
});

test("optional Draft: built ⇒ done; message_stale is an ADVISORY (preview freshness), never a blocker", () => {
  const fresh = byKey(derive(input({ reconciled: true, draftBuilt: true })));
  assert.equal(fresh.draft.status, "done", "built & fresh ⇒ done");
  assert.equal(fresh.draft.advisories, undefined, "no advisory when fresh");
  assert.equal(
    fresh.draft.secondaryAction?.label,
    "ドラフトを再作成",
    "a built draft still offers rebuild-to-preview as a side-action",
  );
  // Fix (a): the one-shot finalize path rebuilds in-request, so message_stale no
  // longer gates anything. A built-but-stale draft is still `done`; staleness
  // surfaces as a Draft advisory (rebuild refreshes the preview), never a block.
  const stale = byKey(
    derive(input({ reconciled: true, draftBuilt: true, reviewBlockers: [blocker("message_stale")] })),
  );
  assert.notEqual(stale.draft.status, "blocked", "message_stale never blocks Draft");
  assert.equal(stale.draft.status, "done", "a stale draft is still built ⇒ done");
  assert.ok(
    stale.draft.advisories?.some((b) => b.code === "message_stale"),
    "the stale preview surfaces as a Draft advisory",
  );
  assert.equal(stale.draft.blockers, undefined, "message_stale is NOT a blocker on Draft");
});

test("optional Draft: a finalized month offers no Draft preview side-action (the pack is sealed)", () => {
  // Once sealed, "preview before sealing" is meaningless. Draft carries no
  // secondaryAction on a finalized month (delivered or not).
  const sealedUndelivered = byKey(
    derive(input({ reconciled: true, draftBuilt: true, finalized: true, delivered: false })),
  );
  assert.equal(sealedUndelivered.draft.secondaryAction, undefined);
  const closed = byKey(
    derive(input({ reconciled: true, draftBuilt: true, finalized: true, delivered: true })),
  );
  assert.equal(closed.draft.secondaryAction, undefined);
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

// ─── §2 blocker placement: a blocker sits on the stage whose ACTION clears it ──

test("§2: message_stale is a Draft ADVISORY (rebuild refreshes the preview), never a blocker — it never gates Review/Finalize", () => {
  // Fix (a): the one-shot finalize path rebuilds in-request, so a stale preview
  // no longer gates anything. Draft surfaces message_stale as an advisory; it
  // never reads `blocked`, and Review/Finalize proceed normally.
  const s = byKey(
    derive(input({ reconciled: true, draftBuilt: true, reviewBlockers: [blocker("message_stale")] })),
  );
  assert.notEqual(s.draft.status, "blocked", "message_stale never blocks Draft");
  assert.ok(
    s.draft.advisories?.some((b) => b.code === "message_stale"),
    "Draft carries the message_stale advisory",
  );
  assert.equal(s.draft.blockers, undefined, "message_stale is not a blocker on Draft");
  assert.equal(s.review.status, "done", "Review is NOT held behind a stale Draft");
  assert.equal(s.review.blockers, undefined, "message_stale does NOT leak onto Review");
  assert.equal(s.draft.primaryAction, undefined, "Draft never carries a primary action — it never gates");
});

test("§2: reconciliation_not_finalized blocks RECONCILE (cleared by reconciliation signoff)", () => {
  const s = byKey(
    derive(input({ reconciled: false, draftBuilt: false, reviewBlockers: [blocker("reconciliation_not_finalized")] })),
  );
  assert.equal(s.reconcile.status, "blocked");
  assert.ok(s.reconcile.blockers?.some((b) => b.code === "reconciliation_not_finalized"));
});

test("§2: message_not_reviewed blocks REVIEW (cleared by the preface decision)", () => {
  const s = byKey(
    derive(input({ reconciled: true, draftBuilt: true, reviewBlockers: [blocker("message_not_reviewed")] })),
  );
  assert.equal(s.review.status, "blocked");
  assert.ok(s.review.blockers?.some((b) => b.code === "message_not_reviewed"));
});

test("§2: message_stale + a Review-stage blocker ⇒ Review is the active blocked stage; Draft carries the advisory, not a block", () => {
  // message_stale no longer gates Draft, so a Review-stage blocker makes Review
  // the active blocked stage. Draft still surfaces the stale-preview advisory but
  // does not block — Review is where the operator acts.
  const s = byKey(
    derive(
      input({
        reconciled: true,
        draftBuilt: true,
        reviewBlockers: [blocker("message_stale"), blocker("receipt_unreviewed")],
      }),
    ),
  );
  assert.notEqual(s.draft.status, "blocked", "Draft is not blocked by message_stale");
  assert.ok(
    s.draft.advisories?.some((b) => b.code === "message_stale"),
    "Draft carries the advisory",
  );
  assert.equal(s.review.status, "blocked", "Review is the active blocked stage");
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
