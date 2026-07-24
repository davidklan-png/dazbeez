// Closing-attention collector for the review queue.
//
// A receipt is in "Needs review" when it is implicated by a receipt-addressable
// blocker or warning surfaced during monthly closing. This module is the SINGLE
// authority for that set: THREE consumers read one computation —
//   - the queue filter ("Needs review" tab),
//   - the amber "N need attention" pill (count = unlocked ∩ attention), and
//   - the per-row reason badges in the queue-rail (which reason(s) fired).
// They cannot drift from each other: the badges, the count, and the tab all
// derive from {@link computeClosingAttentionReasons}.
//
// Architecture mirrors the finalize gate (lib/receipts/month-closing.ts): a PURE
// synchronous core ({@link computeClosingAttentionReasons}) that takes
// pre-loaded supporting data and returns the reason CODES per receipt, and an
// async wrapper ({@link collectClosingAttentionReasons}) that batch-loads it.
// The core is unit-tested without D1; the wrapper does ONE batched query per
// data kind (no per-receipt round-trips). Membership-only adapters
// ({@link computeClosingAttentionReceiptIds} / {@link collectClosingAttentionReceiptIds})
// remain so every existing membership test is unchanged.
//
// Rule predicates are SHARED with the monthly-close / reconciliation-signoff /
// compliance / blockers authorities so the attention set cannot drift from
// them: evaluateAmexLineSignoff + collectConsolidatedMismatches +
// crossMonthAmbiguousReceiptIds (reconciliation-signoff), isPendingProcessing /
// isUnreviewedReceipt / isUnknownPathReceipt / isReceiptMissingProofFile /
// isIcCardTopUpCandidate / groupDuplicateReceipts (blockers, extraction-state),
// and the open-compliance-check set (compliance).

import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { requiresAttendees } from "@/lib/receipts/categories";
import { resolveAttendeeNames } from "@/lib/receipts/attendee-directory";
import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";
import { isPendingProcessing } from "@/lib/receipts/extraction-state";
import {
  groupDuplicateReceipts,
  isIcCardTopUpCandidate,
  isReceiptMissingProofFile,
  isUnknownPathReceipt,
  isUnreviewedReceipt,
} from "@/lib/receipts/blockers";
import {
  listAmexLineAttendeeNamesByLineIds,
  listAmexLinesByMatchedReceiptIds,
  listAttendeeDirectory,
  listAttendeeNamesByReceiptIds,
} from "@/lib/receipts/db";
import { collectOpenComplianceCheckReceiptIds } from "@/lib/receipts/compliance";
import { countReceiptFilesByObjectIds } from "@/lib/receipts/files";
import {
  collectConsolidatedMismatches,
  crossMonthAmbiguousReceiptIds,
  evaluateAmexLineSignoff,
} from "@/lib/receipts/reconciliation-signoff";
import type { AmexLineSignoffCode } from "@/lib/receipts/reconciliation-signoff";
import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";
import type { ClosingAttentionCode } from "@/lib/receipts/attention-codes";

/** Canonical emission order for check (6) — mirrors evaluateAmexLineSignoff's
 *  push order so the per-receipt badge label is deterministic regardless of
 *  which matched line fired first (the query order of amexLines is not
 *  guaranteed to be this order). `amex_total_mismatch` is appended last. */
const AMEX_SIGNOFF_ORDER: readonly AmexLineSignoffCode[] = [
  "unresolved_match",
  "missing_category",
  "matched_not_confirmed",
  "missing_reason",
  "attendees_required",
  "attendee_unresolved",
  "business_trip_candidate",
  "re_review_needed",
];

/** Inputs the pure core needs, fetched by the async wrapper. */
export interface ClosingAttentionInput {
  receipts: ReceiptRecord[];
  /** Epoch-ms "now" (passed in so the core is deterministic in tests). */
  now: number;
  /** AMEX statement lines matched to any of `receipts` (all statement months). */
  amexLines: AmexStatementLine[];
  /** Direct (line-level) attendees keyed by line id. */
  amexAttendees: Record<string, string[]>;
  /** Receipt attendees keyed by receipt id. */
  receiptAttendeeMap: Map<string, string[]>;
  /** Attendee directory (migration 0022) for name resolution. */
  attendeeDirectory: ReceiptAttendeeDirectoryEntry[];
  /** Receipt ids carrying an open blocker/warning compliance check. */
  complianceFlaggedReceiptIds: Set<string>;
  /** receipt_files row count per receipt id (absent = 0). */
  receiptFileCounts: Map<string, number>;
  /** Raw (statement_month, matched_receipt_id) rows for cross-month grouping. */
  crossMonthMatchedLines: { statement_month: string; matched_receipt_id: string }[];
}

