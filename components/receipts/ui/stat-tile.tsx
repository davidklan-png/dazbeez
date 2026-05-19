import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

export type StatTileProps = {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Show the value in amber to signal something needs attention. */
  accent?: boolean;
};

/**
 * A small "metric" card used across the receipts dashboard, AMEX page,
 * export and reconcile screens. Replaces the previously-duplicated
 * `StatTile` / `Stat` definitions in each page.
 */
export function StatTile({ label, value, sub, accent }: StatTileProps) {
  return (
    <Card>
      <div className="text-[11px] font-bold uppercase tracking-[0.05em] text-gray-500">
        {label}
      </div>
      <div
        className={[
          "mt-1.5 text-[26px] font-bold tabular-nums",
          accent ? "text-amber-700" : "text-gray-900",
        ].join(" ")}
      >
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-[12px] text-gray-500">{sub}</div> : null}
    </Card>
  );
}
