// Blocker / warning summarisation for the monthly export flow.
// Hoisted out of app/(receipt-system)/receipts/export/page.tsx so the same
// rules can power the dashboard "Export status" tile and the reconcile
// screen's "Ready to seal?" summary without forking the logic.
//
// PRESENTATION ONLY. These tiles describe why a month isn't ready so the
// operator knows what to fix; they are not the API gate. The single
// enforcement authority is validateMonthReadyForExport() in
// lib/receipts/month-closing.ts — every finalize path (POST
// /api/receipts/export/month, POST /api/receipts/export/[month]) routes
// through it. If you add a new rule, add it THERE, not here.

import { requiresAttendees } from "@/lib/receipts/categories";
import { isPendingProcessing } from "@/lib/receipts/extraction-state";
import { resolveLineCategory } from "@/lib/receipts/line-classification";
import { canonicalizeMerchant, detectMerchantChain } from "@/lib/receipts/merchant";
import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";

// ─── Shared predicates (tile ⇄ gate) ─────────────────────────────────────
// Pure rules shared between the export tile (computeExportBlockers) and the
// finalize gate (validateMonthReadyForExportCore + validateAmexLinesForSignoff)
// so a rule can never exist in one and not the other. The gate is the
// authority; the tile mirrors these exactly. Add a rule here AND wire it into
// the gate if it should block finalize.

/** A line is uncategorized when neither it nor its matched receipt carries a
 * category (resolveLineCategory — the same authority the gate uses). */
export function isUncategorizedLine(
  line: Pick<AmexStatementLine, "matched_receipt_id" | "expense_category_code">,
  receipt:
    | Pick<ReceiptRecord, "expense_category_code" | "deleted_at">
    | undefined
    | null,
): boolean {
  return !resolveLineCategory(line, receipt);
}

/** A receipt blocks on unknown payment path (finalize gate 2). */
export function isUnknownPathReceipt(
  receipt: Pick<ReceiptRecord, "payment_path">,
): boolean {
  return receipt.payment_path === "UNKNOWN";
}

/** A receipt is an unreviewed blocker: needs review and not still pending
 * extraction (gate 2.5). Pending receipts are a separate "drain the queue"
 * nudge, not an unreviewed blocker. */
export function isUnreviewedReceipt(receipt: ReceiptRecord): boolean {
  return receipt.status === "needs_review" && !isPendingProcessing(receipt);
}

// ─── Proofs (gate 7) ─────────────────────────────────────────────────────────
// A shipped receipt with NO receipt_files row at all (no original, no proof_copy)
// cannot appear in the proofs ZIP → block finalize. Defined here (the shared
// rule location) and wired into the gate (validateMonthReadyForExportCore). The
// receipt_files row count is fetched once by the gate (countReceiptFilesByObjectIds)
// and passed in — this predicate stays pure and D1-free.
//
// Tile-vs-gate scope: per the PR 2 spec, this rule lives ONLY in the finalize
// gate (the authority). The export tile does NOT currently mirror it because the
// tile has no file-count fetch — a known, rare-case asymmetry (a shipped receipt
// with zero file rows is an orphan; the gate still enforces it). R2-object
// existence is NOT checked here — that's the rebuild's layer-2 job (the proofs
// zip build fails loudly when a file row exists but the object is gone).
// Missing proof_copy is NOT a blocker (the ZIP falls back to the original).

/** True when a receipt has zero receipt_files rows (no proof to include). */
export function isReceiptMissingProofFile(
  receiptId: string,
  receiptFileCounts: Map<string, number>,
): boolean {
  return (receiptFileCounts.get(receiptId) ?? 0) === 0;
}

/** Shipped receipts that have no proof file on record. */
export function receiptsMissingProofFiles(
  receipts: ReceiptRecord[],
  receiptFileCounts: Map<string, number>,
): ReceiptRecord[] {
  return receipts.filter((r) => isReceiptMissingProofFile(r.id, receiptFileCounts));
}

