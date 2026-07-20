// Closing-attention collector for the review queue.
//
// A receipt is in "Needs review" when it is implicated by a receipt-addressable
// blocker or warning surfaced during monthly closing. This module is the SINGLE
// authority for that set: both review pages (the queue filter) and the amber
// "N need attention" pill consume the exact same Set<string> it returns, so the
// count can never drift from the tab.
//
// Architecture mirrors the finalize gate (lib/receipts/month-closing.ts): a PURE
// synchronous core ({@link computeClosingAttentionReceiptIds}) that takes
// pre-loaded supporting data, and an async wrapper
// ({@link collectClosingAttentionReceiptIds}) that batch-loads it. The core is
// unit-tested without D1; the wrapper does ONE batched query per data kind
// (no per-receipt round-trips).
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
import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";

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
 * PURE core: the set of receipt ids (within `receipts`) that need closing
 * attention. Deterministic given the inputs — no I/O, no Date.now. Both the
 * "Needs review" filter tab and the amber need-attention pill consume this
 * exact set.
 *
 * A receipt is included when ANY of these hold (see the spec's categories):
 *   - pending/stuck/failed extraction (captured not yet processed, or failed);
 *   - unreviewed (needs_review, not still pending);
 *   - UNKNOWN payment path;
 *   - receipt-level closing gates: missing date / merchant / amount / category,
 *     required attendees missing, an attendee not resolvable via the directory,
 *     or no proof file row;
 *   - an open compliance check at severity blocker OR warning;
 *   - implicated by an AMEX-line sign-off rule on one of its matched lines
 *     (unresolved/unconfirmed match, unresolved category, missing reason,
 *     attendee problem, business-trip candidate, re_review_needed) or a
 *     consolidated-line total mismatch;
 *   - matched to AMEX lines in more than one statement month (cross-month
 *     ambiguity);
 *   - a member of a possible-duplicate CASH/DIGITAL cluster;
 *   - a likely IC-card top-up candidate.
 *
 * Issues that live only on an AMEX line with no matched receipt cannot appear
 * here (there is no receipt to add) — they stay on Reconcile/Export.
 */
export function computeClosingAttentionReceiptIds(
  input: ClosingAttentionInput,
): Set<string> {
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

  const attention = new Set<string>();
  const workingSetIds = new Set(receipts.map((r) => r.id));
  const add = (id: string | null | undefined) => {
    if (id && workingSetIds.has(id)) attention.add(id);
  };

  // Pre-compute the AMEX-derived attention signals once (they implicate matched
  // receipts, independent of the per-receipt loop).
  const signoffImplicated = new Set<string>();
  for (const line of amexLines) {
    const receipt = line.matched_receipt_id ? line.matched_receipt_id : null;
    if (!receipt) continue; // line-only issue → no receipt to implicate
    const lineDirect = amexAttendees[line.id] ?? [];
    const receiptAttendees = receiptAttendeeMap.get(receipt) ?? [];
    // The matched receipt object (for category resolution). It is in the
    // working set by construction (lines are loaded by matched_receipt_id IN
    // the working set); fall back to undefined if absent.
    const receiptRecord = receipts.find((r) => r.id === receipt);
    const result = evaluateAmexLineSignoff(
      line,
      receiptRecord ?? undefined,
      lineDirect,
      receiptAttendees,
      attendeeDirectory,
    );
    if (result.codes.length > 0) signoffImplicated.add(receipt);
  }
  for (const m of collectConsolidatedMismatches(
    amexLines,
    new Map(receipts.map((r) => [r.id, r])),
  )) {
    signoffImplicated.add(m.receiptId);
  }
  const crossMonthIds = crossMonthAmbiguousReceiptIds(crossMonthMatchedLines);
  const duplicateIds = new Set<string>();
  for (const cluster of groupDuplicateReceipts(receipts)) {
    for (const id of cluster.ids) duplicateIds.add(id);
  }

  for (const r of receipts) {
    const code = r.expense_category_code ?? "";

    // (1) Pending / stuck / failed extraction.
    if (isPendingProcessing(r) || r.extraction_state === "failed") {
      attention.add(r.id);
      continue;
    }
    // (2) Unreviewed.
    if (isUnreviewedReceipt(r)) {
      attention.add(r.id);
      continue;
    }
    // (3) UNKNOWN payment path.
    if (isUnknownPathReceipt(r)) {
      attention.add(r.id);
      continue;
    }

    // (4) Receipt-level closing gates.
    let gate = false;
    if (!r.transaction_date) gate = true;
    if (!r.merchant) gate = true;
    if (r.amount_minor === null) gate = true;
    if (!r.expense_category_code) gate = true;
    if (requiresAttendees(code)) {
      const names = receiptAttendeeMap.get(r.id) ?? [];
      if (names.length === 0) {
        gate = true;
      } else {
        const { unresolved } = resolveAttendeeNames(names, attendeeDirectory);
        if (unresolved.length > 0) gate = true;
      }
    }
    if (isReceiptMissingProofFile(r.id, receiptFileCounts)) gate = true;
    if (gate) {
      attention.add(r.id);
      continue;
    }

    // (5) Open compliance check (blocker or warning).
    if (complianceFlaggedReceiptIds.has(r.id)) {
      attention.add(r.id);
      continue;
    }

    // (6) AMEX sign-off / consolidated mismatch.
    if (signoffImplicated.has(r.id)) {
      attention.add(r.id);
      continue;
    }

    // (7) Cross-month ambiguous match.
    if (crossMonthIds.has(r.id)) {
      attention.add(r.id);
      continue;
    }

    // (8) Duplicate cluster member.
    if (duplicateIds.has(r.id)) {
      attention.add(r.id);
      continue;
    }

    // (9) IC-card top-up candidate.
    if (isIcCardTopUpCandidate(r)) {
      attention.add(r.id);
      continue;
    }
  }

  return attention;
}

/**
 * Async wrapper: batch-load everything the core needs (one query per kind, no
 * per-receipt round-trips) and return the attention set for `receipts`.
 * `now` defaults to Date.now(); tests should pass an explicit value via the
 * pure core instead.
 */
export async function collectClosingAttentionReceiptIds(
  receipts: ReceiptRecord[],
): Promise<Set<string>> {
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

  return computeClosingAttentionReceiptIds({
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
