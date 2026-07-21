import {
  listAmexLines,
  getReconciliationForMonth,
  listAmexLineCountsByMonth,
  listReconciliationStatusByMonth,
  listAttendeeNamesByReceiptIds,
  listReceiptRecordsByIds,
  listAmexLinesByMatchedReceiptIds,
  listAmexReceiptsForReconcile,
} from "@/lib/receipts/db";
import { matchAmexToReceipts } from "@/lib/receipts/reconciliation";
import { deriveStatementWindow } from "@/lib/receipts/statement-window";
import {
  partitionUnmatchedReceipts,
  statementLineDateRange,
} from "@/lib/receipts/orphan-classification";
import {
  crossMonthClaimedReceiptIds,
  allClaimedReceiptIds,
} from "@/lib/receipts/cross-month-claims";
import { findAmexDuplicateCandidates } from "@/lib/receipts/amex-duplicates";
import type { AmexDuplicateCandidate } from "@/lib/receipts/amex-duplicates";
import { ReconcileScreen } from "@/components/receipts/reconcile/reconcile-screen";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import type { MonthOption } from "@/components/receipts/month-switcher";
import { formatMonth } from "@/lib/receipts/format";
import { listCategoryRules } from "@/lib/receipts/category-rules";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import type { ReceiptRecord } from "@/lib/receipts/types";

export const dynamic = "force-dynamic";