// ─── IC-card top-up heuristic (non-blocking warning) ──────────────────────
// A CASH/DIGITAL receipt categorized as travel_transportation, charged for a
// round top-up sum at a top-up venue (convenience store / station), is likely
// a prepaid IC-card (Suica/PASMO/ICOCA/etc.) charge — a prepayment, not a
// travel expense at the moment of charge. Informational warning only: it may
// be entirely business, and the responsible treatment (expense it as trips
// deplete the card, or treat the card is business-dedicated) is the
// accountant's call. NOT wired into the finalize gate — it is advisory.
// False positives are kept low by requiring ALL THREE signals (round sum AND
// top-up venue AND travel category) on the same receipt.

/** Round yen sums typical of an IC-card top-up. JPY has no minor units, so
 * amount_minor IS the yen value. */
export const IC_CARD_TOPUP_AMOUNTS_MINOR: ReadonlySet<number> = new Set([
  1000, 2000, 3000, 5000, 10000,
]);

/** True for a round yen sum typical of an IC-card top-up (¥1k/¥2k/¥3k/¥5k/¥10k). */
export function isRoundTopUpAmount(
  amountMinor: number | null | undefined,
): boolean {
  return amountMinor != null && IC_CARD_TOPUP_AMOUNTS_MINOR.has(amountMinor);
}

/** True when the merchant is a likely IC-card top-up point: a canonical
 * convenience-store chain (detected via merchant.ts, so OCR-garbled spellings
 * like "セブンーエレブン" still match — fixes the 2026-06 IC-warning undercount)
 * OR a station (駅 / "station"). Null/empty merchants never match. Advisory. */
export function isTopUpVenueMerchant(
  merchant: string | null | undefined,
): boolean {
  if (!merchant) return false;
  if (detectMerchantChain(merchant) !== null) return true;
  const lower = merchant.toLowerCase();
  return lower.includes("駅") || lower.includes("station");
}

/** True when a receipt looks like a prepaid IC-card top-up rather than a
 * travel expense: CASH/DIGITAL path, travel_transportation category, a round
 * top-up sum, AND a top-up-venue merchant. All four must hold — a real rail
 * fare (¥1,900 EMot, not a venue and not round) or a non-round store charge
 * (¥10,450 PC Depot) won't trip it. Never gates finalize; advisory only. */
export function isIcCardTopUpCandidate(
  receipt: Pick<
    ReceiptRecord,
    "payment_path" | "expense_category_code" | "amount_minor" | "merchant"
  >,
): boolean {
  if (receipt.payment_path !== "CASH" && receipt.payment_path !== "DIGITAL") {
    return false;
  }
  if (receipt.expense_category_code !== "travel_transportation") return false;
  return (
    isRoundTopUpAmount(receipt.amount_minor) &&
    isTopUpVenueMerchant(receipt.merchant)
  );
}

export type BlockerSeverity = "blocker" | "warn";

export type Blocker = {
  severity: BlockerSeverity;
  count: number;
  label: string;
  detail: string;
  href: string | null;
  ctaLabel: string;
};

