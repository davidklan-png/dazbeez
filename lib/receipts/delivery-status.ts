// Delivery status across finalized months (delivery-composer §6).
//
// Three alert surfaces — the export page banner, the dashboard banner, and the
// month-pill colours — all need to know, per finalized month, whether it is
// delivered / pending / sealed-undelivered. This is the ONE server helper they
// share so the state is computed once and cannot drift between surfaces.
//
// The state is DERIVED from the attempt history via deriveMonthDeliveryState
// (the pure consistency check), not read from the denormalised
// receipt_exports.delivery_state column — same authority the send path's
// decideSendAction trusts. A month with a finalized export and no attempt rows
// (2026-06 today) derives to NULL, which the pill maps to "undelivered" (sealed,
// never sent) — the state the composer must handle first.

import { listExports, listDeliveriesForMonth } from "@/lib/receipts/db";
import {
  deriveMonthDeliveryState,
  deliveryStateToPill,
  ATTEMPT_STATE,
  type AttemptState,
  type DeliveryState,
  type DeliveryPillState,
} from "@/lib/receipts/delivery-state";

// Re-export the pure pill mapping so alert surfaces can import it from the
// server helper alongside the month-Map; the mapping itself lives in the pure
// delivery-state module (client-safe) so the shared MonthSwitcher imports it
// directly from there.
export { deliveryStateToPill, type DeliveryPillState };

/**
 * Map<month, DeliveryState | null> for every finalized month. One row per
 * statement month (the latest finalized revision carries the month's delivery
 * state; deliveries span revisions and are read across all of them via
 * listDeliveriesForMonth). Drives the export-page banner, the dashboard banner,
 * and the month pills.
 */
export async function deriveFinalizedMonthsDeliveryState(): Promise<
  Map<string, DeliveryState | null>
> {
  const all = await listExports();
  const finalizedMonths = new Set(
    all.filter((e) => e.status === "finalized").map((e) => e.export_month),
  );
  const result = new Map<string, DeliveryState | null>();
  for (const month of finalizedMonths) {
    const deliveries = await listDeliveriesForMonth(month);
    const attempts = deliveries.map((d) => ({
      attemptId: d.attempt_id,
      // The DB column allows 'ambiguous' at runtime (markDeliveryAmbiguous);
      // the static type narrows to three values, so cast through the authority.
      state: (d.state as AttemptState) ?? ATTEMPT_STATE.PENDING,
      createdAt: d.created_at,
    }));
    result.set(month, deriveMonthDeliveryState(attempts));
  }
  return result;
}

/** A finalized month needs operator delivery action when it is NOT delivered —
 *  i.e. sealed_undelivered, pending, or never-attempted (null). Used by the
 *  dashboard banner to list every month that is not yet closed for reporting. */
export function needsDeliveryAction(
  state: DeliveryState | null | undefined,
): boolean {
  return deliveryStateToPill(state) !== "delivered";
}

export type { DeliveryState };
