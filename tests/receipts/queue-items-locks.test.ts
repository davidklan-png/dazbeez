import assert from "node:assert/strict";
import test from "node:test";
import { buildQueueItems } from "@/lib/receipts/queue-items";
import type { ReceiptLockInfo } from "@/lib/receipts/receipt-locks";
import type { ReceiptRecord } from "@/lib/receipts/types";

function receipt(partial: Partial<ReceiptRecord>): ReceiptRecord {
  return {
    id: "r1",
    status: "reviewed",
    captured_at: "2026-07-05T10:00:00.000Z",
    merchant: null,
    amount_minor: null,
    currency: "JPY",
    expense_category_code: null,
    business_purpose: null,
    transaction_date: null,
    extraction_state: "captured",
    extraction_json: null,
    ...partial,
  } as ReceiptRecord;
}

const EXPORT_LOCK: ReceiptLockInfo = { locked: true, kind: "export", month: "2026-06" };
const RECON_LOCK: ReceiptLockInfo = {
  locked: true,
  kind: "reconciliation",
  month: "2026-06",
};

test("buildQueueItems: passes the locked flag + kind through from the locks map", () => {
  const items = buildQueueItems(
    [
      receipt({ id: "free" }),
      receipt({ id: "sealed-export" }),
      receipt({ id: "sealed-recon" }),
    ],
    new Set(),
    Date.UTC(2026, 6, 5),
    new Map([
      ["sealed-export", EXPORT_LOCK],
      ["sealed-recon", RECON_LOCK],
    ]),
  );
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.equal(byId.get("free")?.locked, false);
  assert.equal(byId.get("free")?.lockKind, null);
  assert.equal(byId.get("sealed-export")?.locked, true);
  assert.equal(byId.get("sealed-export")?.lockKind, "export");
  assert.equal(byId.get("sealed-recon")?.locked, true);
  assert.equal(byId.get("sealed-recon")?.lockKind, "reconciliation");
});

test("buildQueueItems: with no locks map, every item is unlocked (backward compatible)", () => {
  const items = buildQueueItems([receipt({ id: "a" })]);
  assert.equal(items[0].locked, false);
  assert.equal(items[0].lockKind, null);
});

test("buildQueueItems: sortDateMs falls back to captured_at; amount -1 when unknown", () => {
  const items = buildQueueItems([
    receipt({
      id: "dated",
      transaction_date: "2026-06-15",
      captured_at: "2026-06-16T00:00:00.000Z",
      amount_minor: 1500,
    }),
    // transaction_date missing → falls back to captured_at (mirrors dateLabel).
    receipt({ id: "captured-only", transaction_date: null, captured_at: "2026-07-01T00:00:00.000Z" }),
    // totally dateless → 0 so it sorts to an end instead of NaN.
    receipt({ id: "dateless", transaction_date: null, captured_at: "", amount_minor: null }),
  ]);
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.ok((byId.get("dated")?.sortDateMs ?? 0) > 0);
  assert.ok((byId.get("captured-only")?.sortDateMs ?? 0) > 0, "captured_at is the fallback");
  assert.equal(byId.get("dateless")?.sortDateMs, 0);
  assert.equal(byId.get("dated")?.sortAmountMinor, 1500);
  assert.equal(byId.get("dateless")?.sortAmountMinor, -1);
});
