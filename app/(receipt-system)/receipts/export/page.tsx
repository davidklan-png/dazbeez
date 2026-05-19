import {
  listAmexLines,
  listExports,
  listReceiptRecords,
  listAttendees,
  getExport,
  listAmexLineCountsByMonth,
  listReconciliationStatusByMonth,
} from "@/lib/receipts/db";
import {
  formatCategoryLabel,
  getCategoryByCode,
} from "@/lib/receipts/categories";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import {
  ExportScreen,
  type CategoryBreakdownRow,
  type ManifestSampleRow,
} from "@/components/receipts/export/export-screen";
import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";
import { MonthSwitcher, type MonthOption } from "@/components/receipts/month-switcher";
import { formatMonth } from "@/lib/receipts/format";
import {
  computeExportBlockers,
  computeExportWarnings,
} from "@/lib/receipts/blockers";
import {
  ACCOUNTANT_DISCLAIMER_EN,
  ACCOUNTANT_DISCLAIMER_JA,
} from "@/lib/receipts/settings";

export const dynamic = "force-dynamic";

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

  const [exports, monthReceipts, monthLines, currentExport] = await Promise.all([
    listExports(),
    listReceiptRecords({ month, limit: 1000 }),
    listAmexLines(month),
    getExport(month),
  ]);

  const blockers = computeExportBlockers(monthReceipts, monthLines);
  const warnings = computeExportWarnings(monthLines);

  const draftStats = computeDraftStats(monthReceipts, monthLines);
  const breakdown = computeBreakdown(monthReceipts, monthLines);
  const manifestSample = await buildManifestSample(monthReceipts.slice(0, 6));
  const manifestSize = {
    rowsTotal: draftStats.rows,
    sizeBytes: Math.max(800, draftStats.rows * 135),
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
      />
      <div className="border-t border-amber-100 bg-amber-50 px-8 py-4 text-xs text-amber-900">
        <p className="font-semibold">Accountant review boundary</p>
        <p className="mt-1">{ACCOUNTANT_DISCLAIMER_EN}</p>
        <p className="mt-2">{ACCOUNTANT_DISCLAIMER_JA}</p>
      </div>
    </>
  );
}

function computeDraftStats(
  receipts: ReceiptRecord[],
  lines: AmexStatementLine[],
) {
  const rows = receipts.length + lines.length;
  const totalMinor =
    receipts.reduce((s, r) => s + (r.amount_minor ?? 0), 0) +
    lines.reduce((s, l) => s + l.amount_minor, 0);
  const taxMinor = receipts.reduce(
    (s, r) => s + (r.tax_amount_minor ?? 0),
    0,
  );
  const receiptsAttached = lines.filter(
    (l) => l.matched_receipt_id || l.match_status === "no_receipt",
  ).length;
  return {
    rows,
    totalMinor,
    taxMinor,
    receiptsAttached: receipts.length + receiptsAttached,
    receiptsTotal: rows,
    attendeesLogged: 0, // populated below per-month if cheap
    eventCount: receipts.filter((r) =>
      ["entertainment", "meeting"].includes(r.expense_category_code ?? ""),
    ).length,
  };
}

function computeBreakdown(
  receipts: ReceiptRecord[],
  lines: AmexStatementLine[],
): CategoryBreakdownRow[] {
  const totals = new Map<string, { count: number; total: number }>();

  const bump = (code: string | null, amount: number) => {
    const key = code ?? "uncategorized";
    const existing = totals.get(key) ?? { count: 0, total: 0 };
    existing.count++;
    existing.total += amount;
    totals.set(key, existing);
  };

  for (const r of receipts) bump(r.expense_category_code, r.amount_minor ?? 0);
  for (const l of lines) bump(l.expense_category_code, l.amount_minor);

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

async function buildManifestSample(
  receipts: ReceiptRecord[],
): Promise<ManifestSampleRow[]> {
  // Compute manifest rows for the first 6 receipts. Attendees aren't needed
  // for the preview but keep one query path warm for parity with export.ts.
  return Promise.all(
    receipts.map(async (r) => {
      await listAttendees(r.id);
      const cat = r.expense_category_code
        ? getCategoryByCode(r.expense_category_code)
        : null;
      return {
        receiptId: `R-${r.id.slice(0, 8)}`,
        merchant: r.merchant ?? "(unnamed)",
        txnDate: r.transaction_date ?? r.captured_at.slice(0, 10),
        amountMinor: r.amount_minor ?? 0,
        categoryLabel: cat?.jaName ?? r.expense_category_code ?? "—",
        payment: r.payment_path,
        cardLast4: r.payment_path === "AMEX" ? "3091" : "",
        alcohol: Boolean(r.alcohol_present),
        archivePath: `r2://.../${r.id.slice(0, 8)}.jpg`,
      };
    }),
  );
}
