import type { ComplianceSummary } from "@/lib/receipts/compliance";

type Props = {
  month: string;
  summary: ComplianceSummary;
};

const TYPE_LABELS: Record<string, string> = {
  missing_transaction_date: "Missing transaction date",
  missing_amount: "Missing amount",
  missing_counterparty: "Missing counterparty",
  missing_category: "Missing category",
  missing_receipt: "Missing receipt",
  missing_attendees: "Missing attendees",
  missing_invoice_registration_number: "Missing invoice number",
  invoice_registration_invalid: "Invalid invoice number",
  missing_tax_rate: "Missing tax rate",
  missing_tax_amount: "Missing tax amount",
  electronic_transaction_missing_original: "Electronic transaction warning",
  scanner_preservation_metadata_incomplete: "Scanner preservation incomplete",
  export_blocker: "Export blocker",
};

export function ComplianceSummaryCards({ month, summary }: Props) {
  const topTypes = Object.entries(summary.byType)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4);

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <header className="mb-4 flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">
            Compliance summary
          </h3>
          <p className="text-xs text-gray-500">For receipts in {month}</p>
        </div>
        <a
          href={`/api/receipts/compliance/${month}`}
          className="text-xs text-amber-700 hover:underline"
        >
          View JSON →
        </a>
      </header>

      <div className="grid grid-cols-3 gap-3">
        <Card label="Blockers" count={summary.blockers} tone="red" />
        <Card label="Warnings" count={summary.warnings} tone="amber" />
        <Card label="Info" count={summary.info} tone="gray" />
      </div>

      {topTypes.length > 0 ? (
        <ul className="mt-4 space-y-1 text-xs text-gray-700">
          {topTypes.map(([type, count]) => (
            <li key={type} className="flex justify-between">
              <span>{TYPE_LABELS[type] ?? type}</span>
              <span className="font-mono">{count}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-xs text-gray-500">No open issues for this month.</p>
      )}
    </section>
  );
}

function Card({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "red" | "amber" | "gray";
}) {
  const palette = {
    red: "bg-red-50 text-red-900",
    amber: "bg-amber-50 text-amber-900",
    gray: "bg-gray-50 text-gray-700",
  }[tone];
  return (
    <div className={`rounded-xl px-3 py-2 ${palette}`}>
      <div className="text-xs">{label}</div>
      <div className="text-2xl font-bold">{count}</div>
    </div>
  );
}
