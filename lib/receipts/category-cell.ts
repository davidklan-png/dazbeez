// Pure, testable computation of the inline category cell's props for a
// review-page row: the WRITE ROUTE (which endpoint a category edit hits) and
// the LOCK STATE (whether editing is offered). Kept out of the React component
// so the routing/lock rules are unit-testable without rendering.
//
// See components/receipts/export/inline-category-cell.tsx for the UI and
// review-screen.tsx for the per-row call sites.

import type { ExportRow } from "@/lib/receipts/types";
import { findCategorySuggestion, type CategoryRule } from "@/lib/receipts/category-rules";

export type CategoryRoute =
  | { kind: "receipt"; id: string }
  | { kind: "line"; id: string };

export interface InlineCategoryCellProps {
  /** Resolved category code (resolveLineCategory for lines; the receipt's own
   *  code for cash/digital). Null = uncategorized. */
  code: string | null;
  /** JP/EN gloss of the resolved code, precomputed by the bundle. */
  categoryJa: string | null;
  categoryEn: string | null;
  /** Source-of-truth badge: "from receipt" (matched) vs "on line"
   *  (no-receipt / unmatched). Display only — the write route is separate. */
  sourceLabel: "from receipt" | "on line";
  /** Where a category edit is written. Null only when there is no writable
   *  target (rows reaching this cell always have one). */
  route: CategoryRoute | null;
  /** Whether the dropdown is offered. False under any lock. */
  editable: boolean;
  /** Why editing is disabled (rendered as a title tooltip), or null. */
  disabledReason: string | null;
  /** Whether the row's receipt has attendees recorded — drives the
   *  attendees-required inline warning (non-blocking; gate enforces). */
  hasAttendees: boolean;
  /** Category pattern rule suggestion (ADR: category-rules). Non-null ONLY for
   *  an unmatched, uncategorized line that matches an active rule — a VISIBLE
   *  Accept affordance, never a pre-selected dropdown. The cell's Accept calls
   *  the same PATCH path as a manual pick. */
  suggestedCategoryCode: string | null;
}

/**
 * Routing (source of truth):
 *   - matched AMEX line (receiptId set) → receipt PATCH — the receipt shadows
 *     the line, so writing a line category here would desync the manifest.
 *   - no-receipt / unmatched AMEX line (lineId, no receiptId) → line PATCH.
 *   - cash/digital receipt row → receipt PATCH.
 *
 * Locks (mirror the actual API guards exactly):
 *   - export finalized → all editing disabled (sealed; revision flow).
 *   - reconciliation finalized + export draft → AMEX-line rows disabled. The
 *     line PATCH 409s (rejectIfFinalized) AND a matched line's receipt PATCH
 *     409s (rejectIfReceiptInFinalizedReconciliation). Standalone CASH/DIGITAL
 *     receipts are matched to no AMEX line, so their receipt PATCH stays open —
 *     those rows remain editable. The asymmetry is intentional, mirrored here.
 */
export function buildCategoryCellProps(
  row: ExportRow,
  finalized: boolean,
  reconciliationSealed: boolean,
  rules: readonly CategoryRule[] = [],
): InlineCategoryCellProps {
  const hasReceipt = Boolean(row.receiptId);
  const sourceLabel: "from receipt" | "on line" = hasReceipt
    ? "from receipt"
    : "on line";
  const route: CategoryRoute | null = hasReceipt
    ? { kind: "receipt", id: row.receiptId! }
    : row.lineId
      ? { kind: "line", id: row.lineId }
      : null;

  let editable = !finalized;
  let disabledReason: string | null = null;
  if (finalized) {
    editable = false;
    disabledReason = "Export sealed — use the revision flow to amend (ADR 0009).";
  } else if (reconciliationSealed && row.rowType === "amex_line") {
    // Line PATCH 409s and a matched receipt PATCH 409s once the month's
    // reconciliation is sealed. Cash/digital receipts (no AMEX match) are
    // untouched by the reconciliation seal and stay editable.
    editable = false;
    disabledReason = "Reconciliation is sealed for this month — unseal to edit.";
  }

  // Category-rule suggestion: only for an UNMATCHED, UNCATEGORIZED line (a
  // matched line's category comes from the receipt — categorized via receipt
  // review, and a line PATCH would be shadowed by resolveLineCategory anyway).
  // Live-computed (ADR category-rules §3); the cell renders a visible Accept.
  const suggestion =
    !hasReceipt && !row.expenseCategoryCode && rules.length > 0
      ? findCategorySuggestion({ merchant: row.merchant ?? null, fromAddress: null }, rules)
      : null;

  return {
    code: row.expenseCategoryCode,
    categoryJa: row.expenseCategoryJa,
    categoryEn: row.expenseCategoryEn,
    sourceLabel,
    route,
    editable,
    disabledReason,
    hasAttendees: row.attendees.length > 0,
    suggestedCategoryCode: suggestion?.categoryCode ?? null,
  };
}

/**
 * The PATCH body this surface sends for a category edit. Intentionally a SINGLE
 * field — both /api/receipts/[id] and /api/receipts/amex/lines/[id] are sparse
 * (#67 contract: only keys present in the body are written), so sending just
 * expenseCategoryCode guarantees no sibling field (merchant, amount, attendees,
 * tax, …) is ever touched from this surface. Unit-tested to lock that.
 */
export function buildCategoryPatchBody(
  code: string,
): { expenseCategoryCode: string | null } {
  return { expenseCategoryCode: code || null };
}