export function computeExportBlockers(
  receipts: ReceiptRecord[],
  lines: AmexStatementLine[],
  // Receipts fetched by matched_receipt_id, unscoped by month (a line may be
  // matched to a receipt dated in a different statement month). Used ONLY for
  // category resolution: unioned into the receipt map so a cross-month matched
  // receipt's category resolves the line — matching the finalize gate, which
  // builds its receiptMap from bundle.receipts (the same ID-fetched set).
  // `receipts` (month-scoped) still drives the pending / unreviewed / unknown
  // counts below. Kept pure: callers do the DB fetch (listReceiptRecordsByIds
  // or reuse bundle.receipts); this function does no I/O.
  matchedReceipts: ReceiptRecord[] = [],
): Blocker[] {
  const blockers: Blocker[] = [];

  // Category authority is the matched receipt, not the line, for confirmed
  // matches (resolveLineCategory — the same authority
  // validateAmexLinesForSignoff / month-closing use). Counting the raw line
  // field over-reported "uncategorized" whenever a matched receipt already
  // carried the category, desynchronizing this tile from the finalize gate.
  // The map unions the month-scoped receipts with the ID-fetched matched
  // receipts so cross-month matches resolve (the fix for the 2026-06 "27
  // uncategorized" that were all matched to April/May receipts).
  const receiptMap = new Map<string, ReceiptRecord>();
  for (const r of receipts) receiptMap.set(r.id, r);
  for (const r of matchedReceipts) receiptMap.set(r.id, r);
  const uncategorized = lines.filter((l) => {
    const receipt = l.matched_receipt_id
      ? receiptMap.get(l.matched_receipt_id)
      : undefined;
    return isUncategorizedLine(l, receipt);
  }).length;
  if (uncategorized > 0) {
    blockers.push({
      severity: "blocker",
      count: uncategorized,
      label: "Uncategorized AMEX lines",
      detail: "Pick an expense category for each line.",
      href: "/receipts/reconcile",
      ctaLabel: "Fix in Reconcile",
    });
  }

  // payment_path='UNKNOWN' receipts are excluded from the export bundle by
  // design (their export month is ambiguous) and block finalize at
  // validateMonthReadyForExport gate 2. Surface them here so the tile and the
  // gate agree in this direction too — previously a month could read "clear"
  // on the tile yet 422 on finalize. `receipts` is the membership in-scope set
  // (bundle.receipts ∪ UNKNOWN in M's calendar month), matching the gate's scope.
  const unknownPath = receipts.filter(isUnknownPathReceipt).length;
  if (unknownPath > 0) {
    blockers.push({
      severity: "blocker",
      count: unknownPath,
      label: "Receipts with unknown payment path",
      detail: "Classify as AMEX, CASH, or DIGITAL before sealing.",
      href: "/receipts/review?payment_path=UNKNOWN",
      ctaLabel: "Fix in Review",
    });
  }

  // ADR 0001: "pending processing" is distinct from "unreviewed". A captured
  // receipt still in the extraction queue has no field key yet and cannot be
  // matched — surfacing it as a missing/unreviewed receipt would send someone
  // chasing a receipt we already hold. The fix is to drain the queue (run the
  // Mac consumer), not to review or re-capture.
  const pendingProcessing = receipts.filter(isPendingProcessing).length;
  if (pendingProcessing > 0) {
    blockers.push({
      severity: "blocker",
      count: pendingProcessing,
      label: "Receipts pending processing",
      detail: "Captured but not yet extracted. Drain the queue on the Mac.",
      href: "/receipts/review",
      ctaLabel: "Process queue",
    });
  }

  const unreviewed = receipts.filter(isUnreviewedReceipt).length;
  if (unreviewed > 0) {
    blockers.push({
      severity: "blocker",
      count: unreviewed,
      label: "Unreviewed receipts",
      detail: "These receipts must be reviewed before sealing.",
      href: "/receipts/review?status=needs_review",
      ctaLabel: "Fix in Review",
    });
  }

  const attendeesMissing = lines.filter(
    (l) => requiresAttendees(l.expense_category_code) && !l.matched_receipt_id,
  ).length;
  if (attendeesMissing > 0) {
    blockers.push({
      severity: "blocker",
      count: attendeesMissing,
      label: "Entertainment/meeting lines need attendees",
      detail: "Link a receipt that has attendees recorded.",
      href: "/receipts/reconcile",
      ctaLabel: "Fix in Reconcile",
    });
  }

  const missingReason = lines.filter(
    (l) => l.receipt_status === "missing_receipt" && !l.receipt_missing_reason,
  ).length;
  if (missingReason > 0) {
    blockers.push({
      severity: "blocker",
      count: missingReason,
      label: 'Lines marked "missing receipt" without a reason',
      detail: "Add a brief reason so audit can defend the claim.",
      href: "/receipts/reconcile",
      ctaLabel: "Fix in Reconcile",
    });
  }

  return blockers;
}

