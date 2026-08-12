import Link from "next/link";
import { ArrowRightIcon, CheckIcon, WarningIcon } from "@/components/ui/icons";
import type { MonthStage } from "@/lib/receipts/month-stage";

// The shared month-close map (docs/export-workflow-ux-plan.md §4). Renders on all
// three surfaces (export page, /review, /send) from the single server-derived
// `deriveMonthStage` — one authority, many renderers. Replaces the old export-
// page-only `Pipeline`, whose dead `stepIndex` and hardcoded `Reconcile: done`
// made it misleading, and which disappeared the moment the operator advanced a
// stage (the map was needed most on /review and /send, where it never rendered).
//
// Presentational only — no hooks, no client actions. Every destination is a
// <Link>, so this component renders identically whether a server page or the
// client ExportScreen mounts it.

function circleClass(status: MonthStage["status"]): string {
  switch (status) {
    case "done":
      return "bg-green-500 text-white";
    case "current":
      return "bg-amber-500 text-white shadow-[0_4px_12px_rgba(217,119,6,0.3)]";
    case "blocked":
      return "bg-red-500 text-white";
    default:
      return "border-[1.5px] border-gray-200 text-gray-400";
  }
}

function subFor(s: MonthStage): string {
  switch (s.key) {
    case "reconcile":
      return s.status === "done" ? "Reconciled" : "Match & sign off";
    case "draft":
      // Draft is optional (architect ruling): a preview, not a gate.
      return s.status === "done" ? "Built · preview ready" : "Optional preview";
    case "review":
      return s.status === "done" ? "Clear" : "Review the pack";
    case "finalize":
      return s.status === "done" ? "Sealed" : "Sign off";
    case "send":
      return s.status === "done" ? "Sent" : "Send to accountant";
    case "closed":
      return s.status === "done" ? "Closed · 7-year retention" : "";
  }
}

/** Advisory wording for a stage-level notice. The gate's `message_stale` prose
 *  says "Rebuild the draft before finalizing" — correct as a BLOCKER, wrong as
 *  an advisory (fix (a): it no longer blocks). Render advisory wording instead:
 *  the preview is out of date, a rebuild refreshes it. Never "blocks finalizing." */
function advisoryText(a: { code: string; message: string }): string {
  if (a.code === "message_stale") return "Preview out of date — rebuild to refresh";
  return a.message;
}

export function MonthPipeline({ stages }: { stages: MonthStage[] }) {
  return (
    <div className="flex items-stretch border-b border-gray-200 bg-white px-8 py-4">
      {stages.map((s, i) => {
        const future = s.status === "pending";
        const labelClass = [
          "text-[13px] font-semibold",
          future ? "text-gray-400" : s.status === "blocked" ? "text-red-700" : "text-gray-900",
        ].join(" ");
        const subClass = ["mt-0.5 text-[11.5px]", future ? "text-gray-400" : "text-gray-500"].join(" ");
        // Done stages are navigable back-links (the operator can return to a
        // completed stage); pending/current/blocked are inert or explanatory.
        const labelEl =
          s.status === "done" ? (
            <Link href={s.href} className={`${labelClass} hover:underline`}>
              {s.label}
            </Link>
          ) : (
            <div className={labelClass}>{s.label}</div>
          );
        return (
          <div key={s.key} className="flex flex-1 items-center gap-3">
            <div
              className={[
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold",
                circleClass(s.status),
              ].join(" ")}
            >
              {s.status === "done" ? (
                <CheckIcon size={15} className="text-white" />
              ) : s.status === "blocked" ? (
                <WarningIcon size={14} className="text-white" />
              ) : (
                i + 1
              )}
            </div>
            <div className="min-w-0">
              {labelEl}
              <div className={subClass}>{subFor(s)}</div>
              {s.status === "blocked" && s.blockers && s.blockers.length > 0 && (
                <div className="mt-0.5 text-[11px] text-red-600">{s.blockers[0].message}</div>
              )}
              {s.advisories && s.advisories.length > 0 && (
                <div className="mt-0.5 text-[11px] text-amber-700">
                  {advisoryText(s.advisories[0])}
                </div>
              )}
              {s.secondaryAction && (
                <Link
                  href={s.href}
                  className="mt-1 inline-flex items-center gap-0.5 text-[11px] font-semibold text-amber-700 hover:underline"
                >
                  {s.secondaryAction.label}
                  <ArrowRightIcon size={11} className="text-amber-700" />
                </Link>
              )}
            </div>
            {i < stages.length - 1 && <div className="ml-auto h-px w-6 self-center bg-gray-200" />}
          </div>
        );
      })}
    </div>
  );
}
