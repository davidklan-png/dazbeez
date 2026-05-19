import type { ComplianceCheck } from "@/lib/receipts/types";

const SEVERITY_STYLE: Record<string, string> = {
  blocker: "bg-red-50 text-red-900 border-red-200",
  warning: "bg-amber-50 text-amber-900 border-amber-200",
  info: "bg-gray-50 text-gray-700 border-gray-200",
};

const SEVERITY_LABEL: Record<string, string> = {
  blocker: "BLOCKER",
  warning: "WARNING",
  info: "INFO",
};

type Props = {
  checks: ComplianceCheck[];
};

export function CompliancePanel({ checks }: Props) {
  const open = checks.filter((c) => c.status === "open");
  const resolved = checks.filter((c) => c.status === "resolved");

  const blockerCount = open.filter((c) => c.severity === "blocker").length;
  const warningCount = open.filter((c) => c.severity === "warning").length;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <header className="border-b border-gray-100 px-5 py-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">
            Compliance status
          </h3>
          <div className="flex gap-2 text-xs">
            <span className="rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-800">
              {blockerCount} blocker{blockerCount === 1 ? "" : "s"}
            </span>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-900">
              {warningCount} warning{warningCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          Preparation materials for accountant review. Dazbeez does not provide
          tax advice or make final tax determinations.
        </p>
      </header>

      {open.length === 0 ? (
        <div className="px-5 py-6 text-sm text-gray-500">
          No open compliance issues for this receipt.
        </div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {open.map((c) => (
            <li
              key={c.id}
              className={`border-l-4 px-5 py-3 text-sm ${SEVERITY_STYLE[c.severity] ?? SEVERITY_STYLE.info}`}
            >
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] font-bold tracking-wider">
                  {SEVERITY_LABEL[c.severity] ?? c.severity.toUpperCase()}
                </span>
                <span className="font-mono text-[11px] text-gray-600">
                  {c.check_type}
                </span>
              </div>
              <p className="mt-1">{c.message}</p>
            </li>
          ))}
        </ul>
      )}

      {resolved.length > 0 ? (
        <details className="border-t border-gray-100 px-5 py-3 text-xs text-gray-500">
          <summary className="cursor-pointer select-none">
            {resolved.length} resolved check{resolved.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 space-y-1">
            {resolved.map((c) => (
              <li key={c.id} className="font-mono text-[11px]">
                ✓ {c.check_type}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