export function computeExportWarnings(lines: AmexStatementLine[]): Blocker[] {
  const warnings: Blocker[] = [];

  const tripCandidates = lines.filter(
    (l) => l.business_trip_status === "candidate",
  ).length;
  if (tripCandidates > 0) {
    warnings.push({
      severity: "warn",
      count: tripCandidates,
      label: "Unresolved business-trip candidates",
      detail: "Confirm or dismiss the trip cluster.",
      href: "/receipts/reconcile",
      ctaLabel: "Open trips",
    });
  }

  const noReceipt = lines.filter((l) => l.match_status === "no_receipt").length;
  if (noReceipt > 0) {
    warnings.push({
      severity: "warn",
      count: noReceipt,
      label: 'AMEX lines marked "no receipt expected"',
      detail: "These ship as-is; not a blocker.",
      href: null,
      ctaLabel: "Acknowledge",
    });
  }

  return warnings;
}

// ─── CASH/DIGITAL duplicate clustering ────────────────────────────────────
// One canonicalization-aware clustering implementation drives both the
// aggregate warning card (computeDuplicateReceiptWarnings) and the per-row
// badge map (buildDuplicateBadgeMap / groupDuplicateReceipts) so a receipt can
// never be flagged on one surface and not the other.

/**
 * Build the CASH/DIGITAL duplicate clusters: receipts sharing a canonicalized
 * merchant (merchant.ts) + amount_minor + transaction_date. Internal — carries
 * the full receipt objects so the aggregate card can read merchant/date/id.
 * groupDuplicateReceipts is the public ids-only projection; the key is JSON-
 * encoded (not NUL-separated) so the file stays grep/git-tooling friendly.
 * Cluster order is insertion order (first-seen first); within a cluster, input
 * order — matching the pre-refactor aggregate-card behavior exactly.
 */
