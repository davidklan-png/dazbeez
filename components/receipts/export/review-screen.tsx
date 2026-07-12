import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import {
  formatAmountMinor,
  formatPaymentPath,
} from "@/lib/receipts/format";
import { formatCategoryLabel } from "@/lib/receipts/categories";
import type { Blocker } from "@/lib/receipts/blockers";
import type {
  AmexStatementLine,
  BusinessTripReport,
  ExportRow,
  ReceiptExport,
  ReceiptRecord,
} from "@/lib/receipts/types";
import type { StatementWindow } from "@/lib/receipts/statement-window";

export interface ReviewScreenProps {
  month: string;
  monthLabel: string;
  window: StatementWindow | null;
  rows: ExportRow[];
  /** bundle.receipts — ID-fetched matched receipts, for side-by-side lookup. */
  receipts: ReceiptRecord[];
  currentExport: ReceiptExport | null;
  reconciliationSealed: boolean;
  gateBlockers: string[];
  tileBlockers: Blocker[];
  warnings: Blocker[];
  tripReports: BusinessTripReport[];
  tripLines: Map<string, AmexStatementLine[]>;
}

export function ReviewScreen(props: ReviewScreenProps) {
  const finalized = props.currentExport?.status === "finalized";
  const amexRows = props.rows.filter((r) => r.rowType === "amex_line");
  const chargeRows = props.rows.filter((r) => r.rowType === "receipt");
  const gateClear = props.gateBlockers.length === 0;

  return (
    <div className="bg-gray-50 pb-16">
      <ReviewHeader
        monthLabel={props.monthLabel}
        month={props.month}
        window={props.window}
        rowCount={props.rows.length}
        lineCount={amexRows.length}
        chargeCount={chargeRows.length}
        finalized={finalized}
        gateClear={gateClear}
        reconciliationSealed={props.reconciliationSealed}
      />

      {/* Gate verdict — the authoritative blocker list from
        validateMonthReadyForExport. The tile (computeExportBlockers) is shown
        for parity; the gate is what finalize actually enforces. */}
      <GateVerdict
        gateBlockers={props.gateBlockers}
        tileBlockers={props.tileBlockers}
        warnings={props.warnings}
        finalized={finalized}
      />

      <div className="space-y-8 px-8 py-8">
        <SummarySection rows={props.rows} receipts={props.receipts} />
        <SideBySideSection amexRows={amexRows} receipts={props.receipts} />
        <AdditionalChargesSection chargeRows={chargeRows} />
        <BusinessTripsSection
          tripReports={props.tripReports}
          tripLines={props.tripLines}
          candidateRows={amexRows.filter(
            (r) => r.businessTripStatus === "candidate",
          )}
        />
      </div>
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────

function ReviewHeader({
  monthLabel,
  month,
  window,
  rowCount,
  lineCount,
  chargeCount,
  finalized,
  gateClear,
  reconciliationSealed,
}: {
  monthLabel: string;
  month: string;
  window: StatementWindow | null;
  rowCount: number;
  lineCount: number;
  chargeCount: number;
  finalized: boolean;
  gateClear: boolean;
  reconciliationSealed: boolean;
}) {
  const windowLabel =
    window && window.start && window.end
      ? `${window.start.slice(0, 10)} – ${window.end.slice(0, 10)}`
      : "—";
  return (
    <div className="border-b border-gray-200 bg-white px-8 py-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={`/receipts/export?month=${month}`}
          className="text-xs font-semibold text-amber-600 hover:underline"
        >
          ← Export
        </Link>
        <h1 className="text-[17px] font-bold text-gray-900">
          {monthLabel} pre-finalize review
        </h1>
        {finalized ? (
          <Pill tone="green" size="sm" dot>
            Sealed
          </Pill>
        ) : gateClear ? (
          <Pill tone="green" size="sm" dot>
            Clear to finalize
          </Pill>
        ) : (
          <Pill tone="red" size="sm" dot>
            {lineCount + chargeCount > 0 ? "Blocked" : "Empty"}
          </Pill>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-gray-500">
        <span>
          Statement window: <span className="font-medium text-gray-700">{windowLabel}</span>
        </span>
        <span>
          Rows: <span className="font-medium text-gray-700">{rowCount}</span> ({lineCount} AMEX ·{" "}
          {chargeCount} cash/digital)
        </span>
        <span>
          Reconciliation:{" "}
          <span className="font-medium text-gray-700">
            {reconciliationSealed ? "sealed" : "open"}
          </span>
        </span>
      </div>
    </div>
  );
}

// ─── Gate verdict ─────────────────────────────────────────────────────────

function GateVerdict({
  gateBlockers,
  tileBlockers,
  warnings,
  finalized,
}: {
  gateBlockers: string[];
  tileBlockers: Blocker[];
  warnings: Blocker[];
  finalized: boolean;
}) {
  if (finalized) return null;
  if (gateBlockers.length === 0 && warnings.length === 0) {
    return (
      <div className="mx-8 mt-6 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
        <b>Gate: clear.</b> No blockers from <code>validateMonthReadyForExport</code>. Review the
        sections below, then finalize at the bottom of this page.
      </div>
    );
  }
  return (
    <div className="mx-8 mt-6 space-y-2">
      {gateBlockers.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <b>Finalize gate blockers ({gateBlockers.length})</b> — from{" "}
          <code>validateMonthReadyForExport</code>:
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[12.5px]">
            {gateBlockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12.5px] text-amber-800">
          <b>Warnings ({warnings.reduce((s, w) => s + w.count, 0)}):</b>{" "}
          {warnings.map((w) => `${w.label} (${w.count})`).join("; ")}
        </div>
      )}
      {/* Tile parity: if the tile (computeExportBlockers) disagrees with the
        gate, surface it so the drift is visible. */}
      {tileBlockers.length > 0 && (
        <div className="text-[11px] text-gray-400">
          Tile reports {tileBlockers.reduce((s, b) => s + b.count, 0)} blocker(s):{" "}
          {tileBlockers.map((b) => `${b.label} (${b.count})`).join("; ")}
        </div>
      )}
    </div>
  );
}

// ─── Section 1: Summary ───────────────────────────────────────────────────

function SummarySection({
  rows,
  receipts,
}: {
  rows: ExportRow[];
  receipts: ReceiptRecord[];
}) {
  const totalMinor = rows.reduce((s, r) => s + (r.amountMinor ?? 0), 0);
  const taxMinor = rows.reduce((s, r) => s + (r.taxAmountMinor ?? 0), 0);

  const byCategory = groupSum(rows, (r) => r.expenseCategoryCode ?? "uncategorized");
  const byPayment = groupSum(rows, (r) => r.paymentPath);
  const byTaxRate = groupSum(rows, (r) => r.taxRate ?? "—");

  const noReceiptLines = rows.filter(
    (r) =>
      r.rowType === "amex_line" &&
      (r.receiptStatus === "missing_receipt" || !r.receiptId),
  );

  const withTin = receipts.filter((r) => r.invoice_registration_number).length;

  return (
    <Card pad={20}>
      <SectionTitle title="Summary" sub="Totals and coverage for everything that ships" />
      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Kpi label="Rows" value={String(rows.length)} />
        <Kpi label="Total" value={formatAmountMinor(totalMinor)} sub={`incl. ${formatAmountMinor(taxMinor)} tax`} />
        <Kpi label="No-receipt lines" value={String(noReceiptLines.length)} />
        <Kpi
          label="T-number coverage"
          value={`${withTin} / ${receipts.length}`}
          sub="receipts with a registration number"
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        <BreakdownTable title="By expense category" groups={byCategory} renderKey={formatCategoryLabel} />
        <BreakdownTable title="By payment path" groups={byPayment} renderKey={(k) => formatPaymentPath(k)} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        <BreakdownTable title="By tax rate" groups={byTaxRate} renderKey={(k) => (k === "—" ? "—" : k)} />
        <div>
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            No-receipt lines ({noReceiptLines.length})
          </div>
          {noReceiptLines.length === 0 ? (
            <p className="text-[12.5px] text-gray-400">Every AMEX line has a receipt or a recorded reason.</p>
          ) : (
            <ul className="space-y-1 text-[12.5px] text-gray-700">
              {noReceiptLines.slice(0, 12).map((r, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="truncate">
                    {r.transactionDate} · {r.merchant}
                  </span>
                  <span className="shrink-0 text-gray-400">{r.missingReceiptReason ?? "no reason"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

// ─── Section 2: Side-by-side reconciliation ───────────────────────────────

function SideBySideSection({
  amexRows,
  receipts,
}: {
  amexRows: ExportRow[];
  receipts: ReceiptRecord[];
}) {
  const receiptMap = new Map(receipts.map((r) => [r.id, r]));
  // Group by receiptId to render consolidated-receipt groups together.
  const groups = new Map<string, ExportRow[]>();
  const standalone: ExportRow[] = [];
  for (const row of amexRows) {
    const rid = row.receiptId;
    if (rid) {
      const g = groups.get(rid) ?? [];
      g.push(row);
      groups.set(rid, g);
    } else {
      standalone.push(row);
    }
  }
  const consolidated = [...groups.entries()].filter(([, g]) => g.length >= 2);
  const singleMatched = [...groups.entries()].filter(([, g]) => g.length === 1);

  return (
    <div>
      <SectionTitle
        title="Side-by-side reconciliation"
        sub="One row per statement line — AMEX charge vs matched receipt"
      />
      <Card pad={0}>
        <div className="grid grid-cols-[1fr_1fr_120px] border-b border-gray-150 bg-gray-50 px-4 py-2 text-[10.5px] font-bold uppercase tracking-[0.05em] text-gray-500">
          <span>AMEX line</span>
          <span>Matched receipt</span>
          <span className="text-right">Delta</span>
        </div>
        {amexRows.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12.5px] text-gray-400">
            No AMEX lines for this month.
          </div>
        ) : (
          <>
            {consolidated.map(([rid, g]) => (
              <ConsolidatedGroup key={rid} receiptId={rid} rows={g} receipt={receiptMap.get(rid)} />
            ))}
            {singleMatched.map(([rid, g]) => (
              <SideBySideRow key={rid} row={g[0]!} receipt={receiptMap.get(rid)} />
            ))}
            {standalone.map((row, i) => (
              <SideBySideRow key={`none-${i}`} row={row} receipt={undefined} />
            ))}
          </>
        )}
      </Card>
      <p className="mt-2 text-[11px] text-gray-400">
        {consolidated.length} consolidated group(s) · {singleMatched.length} matched ·{" "}
        {standalone.length} no-receipt
      </p>
    </div>
  );
}

function SideBySideRow({
  row,
  receipt,
}: {
  row: ExportRow;
  receipt: ReceiptRecord | undefined;
}) {
  const amountDelta =
    receipt && receipt.amount_minor !== null && receipt.amount_minor !== row.amountMinor;
  const dateDelta =
    receipt && receipt.transaction_date && receipt.transaction_date !== row.transactionDate;
  const merchantDelta =
    receipt && receipt.merchant && receipt.merchant !== row.merchant;
  const anyDelta = amountDelta || dateDelta || merchantDelta;

  return (
    <div className="grid grid-cols-[1fr_1fr_120px] items-start border-b border-gray-150 px-4 py-2.5 text-[12px]">
      <div className="pr-3">
        <div className="font-medium text-gray-900">{row.merchant ?? "—"}</div>
        <div className="text-[11px] text-gray-500">
          {row.transactionDate} · {formatAmountMinor(row.amountMinor ?? 0, row.currency)}
        </div>
      </div>
      <div className="pr-3">
        {receipt ? (
          <>
            <div className={merchantDelta ? "font-medium text-amber-700" : "font-medium text-gray-900"}>
              {receipt.merchant ?? "—"}
            </div>
            <div className="text-[11px] text-gray-500">
              <span className={dateDelta ? "text-amber-700" : ""}>{receipt.transaction_date}</span> ·{" "}
              <span className={amountDelta ? "text-amber-700" : ""}>
                {formatAmountMinor(receipt.amount_minor ?? 0, receipt.currency)}
              </span>{" "}
              <span className="font-mono text-gray-400">R-{receipt.id.slice(0, 8)}</span>
            </div>
          </>
        ) : (
          <div className="text-[11.5px] text-gray-400">
            {row.missingReceiptReason ?? "no receipt"}
          </div>
        )}
      </div>
      <div className="text-right text-[11px]">
        {anyDelta ? (
          <Pill tone="amber" size="sm">
            differs
          </Pill>
        ) : receipt ? (
          <Pill tone="green" size="sm">
            match
          </Pill>
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </div>
    </div>
  );
}

function ConsolidatedGroup({
  receiptId,
  rows,
  receipt,
}: {
  receiptId: string;
  rows: ExportRow[];
  receipt: ReceiptRecord | undefined;
}) {
  const lineSum = rows.reduce((s, r) => s + (r.amountMinor ?? 0), 0);
  const balanced = receipt && receipt.amount_minor !== null && receipt.amount_minor === lineSum;
  return (
    <div className="border-b border-gray-150 bg-amber-50/40">
      <div className="flex items-center justify-between px-4 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.05em] text-amber-700">
        <span>
          Consolidated receipt · R-{receiptId.slice(0, 8)} · {rows.length} lines
        </span>
        <span>
          Lines sum {formatAmountMinor(lineSum)} · receipt{" "}
          {receipt ? formatAmountMinor(receipt.amount_minor ?? 0, receipt.currency) : "—"}{" "}
          {balanced ? "✓" : "✗"}
        </span>
      </div>
      {rows.map((row, i) => (
        <SideBySideRow key={i} row={row} receipt={i === 0 ? receipt : undefined} />
      ))}
    </div>
  );
}

// ─── Section 3: Additional charges (CASH/DIGITAL) ────────────────────────

function AdditionalChargesSection({ chargeRows }: { chargeRows: ExportRow[] }) {
  return (
    <div>
      <SectionTitle
        title="Additional charges"
        sub="Non-AMEX receipts (cash/digital) that ship in the export"
      />
      <Card pad={0}>
        <div className="grid grid-cols-[120px_1fr_120px_140px_100px] border-b border-gray-150 bg-gray-50 px-4 py-2 text-[10.5px] font-bold uppercase tracking-[0.05em] text-gray-500">
          <span>Date</span>
          <span>Merchant</span>
          <span className="text-right">Amount</span>
          <span>Category</span>
          <span>Payment</span>
        </div>
        {chargeRows.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12.5px] text-gray-400">
            No cash/digital receipts for this month.
          </div>
        ) : (
          chargeRows.map((r, i) => (
            <div
              key={i}
              className="grid grid-cols-[120px_1fr_120px_140px_100px] items-center border-b border-gray-150 px-4 py-2.5 text-[12px]"
            >
              <span className="text-gray-600">{r.transactionDate ?? "—"}</span>
              <span className="truncate font-medium text-gray-900">{r.merchant ?? "—"}</span>
              <span className="text-right tabular-nums">
                {formatAmountMinor(r.amountMinor ?? 0, r.currency)}
              </span>
              <span className="text-gray-600">{formatCategoryLabel(r.expenseCategoryCode)}</span>
              <span>
                <Pill tone="gray" size="sm">
                  {formatPaymentPath(r.paymentPath)}
                </Pill>
              </span>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

// ─── Section 4: Business trips ────────────────────────────────────────────

function BusinessTripsSection({
  tripReports,
  tripLines,
  candidateRows,
}: {
  tripReports: BusinessTripReport[];
  tripLines: Map<string, AmexStatementLine[]>;
  candidateRows: ExportRow[];
}) {
  return (
    <div>
      <SectionTitle
        title="Business trips"
        sub="Trip reports overlapping this statement window"
      />
      {candidateRows.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12.5px] text-amber-800">
          <b>{candidateRows.length} unresolved business-trip candidate line(s)</b> — these block
          finalize (gate 4). Confirm or dismiss the trip cluster in Reconcile.
        </div>
      )}
      {tripReports.length === 0 ? (
        <Card pad={20}>
          <p className="text-[12.5px] text-gray-400">
            No business trip reports for this month.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {tripReports.map((trip) => {
            const lines = tripLines.get(trip.id) ?? [];
            const total = lines.reduce((s, l) => s + (l.amount_minor ?? 0), 0);
            return (
              <Card key={trip.id} pad={20}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <span className="text-[13.5px] font-semibold text-gray-900">
                      {trip.trip_name ?? trip.primary_location ?? "Untitled trip"}
                    </span>
                    <span className="ml-2 text-[11.5px] text-gray-500">
                      {trip.start_date} – {trip.end_date}
                      {trip.primary_location ? ` · ${trip.primary_location}` : ""}
                    </span>
                  </div>
                  <Pill tone={trip.status === "confirmed" ? "green" : "amber"} size="sm">
                    {trip.status}
                  </Pill>
                </div>
                {trip.purpose && (
                  <p className="mt-1 text-[12px] text-gray-500">{trip.purpose}</p>
                )}
                <div className="mt-3">
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
                    Linked lines ({lines.length}) · {formatAmountMinor(total)}
                  </div>
                  {lines.length === 0 ? (
                    <p className="text-[12px] text-gray-400">No linked AMEX lines.</p>
                  ) : (
                    <ul className="space-y-0.5 text-[12px] text-gray-700">
                      {lines.map((l) => (
                        <li key={l.id} className="flex justify-between gap-3">
                          <span className="truncate">
                            {l.transaction_date} · {l.merchant}
                          </span>
                          <span className="shrink-0 tabular-nums text-gray-500">
                            {formatAmountMinor(l.amount_minor, l.currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────────

function SectionTitle({ title, sub }: { title: string; sub: string }) {
  return (
    <div>
      <h2 className="text-[15px] font-bold text-gray-900">{title}</h2>
      <p className="mt-0.5 text-[12px] text-gray-500">{sub}</p>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-gray-150 bg-white px-4 py-3">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        {label}
      </div>
      <div className="mt-1 text-[18px] font-bold tabular-nums text-gray-900">{value}</div>
      {sub && <div className="text-[10.5px] text-gray-400">{sub}</div>}
    </div>
  );
}

function BreakdownTable({
  title,
  groups,
  renderKey,
}: {
  title: string;
  groups: Map<string, { count: number; total: number }>;
  renderKey: (k: string) => string;
}) {
  const entries = [...groups.entries()].sort((a, b) => b[1].total - a[1].total);
  return (
    <div>
      <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        {title}
      </div>
      {entries.length === 0 ? (
        <p className="text-[12.5px] text-gray-400">—</p>
      ) : (
        <div className="space-y-1">
          {entries.map(([k, v]) => (
            <div key={k} className="flex justify-between text-[12.5px]">
              <span className="text-gray-700">{renderKey(k)}</span>
              <span className="tabular-nums text-gray-500">
                {v.count} · {formatAmountMinor(v.total)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function groupSum(
  rows: ExportRow[],
  keyFn: (r: ExportRow) => string,
): Map<string, { count: number; total: number }> {
  const m = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    const k = keyFn(r);
    const e = m.get(k) ?? { count: 0, total: 0 };
    e.count++;
    e.total += r.amountMinor ?? 0;
    m.set(k, e);
  }
  return m;
}
