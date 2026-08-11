import {
  listAmexLines,
  listExports,
  getExport,
  getLatestFinalizedExport,
  listAmexLineCountsByMonth,
  listReconciliationStatusByMonth,
} from "@/lib/receipts/db";
import {
  listUnassignableReceipts,
  listUnknownInScopeReceipts,
} from "@/lib/receipts/membership";
import {
  formatCategoryLabel,
  getCategoryByCode,
} from "@/lib/receipts/categories";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import {
  ExportScreen,
  type CategoryBreakdownRow,
} from "@/components/receipts/export/export-screen";
import { MonthSwitcher, type MonthOption } from "@/components/receipts/month-switcher";
import { formatMonth } from "@/lib/receipts/format";
import {
  computeExportBlockers,
  computeDuplicateReceiptWarnings,
  computeExportWarnings,
  computeIcCardTopUpWarnings,
} from "@/lib/receipts/blockers";
import {
  ACCOUNTANT_DISCLAIMER_EN,
  ACCOUNTANT_DISCLAIMER_JA,
} from "@/lib/receipts/settings";
import { buildExportBundle } from "@/lib/receipts/month-closing";
import { BUNDLE_DOWNLOAD_LINK_DEFS } from "@/lib/receipts/export";
import { deriveFinalizedMonthsDeliveryState } from "@/lib/receipts/delivery-status";
import { CreateRevisionButton } from "@/components/receipts/export/create-revision-button";
import { DeliveryMonthBanner } from "@/components/receipts/export/delivery-month-banner";

export const dynamic = "force-dynamic";

// The four artifacts finalize seals in RECEIPTS_ARCHIVE_BUCKET, served by
// GET /api/receipts/export/[month]/download (Content-Disposition: attachment,
// so plain anchors download without any client-side code).
// Shared definition (lib/receipts/export.ts) — the review-#2 rollout missed
// this page because it had a local copy of the list. Do not re-inline.
const BUNDLE_DOWNLOAD_LINKS = BUNDLE_DOWNLOAD_LINK_DEFS;

