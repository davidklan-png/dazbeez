import {
  listAmexLines,
  listExports,
  getExport,
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
import type { ManifestSampleRow } from "@/lib/receipts/manifest-preview";
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
import { buildMonthlyExportCsv } from "@/lib/receipts/export";
import { deriveStatementWindow } from "@/lib/receipts/statement-window";

export const dynamic = "force-dynamic";

// The four artifacts finalize seals in RECEIPTS_ARCHIVE_BUCKET, served by
// GET /api/receipts/export/[month]/download (Content-Disposition: attachment,
// so plain anchors download without any client-side code).
const BUNDLE_DOWNLOAD_LINKS = [
  { file: "receipts", label: "Receipts CSV" },
  { file: "manifest", label: "Manifest" },
  { file: "summary", label: "Summary" },
  { file: "readme", label: "README" },
  { file: "proofs", label: "領収書ZIP" },
] as const;

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

  const [lineCountsByMonth, reconciliationStatusByMonth] = await Promise.all([
    listAmexLineCountsByMonth(),
    listReconciliationStatusByMonth(),
  ]);

  const availableMonths: MonthOption[] = [...lineCountsByMonth.entries()]
    .map(([optionMonth, counts]) => ({
      month: optionMonth,
      lineCount: counts.total,
      unmatchedCount: counts.unmatched,
      status: reconciliationStatusByMonth.get(optionMonth) ?? null,
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
  const [bundle, exports, unknownInScope, monthLines, currentExport, unassignable] =
    await Promise.all([
      buildExportBundle(month),
      listExports(),
      listUnknownInScopeReceipts(month),
      listAmexLines(month),
      getExport(month),
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
  // Statement window (transaction-date range the statement covers) for the
  // manifest-preview header — the operator conflated 2026-06 and 2026-07 rows
  // partly because the preview didn't restate which month/dates it belongs to.
  const statementWindow =
    monthLines.length > 0 ? deriveStatementWindow(monthLines, month) : null;

  const draftStats = computeDraftStats(bundle.rows);
  const breakdown = computeBreakdown(bundle.rows);
  const manifestSample = buildManifestSample(bundle.rows.slice(0, 6));
  // Honest CSV size: build the pure CSV (same call the route makes before
  // applying BOM/CRLF) and measure its UTF-8 byte length. BOM+CRLF add a
  // small constant overhead we ignore — the operator only needs a ballpark.
  const pureCsv = buildMonthlyExportCsv(bundle.rows, bundle.attendeeMap);
  const manifestSize = {
    rowsTotal: draftStats.rows,
    sizeBytes: new TextEncoder().encode(pureCsv).byteLength,
    sha256: currentExport?.archive_sha256 ?? null,
  };

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
        manifestSample={manifestSample}
        manifestSize={manifestSize}
        statementWindow={statementWindow}
        unassignableReceipts={unassignable}
      />
      {currentExport?.status === "finalized" && (
        <div className="border-t border-gray-200 bg-white px-8 py-6">
          <h2 className="text-sm font-bold text-gray-900">Download bundle</h2>
          <p className="mt-1 text-xs text-gray-500">
            Finalized {monthLabel} archive files, served byte-for-byte as
            sealed in R2 — SHA-256 hashes match the manifest.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            {BUNDLE_DOWNLOAD_LINKS.map(({ file, label }) => (
              <a
                key={file}
                href={`/api/receipts/export/${month}/download?file=${file}`}
                className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100"
              >
                {label}
              </a>
            ))}
          </div>
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

/**
 * Build the manifest preview rows from bundle rows. Audit A6: the previous
 * implementation fired a `listAttendees` call per receipt just to "keep the
 * query path warm" (its own comment) — pure N+1 waste. Attendees are now
 * batched once in buildExportBundle (listAttendeeNamesByReceiptIds).
 */
function buildManifestSample(rows: ExportRowLike[]): ManifestSampleRow[] {
  return rows.map((r) => {
    const cat = r.expenseCategoryCode
      ? getCategoryByCode(r.expenseCategoryCode)
      : null;
    return {
      receiptId: r.receiptId ? `R-${r.receiptId.slice(0, 8)}` : "—",
      merchant: r.merchant ?? "(unnamed)",
      txnDate: r.transactionDate ?? "—",
      amountMinor: r.amountMinor ?? 0,
      categoryLabel: cat?.jaName ?? r.expenseCategoryCode ?? "—",
      payment: r.paymentPath ?? "—",
      alcohol: false,
      archivePath: r.originalR2Key
        ? `r2://.../${r.originalR2Key.slice(-12)}`
        : "—",
      invoiceRegistrationNumber: r.invoiceRegistrationNumber ?? "",
    };
  });
}

// Minimal structural shape of ExportRow that the helpers above read. We
// import the full type via the bundle; this alias keeps the helper
// signatures self-documenting without re-listing every field.
type ExportRowLike = {
  rowType: "amex_line" | "receipt";
  receiptId: string | null;
  transactionDate: string | null;
  merchant: string | null;
  amountMinor: number | null;
  expenseCategoryCode: string | null;
  paymentPath: string | null;
  matchStatus: string | null;
  taxAmountMinor: number | null;
  originalR2Key: string | null;
  invoiceRegistrationNumber: string | null;
};
