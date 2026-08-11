import test from "node:test";
import assert from "node:assert/strict";
import {
  deliveryStateToPill,
  DELIVERY_STATE,
} from "@/lib/receipts/delivery-state";
import { needsDeliveryAction } from "@/lib/receipts/delivery-status";

// delivery-composer §6 table — the month-pill colour mapping. Pure; the unit
// test is the authority for the table. The critical case is null → "undelivered":
// a sealed-but-never-sent month (2026-06 today) must read as action-needed red,
// not neutral grey.

test("deliveryStateToPill: delivered → delivered (green ✓)", () => {
  assert.equal(deliveryStateToPill(DELIVERY_STATE.DELIVERED), "delivered");
});

test("deliveryStateToPill: pending → pending (blue, in-flight)", () => {
  assert.equal(deliveryStateToPill(DELIVERY_STATE.PENDING), "pending");
});

test("deliveryStateToPill: sealed_undelivered (failed) → undelivered (red)", () => {
  assert.equal(
    deliveryStateToPill(DELIVERY_STATE.SEALED_UNDELIVERED),
    "undelivered",
  );
});

test("deliveryStateToPill: null (sealed, never attempted) → undelivered (red) — the 2026-06 case", () => {
  assert.equal(deliveryStateToPill(null), "undelivered");
});

test("deliveryStateToPill: undefined (not provided, reconcile/AMEX pages) → undelivered default", () => {
  // Undefined means the caller didn't populate deliveryState. The pure mapping
  // treats it as not-delivered; the MonthSwitcher guards separately (only
  // colours when deliveryState !== undefined) so reconcile/AMEX pills are
  // unaffected. Asserted here so the default is explicit.
  assert.equal(deliveryStateToPill(undefined), "undelivered");
});

test("needsDeliveryAction: true for everything except delivered", () => {
  assert.equal(needsDeliveryAction(DELIVERY_STATE.DELIVERED), false);
  assert.equal(needsDeliveryAction(DELIVERY_STATE.PENDING), true);
  assert.equal(needsDeliveryAction(DELIVERY_STATE.SEALED_UNDELIVERED), true);
  assert.equal(needsDeliveryAction(null), true);
  assert.equal(needsDeliveryAction(undefined), true);
});