export default async function ExportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await assertReceiptsPageAccess();

  const params = await searchParams;
  const requestedMonth =
    typeof params.month === "string" && /^\d{4}-\d{2}$/.test(params.month)
      ? params.month
      : null;

  const [lineCountsByMonth, reconciliationStatusByMonth, deliveryByMonth] =
    await Promise.all([
      listAmexLineCountsByMonth(),
      listReconciliationStatusByMonth(),
      // §6: one server-side Map<month, DeliveryState|null> drives every alert
      // surface (this page's banner + pills, the dashboard banner).
      deriveFinalizedMonthsDeliveryState(),
    ]);

  const availableMonths: MonthOption[] = [...lineCountsByMonth.entries()]
    .map(([optionMonth, counts]) => ({
      month: optionMonth,
      lineCount: counts.total,
      unmatchedCount: counts.unmatched,
      status: reconciliationStatusByMonth.get(optionMonth) ?? null,
      // Only finalized months are in the delivery map. has() distinguishes
      // "not finalized → undefined (legacy pill)" from "finalized never sent →
      // null (red pill)" — `?? undefined` alone would wrongly drop the null.
      deliveryState: deliveryByMonth.has(optionMonth)
        ? (deliveryByMonth.get(optionMonth) ?? null)
        : undefined,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const month =
    requestedMonth ??
    (availableMonths.length > 0
      ? availableMonths[availableMonths.length - 1]!.month
      : new Date().toISOString().slice(0, 7));
  const monthLabel = formatMonth(month);

  // Build the SAME bundle the route finalizes with (single shared
  // row-assembly authority in lib/receipts/month-closing.ts buildExportBundle).
  // The preview the operator sees is now bit-identical to what ships —
  // eliminates the audit-9 drift where the dashboard's row count, total,
  // and size estimate could differ from the finalized bundle.
  //
  // We still fetch the unfiltered month receipts + lines separately for the
  // blockers panel (computeExportBlockers runs over the raw receipt set,
  // including UNKNOWN payment_path that the bundle intentionally excludes).
  const [
    bundle,
    exports,
    unknownInScope,
    monthLines,
    currentExport,
    latestFinalized,
    unassignable,
  ] = await Promise.all([
    buildExportBundle(month),
    listExports(),
    listUnknownInScopeReceipts(month),
    listAmexLines(month),
    getExport(month),
    getLatestFinalizedExport(month),
    listUnassignableReceipts(),
  ]);
  // ADR 0006 (PR #2): tile counting set = in-scope receipts for M = the bundle
  // (matched AMEX + CASH/DIGITAL assigned to M) ∪ UNKNOWN in M's natural window
  // — the same set the finalize gate (validateMonthReadyForExport) uses for its
  // unreviewed check, so the tile and gate cannot drift.
  const monthReceipts = [...bundle.receipts, ...unknownInScope];

  // bundle.receipts is the ID-fetched matched-receipt set (unscoped by month)
  // plus in-month CASH/DIGITAL receipts — the same authority the finalize
  // gate (validateMonthReadyForExport) builds its receiptMap from. Passing it
  // lets computeExportBlockers resolve a line matched to a receipt dated in a
  // different statement month, eliminating the tile-vs-gate drift where the
  // tile over-reported "uncategorized" lines the gate accepted (2026-06's 27
  // were all matched to April/May receipts). monthReceipts (month-scoped) still
  // drives the pending / unreviewed / unknown counts.
  const blockers = computeExportBlockers(monthReceipts, monthLines, bundle.receipts);
  const warnings = [
    ...computeExportWarnings(monthLines),
    ...computeDuplicateReceiptWarnings(monthReceipts),
    ...computeIcCardTopUpWarnings(monthReceipts),
  ];

  const draftStats = computeDraftStats(bundle.rows);
  const breakdown = computeBreakdown(bundle.rows);

  // §6: the active month's delivery state — drives the banner above the sealed
  // bundle. latestFinalized implies the month is finalized ⇒ in the delivery map
  // (get() returns DeliveryState|null; the ?? null is a safe fallback).
  const monthDeliveryState = latestFinalized
    ? (deliveryByMonth.get(month) ?? null)
    : null;

  return (
    <>
      <div className="border-b border-gray-200 bg-gray-50 px-8 py-4">
        <MonthSwitcher
          months={availableMonths}
          activeMonth={month}
          basePath="/receipts/export"
        />
      </div>
      <ExportScreen
        month={month}
        monthLabel={monthLabel}
        currentExport={currentExport}
        exports={exports}
        blockers={blockers}
        warnings={warnings}
        draftStats={draftStats}
        breakdown={breakdown}
        unassignableReceipts={unassignable}
      />
      {latestFinalized && (
        <DeliveryMonthBanner month={month} state={monthDeliveryState} />
      )}
      {/* Sealed bundle — latest FINALIZED revision. Served even while a
          revision draft is open (getLatestFinalizedExport, NOT getExport, so an
          open draft never makes the sealed package undownloadable). */}
      {latestFinalized && (
        <div className="border-t border-gray-200 bg-white px-8 py-6">
          <h2 className="text-sm font-bold text-gray-900">
            Download sealed bundle
            {latestFinalized.export_revision && latestFinalized.export_revision > 1
              ? ` (revision ${latestFinalized.export_revision})`
              : ""}
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            Finalized {monthLabel} archive files, served byte-for-byte as sealed in
            R2 — SHA-256 hashes match the manifest.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            {BUNDLE_DOWNLOAD_LINKS.filter(
              ({ file }) => file !== "proofs" || !!latestFinalized.proofs_r2_key,
            ).map(({ file, label }) => (
              <a
                key={file}
                href={`/api/receipts/export/${month}/download?file=${file}`}
                className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100"
              >
                {label}
              </a>
            ))}
          </div>
          {!latestFinalized.proofs_r2_key && (
            <p className="mt-2 text-[11px] text-gray-500">
              証憑ZIP (proofs) is absent — this revision was sealed before proofs
              were added. Create a revision and rebuild to generate it.
            </p>
          )}
          {/* No open draft yet → offer to create a revision (e.g. to add proofs). */}
          {currentExport?.status !== "draft" && (
            <CreateRevisionButton month={month} monthLabel={monthLabel} />
          )}
        </div>
      )}

      {/* Draft bundle — the open revision (verify-before-finalize). Bytes are
          the candidate seal; only the DRAFT- filename prefix signals it isn't. */}
      {currentExport?.status === "draft" && (
        <div className="border-t border-amber-200 bg-amber-50/40 px-8 py-6">
          <h2 className="text-sm font-bold text-amber-900">
            下書きダウンロード (DRAFT)
            {currentExport.export_revision
              ? ` — revision ${currentExport.export_revision}`
              : ""}
          </h2>
          {currentExport.bundle_built_at ? (
            <>
              <p className="mt-1 text-xs text-amber-800">
                Open draft, NOT yet sealed. <strong>証憑あり</strong> is
                byte-identical to what Finalize will seal; <strong>証憑なし</strong>{" "}
                is the pack root only (照合CSVs + 集計.csv + ご連絡事項.txt, no
                images/PDFs). The word <code>Draft</code> in the filename is the
                not-sealed signal — verify, then finalize.
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                <a
                  href={`/api/receipts/export/${month}/download?file=draft_nr&draft=true`}
                  className="rounded-xl border border-amber-400 bg-amber-100 px-4 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-200"
                >
                  下書き（証憑なし）
                </a>
                <a
                  href={`/api/receipts/export/${month}/download?file=draft_wr&draft=true`}
                  className="rounded-xl border border-amber-400 bg-amber-100 px-4 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-200"
                >
                  下書き（証憑あり）
                </a>
              </div>
            </>
          ) : (
            <p className="mt-1 text-xs text-amber-800">
              Draft revision created but not yet rebuilt. Click{" "}
              <strong>Rebuild draft</strong> to stage the bundle (CSV + proofs ZIP +
              notice) for download.
            </p>
          )}
        </div>
      )}
      <div className="border-t border-amber-100 bg-amber-50 px-8 py-4 text-xs text-amber-900">
        <p className="font-semibold">Accountant review boundary</p>
        <p className="mt-1">{ACCOUNTANT_DISCLAIMER_EN}</p>
        <p className="mt-2">{ACCOUNTANT_DISCLAIMER_JA}</p>
      </div>
    </>
  );
}

/**
 * Compute KPI stats over the bundle rows — the same rows that ship in the
 * CSV. Audit A6: previously summed `receipts + lines`, double-counting
 * matched receipts (their amount appeared in both the line and the
 * receipt). Bundle assembly already excludes matched receipts from the
 * non-Amex receipt section, so summing bundle.rows is correct by
 * construction.
 */
function computeDraftStats(rows: ExportRowLike[]): {
  rows: number;
  totalMinor: number;
  taxMinor: number;
  receiptsAttached: number;
  receiptsTotal: number;
  eventCount: number;
} {
  const totalMinor = rows.reduce((s, r) => s + (r.amountMinor ?? 0), 0);
  // Tax only applies to AMEX-line rows where the matched receipt carried
  // tax data. Bundle rows for CASH/DIGITAL don't include tax here because
  // this sum is a display estimate, not an accounting total.
  const taxMinor = rows.reduce((s, r) => s + (r.taxAmountMinor ?? 0), 0);
  const receiptsAttached = rows.filter(
    (r) => r.rowType === "amex_line" && (r.receiptId || r.matchStatus === "no_receipt"),
  ).length;
  const eventCount = rows.filter((r) => {
    const code = r.expenseCategoryCode ?? "";
    return code === "entertainment" || code === "meeting";
  }).length;
  return {
    rows: rows.length,
    totalMinor,
    taxMinor,
    receiptsAttached,
    receiptsTotal: rows.length,
    eventCount,
  };
}

function computeBreakdown(rows: ExportRowLike[]): CategoryBreakdownRow[] {
  const totals = new Map<string, { count: number; total: number }>();

  const bump = (code: string | null, amount: number) => {
    const key = code ?? "uncategorized";
    const existing = totals.get(key) ?? { count: 0, total: 0 };
    existing.count++;
    existing.total += amount;
    totals.set(key, existing);
  };

  for (const r of rows) bump(r.expenseCategoryCode ?? null, r.amountMinor ?? 0);

  const grand = Array.from(totals.values()).reduce(
    (s, v) => s + v.total,
    0,
  );

  return Array.from(totals.entries())
    .map(([code, v]) => ({
      code,
      label:
        code === "uncategorized"
          ? "Uncategorized"
          : getCategoryByCode(code)?.enName ?? formatCategoryLabel(code),
      count: v.count,
      totalMinor: v.total,
      pct: grand > 0 ? v.total / grand : 0,
    }))
    .sort((a, b) => b.totalMinor - a.totalMinor)
    .slice(0, 7);
}

// Minimal structural shape of ExportRow that the helpers above read. We
// import the full type via the bundle; this alias keeps the helper
// signatures self-documenting without re-listing every field.
type ExportRowLike = {
  rowType: "amex_line" | "receipt";
  receiptId: string | null;
  matchStatus: string | null;
  amountMinor: number | null;
  taxAmountMinor: number | null;
  expenseCategoryCode: string | null;
};