/**
 * PURE core: the reason codes per receipt (within `receipts`) that need closing
 * attention. Deterministic given the inputs — no I/O, no Date.now. The "Needs
 * review" filter tab, the amber need-attention pill, AND the per-row rail badges
 * all derive from this map (the tab/pill use `.keys()`; the badges use the
 * codes). A clean receipt is ABSENT from the map (not present with `[]`).
 *
 * Codes accumulate per receipt in the canonical check order (1)→(9); a receipt
 * failing several gates carries several codes. The exception is check (1): a
 * receipt still pending or that failed extraction is evaluated ONLY against (1)
 * — it carries exactly `["extraction_pending"]` or `["extraction_failed"]` so a
 * half-extracted row does not spray "no merchant / no amount" noise.
 *
 * A receipt is included when ANY of these hold (see the spec's categories):
 *   - (1) pending/stuck/failed extraction (captured not yet processed, or failed);
 *   - (2) unreviewed (needs_review, not still pending);
 *   - (3) UNKNOWN payment path;
 *   - (4) receipt-level closing gates: missing date / merchant / amount / category,
 *     required attendees missing, an attendee not resolvable via the directory,
 *     or no proof file row (one code per failed gate);
 *   - (5) an open compliance check at severity blocker OR warning;
 *   - (6) implicated by an AMEX-line sign-off rule on one of its matched lines
 *     (unresolved/unconfirmed match, unresolved category, missing reason,
 *     attendee problem, business-trip candidate, re_review_needed) — one
 *     `amex_*` code per fired rule, deduped across the receipt's lines — or a
 *     consolidated-line total mismatch (`amex_total_mismatch`);
 *   - (7) matched to AMEX lines in more than one statement month (cross-month
 *     ambiguity);
 *   - (8) a member of a possible-duplicate CASH/DIGITAL cluster;
 *   - (9) a likely IC-card top-up candidate.
 *
 * Issues that live only on an AMEX line with no matched receipt cannot appear
 * here (there is no receipt to add) — they stay on Reconcile/Export.
 */
export function computeClosingAttentionReasons(
  input: ClosingAttentionInput,
): Map<string, ClosingAttentionCode[]> {
  const {
    receipts,
    amexLines,
    amexAttendees,
    receiptAttendeeMap,
    attendeeDirectory,
    complianceFlaggedReceiptIds,
    receiptFileCounts,
    crossMonthMatchedLines,
  } = input;

  const reasonsByReceipt = new Map<string, ClosingAttentionCode[]>();
  const workingSetIds = new Set(receipts.map((r) => r.id));

  // Pre-compute the AMEX-derived attention signals once (they implicate matched
  // receipts, independent of the per-receipt loop). Collect the fired sign-off
  // codes per receipt (deduped across the receipt's matched lines).
  const signoffSets = new Map<string, Set<string>>();
  const addSignoff = (receiptId: string, codes: Iterable<string>) => {
    if (!workingSetIds.has(receiptId)) return; // line-only issue → no receipt
    let set = signoffSets.get(receiptId);
    if (!set) {
      set = new Set();
      signoffSets.set(receiptId, set);
    }
    for (const c of codes) set.add(c);
  };
  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  for (const line of amexLines) {
    const receipt = line.matched_receipt_id;
    if (!receipt) continue; // line-only issue → no receipt to implicate
    const lineDirect = amexAttendees[line.id] ?? [];
    const receiptAttendees = receiptAttendeeMap.get(receipt) ?? [];
    const result = evaluateAmexLineSignoff(
      line,
      receiptById.get(receipt) ?? undefined,
      lineDirect,
      receiptAttendees,
      attendeeDirectory,
    );
    if (result.codes.length > 0) {
      addSignoff(receipt, result.codes.map((c) => `amex_${c}`));
    }
  }
  for (const m of collectConsolidatedMismatches(amexLines, receiptById)) {
    addSignoff(m.receiptId, ["amex_total_mismatch"]);
  }
  const crossMonthIds = crossMonthAmbiguousReceiptIds(crossMonthMatchedLines);
  const duplicateIds = new Set<string>();
  for (const cluster of groupDuplicateReceipts(receipts)) {
    for (const id of cluster.ids) duplicateIds.add(id);
  }

  for (const r of receipts) {
    const code = r.expense_category_code ?? "";
    const reasons: ClosingAttentionCode[] = [];

    // (1) Pending / stuck / failed extraction. `failed` is not a pending state,
    // so the two codes are mutually exclusive. Either way the receipt is NOT
    // evaluated against (2)–(9): a half-extracted row must not spray
    // "no merchant / no amount" noise.
    if (isPendingProcessing(r)) reasons.push("extraction_pending");
    if (r.extraction_state === "failed") reasons.push("extraction_failed");
    if (reasons.length > 0) {
      reasonsByReceipt.set(r.id, reasons);
      continue;
    }

    // (2) Unreviewed.
    if (isUnreviewedReceipt(r)) reasons.push("unreviewed");
    // (3) UNKNOWN payment path.
    if (isUnknownPathReceipt(r)) reasons.push("unknown_path");
    // (4) Receipt-level closing gates — one code per failed gate.
    if (!r.transaction_date) reasons.push("missing_date");
    if (!r.merchant) reasons.push("missing_merchant");
    if (r.amount_minor === null) reasons.push("missing_amount");
    if (!r.expense_category_code) reasons.push("missing_category");
    if (requiresAttendees(code)) {
      const names = receiptAttendeeMap.get(r.id) ?? [];
      if (names.length === 0) {
        reasons.push("attendees_missing");
      } else {
        const { unresolved } = resolveAttendeeNames(names, attendeeDirectory);
        if (unresolved.length > 0) reasons.push("attendee_unresolved");
      }
    }
    if (isReceiptMissingProofFile(r.id, receiptFileCounts)) {
      reasons.push("missing_proof_file");
    }
    // (5) Open compliance check (blocker or warning).
    if (complianceFlaggedReceiptIds.has(r.id)) reasons.push("compliance_open");
    // (6) AMEX sign-off / consolidated mismatch — deduped, canonical order.
    const signoff = signoffSets.get(r.id);
    if (signoff && signoff.size > 0) {
      for (const sc of AMEX_SIGNOFF_ORDER) {
        const key = `amex_${sc}` as ClosingAttentionCode;
        if (signoff.has(key)) reasons.push(key);
      }
      if (signoff.has("amex_total_mismatch")) reasons.push("amex_total_mismatch");
    }
    // (7) Cross-month ambiguous match.
    if (crossMonthIds.has(r.id)) reasons.push("cross_month_ambiguous");
    // (8) Duplicate cluster member.
    if (duplicateIds.has(r.id)) reasons.push("possible_duplicate");
    // (9) IC-card top-up candidate.
    if (isIcCardTopUpCandidate(r)) reasons.push("ic_topup_candidate");

    if (reasons.length > 0) reasonsByReceipt.set(r.id, reasons);
  }

  return reasonsByReceipt;
}