function clusterDuplicates(
  receipts: ReceiptRecord[],
): { key: string; receipts: ReceiptRecord[] }[] {
  const groups = new Map<string, ReceiptRecord[]>();
  for (const r of receipts) {
    if (r.payment_path !== "CASH" && r.payment_path !== "DIGITAL") continue;
    if (!r.transaction_date || r.merchant == null || r.amount_minor == null) continue;
    // Canonicalize the merchant in the grouping key so OCR-garbled variants of
    // the same chain cluster together (2026-06: "セブンーエレブン" + "セブン-イレブン
    // 東中野末広橋店" — two photos of one PASMO top-up — never clustered because
    // the raw strings differ). Display still uses r.merchant verbatim.
    const key = JSON.stringify([
      canonicalizeMerchant(r.merchant),
      r.amount_minor,
      r.transaction_date,
    ]);
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  const out: { key: string; receipts: ReceiptRecord[] }[] = [];
  for (const [key, recs] of groups) {
    if (recs.length >= 2) out.push({ key, receipts: recs });
  }
  return out;
}

/** A duplicate cluster's membership (ids only) — the display-agnostic view. */
export type DuplicateCluster = { key: string; ids: string[] };

/**
 * Group CASH/DIGITAL receipts into duplicate clusters (canonicalized merchant +
 * amount + date, size ≥ 2). Returns ids only — the pure, display-agnostic view
 * the review-page badge logic consumes. Callers needing the aggregate warning
 * card should use computeDuplicateReceiptWarnings (same clustering).
 */
export function groupDuplicateReceipts(
  receipts: ReceiptRecord[],
): DuplicateCluster[] {
  return clusterDuplicates(receipts).map((c) => ({
    key: c.key,
    ids: c.receipts.map((r) => r.id),
  }));
}

/** Badge info for a receipt in a duplicate cluster: deep-link target (the
 *  cluster's first receipt) + cluster size. */
export type DuplicateBadge = { firstId: string; count: number };

/**
 * Map every receipt id that belongs to a duplicate cluster → its badge info
 * (first receipt id for the deep-link + cluster size). Receipts not in any
 * cluster are absent. Pure — unit-tested, then consumed by the review-page
 * Additional Charges list to render per-row "dup ×N" badges.
 */
export function buildDuplicateBadgeMap(
  receipts: ReceiptRecord[],
): Map<string, DuplicateBadge> {
  const map = new Map<string, DuplicateBadge>();
  for (const c of clusterDuplicates(receipts)) {
    const firstId = c.receipts[0]!.id;
    const count = c.receipts.length;
    for (const r of c.receipts) map.set(r.id, { firstId, count });
  }
  return map;
}

/**
 * Non-blocking warning when 2+ CASH/DIGITAL receipts share a CANONICALIZED
 * merchant + amount_minor + transaction_date (e.g. several ¥10,000 Seven-Eleven
 * charges on the same day). Merchant is canonicalized via merchant.ts so
 * OCR-garbled variants of the same chain cluster together (2026-06 fix:
 * "セブンーエレブン" + "セブン-イレブン 東中野末広橋店" — two photos of one charge).
 * ADR 0006 §D9 / PR #3. Warning only — no auto-dedup, not a finalize blocker.
 * Deep-links to the first offending receipt's edit view.
 *
 * Receipts not in the CASH/DIGITAL paths, or missing merchant/amount/date, are
 * ignored (they can't form a duplicate cluster on these keys).
 */
export function computeDuplicateReceiptWarnings(
  receipts: ReceiptRecord[],
): Blocker[] {
  const clusters = clusterDuplicates(receipts);
  if (clusters.length === 0) return [];
  const totalFlagged = clusters.reduce((s, c) => s + c.receipts.length, 0);
  const first = clusters[0]!.receipts[0]!;
  return [
    {
      severity: "warn",
      count: totalFlagged,
      label: "Possible duplicate cash/digital receipts",
      detail:
        `${clusters.length} cluster(s) share merchant + amount + date ` +
        `(e.g. ${first.merchant} ×${clusters[0]!.receipts.length} on ${first.transaction_date}). ` +
        `Confirm these are distinct charges, not double-captured.`,
      href: `/receipts/review/${first.id}`,
      ctaLabel: "Open first",
    },
  ];
}

/**
 * Non-blocking warning when a CASH/DIGITAL travel_transportation receipt looks
 * like a prepaid IC-card (Suica/PASMO/ICOCA) top-up — round sum + top-up
 * venue merchant (convenience store / station). Mirrors
 * computeDuplicateReceiptWarnings: same surfacing (severity "warn", same
 * BlockerTriage row), no gate change, deep-links to the first matching
 * receipt. See isIcCardTopUpCandidate for the predicate + false-positive
 * controls.
 *
 * Top-ups are prepayments, not travel expenses at charge time — the warning
 * asks the operator to confirm business usage, not to reclassify. Final
 * treatment is the accountant's call (month-close runbook §IC cards).
 */
export function computeIcCardTopUpWarnings(
  receipts: ReceiptRecord[],
): Blocker[] {
  const candidates = receipts.filter(isIcCardTopUpCandidate);
  if (candidates.length === 0) return [];
  const first = candidates[0]!;
  return [
    {
      severity: "warn",
      count: candidates.length,
      label: "Possible IC-card top-ups (categorized as travel)",
      detail:
        `Looks like an IC-card top-up. Top-ups are prepayments, not travel ` +
        `expenses at charge time — confirm business usage (attach the card's ` +
        `利用履歴) or note that the card is business-dedicated.`,
      href: `/receipts/review/${first.id}`,
      ctaLabel: "Open first",
    },
  ];
}
