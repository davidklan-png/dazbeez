// Month-close workflow stage — the single server-derived answer to "where is
// this month in the export workflow?" (Backlog #24 / docs/export-workflow-ux-plan.md).
//
// The export page's `Pipeline` models Reconcile → Draft → Review → Finalize →
// Archived, which is wrong in three ways the design doc enumerates: Send is not a
// stage (delivery is bolted on as a banner); "Archived" goes green at finalize,
// so the pipeline reads fully complete the instant the month is sealed-but-
// undelivered (how 2026-06 sat unsent); and `stepIndex` has dead branches. This
// module is the derivation the pipeline SHOULD read from — one authority, many
// renderers, same pattern as delivery-status.ts and the ExportBlocker union.
//
// Scope of this file: the DERIVATION (pure core + async wrapper), unit-tested
// without D1. Mounting it on the three surfaces (export page, /review, /send)
// and replacing the `Pipeline` component is a follow-up — the derivation is the
// part worth getting right and reviewing carefully.

import {
  getFinalizedReconciliationForMonth,
  getExport,
  listDeliveriesForMonth,
} from "@/lib/receipts/db";
import {
  validateMonthReadyForExportDetailed,
  type ExportBlocker,
} from "@/lib/receipts/month-closing";
import {
  deriveMonthDeliveryState,
  DELIVERY_STATE,
  type AttemptState,
} from "@/lib/receipts/delivery-state";

/** The six stages of month-close, in order. Send is a stage (not a banner);
 *  Closed replaces "Archived" and reflects delivery, not the seal. */
export type MonthStageKey =
  | "reconcile"
  | "draft"
  | "review"
  | "finalize"
  | "send"
  | "closed";

/** A stage's display status. `blocked` is distinct from `pending`: a blocked
 *  stage is red, names the reason, and links to where the blocker is cleared. */
export type StageStatus = "done" | "current" | "pending" | "blocked";

/** The single primary action for a stage (only the active stage carries one). */
export interface MonthStageAction {
  label: string;
  kind: "primary" | "secondary";
}

/** One row of the derived pipeline. `href` is the stage's destination — done
 *  stages render it as a navigable link back; the active stage's `primaryAction`
 *  is the one button beneath the pipeline. `blockers` is present only on a
 *  blocked active stage. */
export interface MonthStage {
  key: MonthStageKey;
  label: string;
  status: StageStatus;
  /** In-app destination for this stage (Reconcile page, export page, review,
   *  send composer). Done stages are navigable; the active stage's href is the
   *  primary action target. */
  href: string;
  /** Present only on a blocked active stage — the gate blockers that gate it. */
  blockers?: ExportBlocker[];
  /** Present only on the active (current/blocked) stage. */
  primaryAction?: MonthStageAction;
}

/** Pure-core input — the resolved facts about a month. Each is derivable from
 *  existing state; the async wrapper fetches them so the core is unit-testable
 *  without D1 (same shape as ValidateMonthReadyInput /
 *  validateMonthReadyForExportCore). */
export interface MonthStageInput {
  month: string;
  /** Reconcile stage done: a finalized reconciliation exists for the month. */
  reconciled: boolean;
  /** Draft stage done: the bundle has been built (bundle_built_at set on the
   *  current revision — true for a built draft OR a finalized row, both carry
   *  the timestamp via recordExportBundle). */
  draftBuilt: boolean;
  /** Review stage blockers — the finalize-gate ExportBlockers on the current
   *  draft. Empty ⇒ review-clean. (A finalized month passes [] — it is review-
   *  complete by definition; the gate only has teeth on an open draft.) */
  reviewBlockers: ExportBlocker[];
  /** Finalize stage done: the current revision is sealed (status='finalized'). */
  finalized: boolean;
  /** Send / Closed done: the current (latest finalized) revision was delivered. */
  delivered: boolean;
}

/**
 * Pure synchronous core — derives the six-stage pipeline from resolved facts.
 * Unit-testable without D1.
 *
 * The active stage is the FIRST not-done stage (stages are monotonic in
 * practice: the finalize gate enforces reconcile → build → review → finalize →
 * send, so the facts never skip ahead). All stages before it are `done`; the
 * active stage itself is `blocked` if it carries blockers, else `current`; all
 * after are `pending`. A fully-delivered month has no active stage ⇒ all `done`
 * (Closed included).
 *
 * The honest-green guarantee (the point of #24): a finalized-but-undelivered
 * month derives Reconcile/Draft/Review/Finalize `done`, Send `current` — never a
 * fully-green pipeline. "Archived" no longer flips green at the seal.
 */
