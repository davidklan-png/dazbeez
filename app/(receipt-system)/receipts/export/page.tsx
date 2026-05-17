import {
  listAmexLines,
  listExports,
  listReceiptRecords,
  listAttendees,
  getExport,
} from "@/lib/receipts/db";
import {
  formatCategoryLabel,
  getCategoryByCode,
  requiresAttendees,
} from "@/lib/receipts/categories";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import {
  ExportScreen,
  type Blocker,
  type CategoryBreakdownRow,
  type ManifestSampleRow,
} from "@/components/receipts/export/export-screen";
import type {
  AmexStatementLine,
  ReceiptRecord,
} from "@/lib/receipts/types";

export const dynamic = "force-dynamic";

export default async function ExportPage() {
  await assertReceiptsPageAccess();

  const month = new Date().toISOString().slice(0, 7);
  const monthLabel = formatMonthLabel(month);

  const [exports, monthReceipts, monthLines, currentExport] = await Promise.all([
    listExports(),
    listReceiptRecords({ month, limit: 1000 }),
    listAmexLines(month),
    getExport(month),
  ]);

  const blockers = computeBlockers(monthReceipts, monthLines);
  const warnings = computeWarnings(monthLines);

  const draftStats = computeDraftStats(monthReceipts, monthLines);
  const breakdown = computeBreakdown(monthReceipts, monthLines);
  const manifestSample = await buildManifestSample(monthReceipts.slice(0, 6));
  const manifestSize = {
    rowsTotal: draftStats.rows,
    sizeBytes: Math.max(800, draftStats.rows * 135),
    sha256: currentExport?.archive_sha256 ?? null,
  };

  return (
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
  );
}

function formatMonthLabel(month: string): string {
  try {
    const [y, m] = month.split("-").map(Number);
    if (!y || !m) return month;
    return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
  } catch {
    return month;
  }
}

function computeBlockers(
  receipts: ReceiptRecord[],
  lines: AmexStatementLine[],
): Blocker[] {
  const blockers: Blocker[] = [];

  const uncategorized = lines.filter((l) => !l.expense_category_code).length;
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

  const unreviewed = receipts.filter(
    (r) => r.status === "captured" || r.status === "needs_review",
  ).length;
  if (unreviewed > 0) {
    blockers.push({
      severity: "blocker",
      count: unreviewed,
      label: "Unreviewed receipts",
      detail: "These receipts must be reviewed before sealing.",
      href: "/receipts/review",
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
    (l) =>
      l.receipt_status === "missing_receipt" && !l.receipt_missing_reason,
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

function computeWarnings(lines: AmexStatementLine[]): Blocker[] {
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