/**
 * PURE membership adapter: the set of receipt ids (within `receipts`) that need
 * closing attention — i.e. the keys of {@link computeClosingAttentionReasons}.
 * Deterministic given the inputs — no I/O, no Date.now. Both the "Needs review"
 * filter tab and the amber need-attention pill consume this exact set.
 */
export function computeClosingAttentionReceiptIds(
  input: ClosingAttentionInput,
): Set<string> {
  return new Set(computeClosingAttentionReasons(input).keys());
}

/**
 * Async wrapper: batch-load everything the core needs (one query per kind, no
 * per-receipt round-trips) and return the reason map for `receipts`. `now`
 * defaults to Date.now(); tests should pass an explicit value via the pure core
 * instead.
 */
export async function collectClosingAttentionReasons(
  receipts: ReceiptRecord[],
): Promise<Map<string, ClosingAttentionCode[]>> {
  const ids = receipts.map((r) => r.id);
  const db = getReceiptsDb();

  const [amexLines, receiptAttendeeMap, attendeeDirectory, complianceFlaggedReceiptIds, receiptFileCounts] =
    await Promise.all([
      listAmexLinesByMatchedReceiptIds(ids),
      listAttendeeNamesByReceiptIds(ids),
      listAttendeeDirectory(),
      collectOpenComplianceCheckReceiptIds(db, ids),
      countReceiptFilesByObjectIds(db, ids),
    ]);

  // Line attendees need the line ids from the loaded lines — fetch after.
  const lineAttendees = await listAmexLineAttendeeNamesByLineIds(
    amexLines.map((l) => l.id),
  );

  // Cross-month grouping derives from the same loaded lines (each carries its
  // own statement_month + matched_receipt_id), so no extra query is needed.
  const crossMonthMatchedLines = amexLines.map((l) => ({
    statement_month: l.statement_month,
    matched_receipt_id: l.matched_receipt_id ?? "",
  }));

  return computeClosingAttentionReasons({
    receipts,
    now: Date.now(),
    amexLines,
    amexAttendees: lineAttendees,
    receiptAttendeeMap,
    attendeeDirectory,
    complianceFlaggedReceiptIds,
    receiptFileCounts,
    crossMonthMatchedLines,
  });
}

/** Async membership adapter: the attention id set, i.e. the keys of
 *  {@link collectClosingAttentionReasons}. */
export async function collectClosingAttentionReceiptIds(
  receipts: ReceiptRecord[],
): Promise<Set<string>> {
  return new Set((await collectClosingAttentionReasons(receipts)).keys());
}
