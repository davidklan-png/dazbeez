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
import { deliveryStateToPill, type DeliveryState, type DeliveryPillState } from "./delivery-state";
import { finalizedMonthsDeliveryState } from "./delivery-status-core";
export { needsDeliveryAction } from "./delivery-status-core";

// Re-export the pure pill mapping so alert surfaces can import it from the
// server helper alongside the month-Map; the mapping itself lives in the pure
// delivery-state module (client-safe) so the shared MonthSwitcher imports it
// directly from there.
export { deliveryStateToPill, type DeliveryPillState };

/**
 * Map<month, DeliveryState | null> for every finalized month. SCOPED TO THE
 * LATEST FINALIZED REVISION: only that revision's attempt rows feed
 * {@link deriveMonthDeliveryState}. Drives the export-page banner, the dashboard
 * banner, and the month pills.
 *
 * Revision-scoping is the whole point. A month whose earlier revision was
 * delivered but whose current (sealed, corrected) revision is unsent must read
 * as action-needed, not green — the operator still owes the accountant the
 * corrected pack. Reading deliveries month-wide (the old behaviour) painted
 * such a month `delivered` off the superseded revision's `sent`. Same authority
 * the send path's {@link decideSendAction} trusts: state is a property of the
 * latest finalized revision, not of the month in aggregate.
 */
export async function deriveFinalizedMonthsDeliveryState(): Promise<
  Map<string, DeliveryState | null>
> {
  const all = await listExports();
  const months = [...new Set(all.filter((e) => e.status === "finalized").map((e) => e.export_month))];
  const deliveries = (await Promise.all(months.map(listDeliveriesForMonth))).flat();
  return finalizedMonthsDeliveryState(all, deliveries);
}

export type { DeliveryState };