export default async function ReconcilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await assertReceiptsPageAccess();

  const params = await searchParams;
  const requestedMonth =
    typeof params.month === "string" ? params.month : null;

  const [lineCountsByMonth, reconciliationStatusByMonth] = await Promise.all([
    listAmexLineCountsByMonth(),
    listReconciliationStatusByMonth(),
  ]);

  const availableMonths: MonthOption[] = [...lineCountsByMonth.entries()]
    .map(([month, counts]) => ({
      month,
      lineCount: counts.total,
      unmatchedCount: counts.unmatched,
      status: reconciliationStatusByMonth.get(month) ?? null,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const month =
    requestedMonth ??
    (availableMonths.length > 0
      ? availableMonths[availableMonths.length - 1]!.month
      : new Date().toISOString().slice(0, 7));

  const [amexLines, reconciliation] = await Promise.all([
    listAmexLines(month),
    getReconciliationForMonth(month),
  ]);

  const finalized = reconciliation?.status === "finalized";
  const window =
    amexLines.length > 0 ? deriveStatementWindow(amexLines, month) : null;

  // Part D — exhaustive windowed AMEX candidate read (dated in-window + undated,
  // separate). Replaces the old global newest-200 query; no silent truncation
  // (a hard cap inside listAmexReceiptsForReconcile throws loudly).
  const windowedReceipts: ReceiptRecord[] = window
    ? await listAmexReceiptsForReconcile(window)
    : [];

  // Receipts matched to THIS month's lines, fetched by id so the detail pane's
  // receipt map still resolves a line matched to a receipt dated outside the
  // window (a cross-month-dated confirmed match). Also feeds the duplicate pool.
  const matchedIdsThisMonth = amexLines
    .map((l) => l.matched_receipt_id)
    .filter((id): id is string => Boolean(id));
  const matchedReceiptsById = matchedIdsThisMonth.length
    ? await listReceiptRecordsByIds(matchedIdsThisMonth)
    : [];

  // Part B — cross-month claims. Load EVERY amex_statement_lines claim (all
  // statement months) against the windowed receipts. A receipt confirmed in
  // another month must NOT be offered as an automatic match or shown as an
  // orphan in THIS month, even if its receipt status has drifted. The AMEX line
  // relationship is authoritative here — never receipt.status.
  const windowedIds = windowedReceipts.map((r) => r.id);
  const crossMonthClaims = windowedIds.length
    ? await listAmexLinesByMatchedReceiptIds(windowedIds)
    : [];
  const crossMonthClaimedIds = crossMonthClaimedReceiptIds(
    crossMonthClaims,
    month,
  );

  // Matcher candidates: windowed receipts MINUS cross-month-claimed. Same-month
  // matches are intentionally kept so consolidated-receipt grouping still works.
  const matcherCandidates = windowedReceipts.filter(
    (r) => !crossMonthClaimedIds.has(r.id),
  );

  const autoMatches = finalized
    ? []
    : matchAmexToReceipts(amexLines, matcherCandidates);

  const linkedReceiptIds = new Set(matchedIdsThisMonth);
  const suggestedReceiptIds = new Set(autoMatches.map((m) => m.receiptId));

  // Unmatched in-window AMEX receipts (active, not deleted, not linked here, not
  // suggested, not claimed in another month). Then classify honestly (Part C):
  // only true in-period receipts become "orphan receipts".
  const unmatchedInWindow = windowedReceipts.filter(
    (r) =>
      r.payment_path === "AMEX" &&
      r.status !== "archived" &&
      r.status !== "exported" &&
      r.status !== "reconciled" &&
      !r.deleted_at &&
      !linkedReceiptIds.has(r.id) &&
      !suggestedReceiptIds.has(r.id) &&
      !crossMonthClaimedIds.has(r.id),
  );

  const dateRange = statementLineDateRange(
    amexLines.map((l) => l.transaction_date),
  );
  const partition = partitionUnmatchedReceipts(unmatchedInWindow, dateRange);
  const orphanReceipts = partition.true_in_period;

  // Part E — non-destructive AMEX duplicate candidates. The pool is the windowed
  // set ∪ this month's matched-by-id receipts (so an orphan can be compared
  // against an already-matched partner). matchedReceiptIds is the authoritative
  // "claimed by an AMEX line" set (this month's links ∪ every cross-month claim).
  const poolMap = new Map<string, ReceiptRecord>();
  for (const r of windowedReceipts) poolMap.set(r.id, r);
  for (const r of matchedReceiptsById) poolMap.set(r.id, r);
  const poolReceipts = [...poolMap.values()];

  const claimedReceiptIds = new Set<string>(linkedReceiptIds);
  for (const id of allClaimedReceiptIds(crossMonthClaims)) {
    claimedReceiptIds.add(id);
  }
  // Duplicate candidates span every DATED unmatched display population (true
  // in-period, leading-slack, upcoming) — not only true orphans. The 2026-07-21
  // audit found re-captures in the leading-slack population too (HOLIDAY,
  // NFCTAGS). Undated receipts can't form the (merchant+amount+date) fingerprint
  // and stay excluded. Non-blocking surfacing only.
  const datedUnmatched: ReceiptRecord[] = [
    ...partition.true_in_period,
    ...partition.leading_slack,
    ...partition.upcoming,
  ];
  const duplicateCandidates: Map<string, AmexDuplicateCandidate[]> =
    findAmexDuplicateCandidates(datedUnmatched, poolReceipts, claimedReceiptIds);

  // Bulk-fetch attendee names once for every receipt that could be shown in the
  // detail pane or orphan list. Single query — keeps the detail pane N+1-free.
  const attendeeReceiptIds = Array.from(
    new Set([
      ...linkedReceiptIds,
      ...suggestedReceiptIds,
      ...orphanReceipts.map((r) => r.id),
    ]),
  );
  const attendeesByReceiptId = await listAttendeeNamesByReceiptIds(
    attendeeReceiptIds,
  );

  // Active category pattern rules → live suggestion on unmatched, uncategorized
  // AMEX lines (ADR: category-rules).
  const categoryRules = (await listCategoryRules(getReceiptsDb())).map((r) => ({
    matchType: r.match_type,
    matchValue: r.match_value,
    expenseCategoryCode: r.expense_category_code,
  }));

  return (
    <ReconcileScreen
      amexLines={amexLines}
      receipts={poolReceipts}
      autoMatches={autoMatches}
      orphanReceipts={orphanReceipts}
      leadingSlackReceipts={partition.leading_slack}
      upcomingReceipts={partition.upcoming}
      undatedReceipts={partition.undated}
      duplicateCandidates={duplicateCandidates}
      month={month}
      monthLabel={formatMonth(month)}
      monthsAvailable={availableMonths}
      finalized={finalized}
      finalizedAt={reconciliation?.finalized_at ?? null}
      window={window}
      receiptsInWindow={windowedReceipts}
      attendeesByReceiptId={attendeesByReceiptId}
      categoryRules={categoryRules}
    />
  );
}
