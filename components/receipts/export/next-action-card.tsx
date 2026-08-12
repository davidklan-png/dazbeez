import Link from "next/link";
import { ArrowRightIcon } from "@/components/ui/icons";
import { Card } from "@/components/ui/card";
import type { MonthStage } from "@/lib/receipts/month-stage";

// The single primary action for the current stage, in ONE fixed position
// (directly under the pipeline) on all three surfaces (docs/export-workflow-ux-
// plan.md §2/§4). Replaces the four-location next-action sprawl (TopBar build
// button, right-rail ReviewLinkCard, the finalize page, the bottom delivery
// banner) with exactly one button the operator's eye lands on every time.
//
// The active stage is the derived current/blocked stage. When blocked, the
// blocker reasons are named and the action links to the page that clears them.
// A closed (delivered) month has no active stage ⇒ the card renders nothing.
//
// Presentational only — the action is always a <Link> to the stage's href.

function headingFor(s: MonthStage): string {
  switch (s.key) {
    case "reconcile":
      return "Reconcile the statement";
    case "draft":
      return "Draft is optional";
    case "review":
      return "Review the pack";
    case "finalize":
      return "Finalize the month";
    case "send":
      return "Send to the accountant";
    case "closed":
      return "Closed";
  }
}

export function NextActionCard({ stages }: { stages: MonthStage[] }) {
  const active = stages.find((s) => s.status === "current" || s.status === "blocked");
  // A delivered month has no active stage and no primary action — the pipeline's
  // all-green Closed stage is the signal. Render nothing so the card's slot stays
  // consistent (same position, nothing there) rather than a stale CTA.
  if (!active || !active.primaryAction) return null;

  const blocked = active.status === "blocked";
  const blockers = active.blockers ?? [];

  return (
    <div className="mx-8 mt-4">
      <Card pad={0} className="overflow-hidden">
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-gray-900">{headingFor(active)}</div>
            {blocked ? (
              <ul className="mt-1.5 space-y-0.5 text-[12px] text-red-700">
                {blockers.map((b, i) => (
                  <li key={`${b.code}-${i}`}>• {b.message}</li>
                ))}
              </ul>
            ) : (
              <div className="mt-0.5 text-[11.5px] text-gray-500">{active.primaryAction.label}</div>
            )}
          </div>
          <Link
            href={active.href}
            className={[
              "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-[13px] font-semibold",
              blocked
                ? "bg-gray-900 text-white hover:bg-gray-800"
                : "bg-amber-500 text-white hover:bg-amber-600",
            ].join(" ")}
          >
            {active.primaryAction.label}
            <ArrowRightIcon size={14} className="text-white" />
          </Link>
        </div>
      </Card>
    </div>
  );
}