export function deriveMonthStageCore(input: MonthStageInput): MonthStage[] {
  const { month, reconciled, draftBuilt, reviewBlockers, finalized, delivered } = input;
  const reviewDone = reviewBlockers.length === 0;

  type Raw = {
    key: MonthStageKey;
    label: string;
    done: boolean;
    href: string;
    /** Label for the active stage's primary action (undefined ⇒ no action). */
    primaryLabel?: string;
    /** Blockers that make this stage 'blocked' when it is the active one. */
    blockers?: ExportBlocker[];
  };

  const reviewHref = `/receipts/export/${month}/review`;
  const raw: Raw[] = [
    {
      key: "reconcile",
      label: "Reconcile",
      done: reconciled,
      href: `/receipts/reconcile?month=${month}`,
      primaryLabel: reconciled ? undefined : "Reconcile を開く",
    },
    {
      key: "draft",
      label: "Draft",
      done: draftBuilt,
      href: `/receipts/export?month=${month}`,
      primaryLabel: draftBuilt ? undefined : "ドラフトを作成",
    },
    {
      key: "review",
      label: "Review",
      done: reviewDone,
      href: reviewHref,
      primaryLabel: reviewDone ? undefined : "確認して確定へ",
      blockers: reviewDone ? undefined : reviewBlockers,
    },
    {
      key: "finalize",
      label: "Finalize",
      done: finalized,
      href: reviewHref,
      primaryLabel: finalized ? undefined : "確定する",
    },
    {
      key: "send",
      label: "Send",
      done: delivered,
      href: `/receipts/export/${month}/send`,
      primaryLabel: delivered ? undefined : "送信する",
    },
    {
      key: "closed",
      label: "Closed",
      done: delivered,
      href: `/receipts/export?month=${month}`,
    },
  ];

  const activeIdx = raw.findIndex((r) => !r.done);

  return raw.map((r, i): MonthStage => {
    let status: StageStatus;
    let primaryAction: MonthStageAction | undefined;
    if (activeIdx === -1 || i < activeIdx) {
      status = "done";
    } else if (i === activeIdx) {
      const blocked = (r.blockers?.length ?? 0) > 0;
      status = blocked ? "blocked" : "current";
      if (r.primaryLabel) {
        primaryAction = { label: r.primaryLabel, kind: "primary" };
      }
    } else {
      status = "pending";
    }
    const stage: MonthStage = { key: r.key, label: r.label, status, href: r.href };
    if (r.blockers && r.blockers.length > 0) stage.blockers = r.blockers;
    if (primaryAction) stage.primaryAction = primaryAction;
    return stage;
  });
}

/**
 * Async wrapper — fetches the facts for a month and delegates to the pure core.
 * The one server-side call every surface reads (export page, /review, /send).
 *
 * - `reconciled`: a finalized reconciliation exists.
 * - `draftBuilt`: bundle_built_at on the current revision (built draft OR
 *   finalized — both carry it).
 * - `reviewBlockers`: the full finalize gate, but ONLY on an open draft. A
 *   finalized month is review-complete (blockers []) and skipping the gate
 *   avoids building the bundle for the common "is this month closed?" check.
 * - `finalized`: the current revision (latest) is sealed.
 * - `delivered`: derived from the current finalized revision's delivery rows
 *   (revision-scoped, same authority as the display helper) — a draft open above
 *   a finalized revision means the operator is revising, so it reads undelivered.
 */
export async function deriveMonthStage(month: string): Promise<MonthStage[]> {
  const reconciliation = await getFinalizedReconciliationForMonth(month);
  const reconciled = !!reconciliation;

  const exportRecord = await getExport(month); // latest revision (draft or finalized)
  const finalized = exportRecord?.status === "finalized";
  const draftBuilt = !!exportRecord?.bundle_built_at;

  // The gate only has teeth on an open draft. A finalized month passed review;
  // computing blockers there would both cost a bundle build and contradict the
  // seal. (message_stale / message_not_reviewed are draft-state blockers.)
  const reviewBlockers =
    !finalized && exportRecord?.status === "draft"
      ? await validateMonthReadyForExportDetailed(month)
      : [];

  let delivered = false;
  if (finalized && exportRecord) {
    const deliveries = (await listDeliveriesForMonth(month))
      .filter((d) => d.export_id === exportRecord.id)
      .map((d) => ({
        attemptId: d.attempt_id,
        // The DB column allows 'ambiguous' at runtime; cast through the authority.
        state: (d.state as AttemptState) ?? "pending",
        createdAt: d.created_at,
      }));
    delivered = deriveMonthDeliveryState(deliveries) === DELIVERY_STATE.DELIVERED;
  }

  return deriveMonthStageCore({
    month,
    reconciled,
    draftBuilt,
    reviewBlockers,
    finalized,
    delivered,
  });
}
