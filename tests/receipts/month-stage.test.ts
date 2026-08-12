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

test("optional Draft: built & fresh ⇒ done; message_stale still blocks it (the one exception)", () => {
  const fresh = byKey(derive(input({ reconciled: true, draftBuilt: true })));
  assert.equal(fresh.draft.status, "done", "built & fresh ⇒ done");
  assert.equal(
    fresh.draft.secondaryAction?.label,
    "ドラフトを再作成",
    "a built draft still offers rebuild-to-preview as a side-action",
  );
  // message_stale is the one case where Draft genuinely gates: the action that
  // clears it (Rebuild) IS a Draft control, so a stale message blocks Draft.
  const stale = byKey(
    derive(input({ reconciled: true, draftBuilt: true, reviewBlockers: [blocker("message_stale")] })),
  );
  assert.equal(stale.draft.status, "blocked", "message_stale blocks Draft (the exception)");
  assert.equal(stale.review.status, "pending", "Review waits behind the stale Draft");
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

test("§2: message_stale blocks DRAFT (Rebuild draft), NOT Review/Finalize — the 2026-06 trap fixed", () => {
  // The remedy for a stale message is Rebuild draft, a Draft-stage control on
  // the export page. Placing it on Review/Finalize would put the blocker on a
  // different page from the button that clears it. Here Draft is built but
  // stale ⇒ Draft is the blocked active stage; Review reads pending (not done),
  // never blocked.
  const s = byKey(
    derive(input({ reconciled: true, draftBuilt: true, reviewBlockers: [blocker("message_stale")] })),
  );
  assert.equal(s.draft.status, "blocked", "message_stale blocks Draft");
  assert.ok(
    s.draft.blockers?.some((b) => b.code === "message_stale"),
    "Draft carries the message_stale blocker",
  );
  assert.equal(s.review.status, "pending", "Review is pending behind the blocked Draft, not blocked itself");
  assert.equal(s.review.blockers, undefined, "message_stale does NOT leak onto Review");
  assert.equal(s.draft.primaryAction?.label, "ドラフトを再作成", "primary action is rebuild, not create");
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

test("§2: message_stale + a Review-stage blocker together ⇒ Draft blocked (Draft is earlier); Review pending", () => {
  // The active stage is the FIRST not-done. Draft (stale) comes before Review,
  // so Draft is the blocked active stage even when Review also has a blocker;
  // Review reads pending until the draft is rebuilt.
  const s = byKey(
    derive(
      input({
        reconciled: true,
        draftBuilt: true,
        reviewBlockers: [blocker("message_stale"), blocker("receipt_unreviewed")],
      }),
    ),
  );
  assert.equal(s.draft.status, "blocked");
  assert.equal(s.review.status, "pending");
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
