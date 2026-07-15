import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFinalizeEmailBody,
  sendFinalizeNotification,
  summarizeByCategory,
  type FinalizeNoticeData,
  type EmailSender,
} from "@/lib/receipts/notify";
import type { ExportRow } from "@/lib/receipts/types";

// ─── summarizeByCategory ────────────────────────────────────────────────────

function row(over: Partial<ExportRow>): ExportRow {
  return {
    rowType: "amex_line",
    lineId: "l",
    matchStatus: null,
    receiptStatus: null,
    missingReceiptReason: null,
    cardholderName: null,
    businessTripStatus: null,
    receiptId: "r",
    status: "reviewed",
    originalR2Key: null,
    transactionDate: "2026-06-01",
    merchant: "M",
    amountMinor: 1000,
    currency: "JPY",
    expenseType: "UNKNOWN",
    expenseCategoryCode: "communications",
    expenseCategoryJa: "通信費",
    expenseCategoryEn: "Communications",
    paymentPath: "AMEX",
    businessPurpose: null,
    attendees: [],
    invoiceRegistrationNumber: null,
    qualifiedInvoiceStatus: null,
    taxRate: null,
    taxAmountMinor: null,
    sourceType: null,
    counterpartyName: null,
    ...over,
  };
}

test("summarizeByCategory: groups by code, sums totals, sorts desc", () => {
  const totals = summarizeByCategory([
    row({ expenseCategoryCode: "rd", expenseCategoryJa: "研究開発費", amountMinor: 10000 }),
    row({ expenseCategoryCode: "rd", expenseCategoryJa: "研究開発費", amountMinor: 5000 }),
    row({ expenseCategoryCode: "travel", expenseCategoryJa: "旅費交通費", amountMinor: 2000 }),
    row({ expenseCategoryCode: null, expenseCategoryJa: null, amountMinor: 999 }),
  ]);
  assert.equal(totals.length, 3);
  assert.equal(totals[0]!.code, "rd", "highest total first");
  assert.equal(totals[0]!.count, 2);
  assert.equal(totals[0]!.totalMinor, 15000);
  assert.equal(totals[2]!.code, "uncategorized");
});

// ─── buildFinalizeEmailBody (snapshot) ──────────────────────────────────────

const fixtureData: FinalizeNoticeData = {
  month: "2026-06",
  monthLabel: "2026年6月",
  exportId: "exp-test",
  revision: 2,
  rowCount: 43,
  receiptCount: 40,
  categoryTotals: [
    { code: "rd", ja: "研究開発費", count: 5, totalMinor: 150000 },
    { code: "travel", ja: "旅費交通費", count: 8, totalMinor: 42000 },
  ],
  noticeText: "【お知らせ】これは架空の通知本文です。No列による整理、SHA-256記録、再圧縮についての説明。",
};

test("buildFinalizeEmailBody: month, revision, counts, totals, notice, link", () => {
  const body = buildFinalizeEmailBody(fixtureData);
  assert.ok(body.includes("2026年6月"), "month label");
  assert.ok(body.includes("改訹: 2（差替え）"), "revision context for rev > 1");
  assert.ok(body.includes("明細行数: 43"), "row count");
  assert.ok(body.includes("証憑ファイル数: 40"), "receipt count");
  assert.ok(body.includes("研究開発費: 5件 / ¥150,000"), "category total line");
  assert.ok(body.includes("旅費交通費: 8件 / ¥42,000"), "second category total");
  assert.ok(body.includes("No列による整理"), "embedded notice text");
  assert.ok(body.includes("https://dazbeez.com/receipts/export?month=2026-06"), "download link");
});

test("buildFinalizeEmailBody: revision 1 shows 新規 not 差替え", () => {
  const body = buildFinalizeEmailBody({ ...fixtureData, revision: 1 });
  assert.ok(body.includes("改訹: 新規"));
  assert.ok(!body.includes("差替え"));
});

// ─── sendFinalizeNotification (never throws; non-fatal on failure) ──────────

test("sendFinalizeNotification: ok when the binding resolves", async () => {
  const sender: EmailSender = { send: async () => undefined };
  const res = await sendFinalizeNotification(sender, "from@dazbeez.com", "acct@example.com", fixtureData);
  assert.equal(res.ok, true);
});

test("sendFinalizeNotification: a throwing binding → {ok:false}, no throw", async () => {
  // The critical guarantee: a send failure must NOT propagate. Finalize stays
  // 200; the caller folds res into a warning + notification_failed audit.
  const sender: EmailSender = {
    send: async () => {
      throw new Error("Email Routing rejected: destination not verified");
    },
  };
  const res = await sendFinalizeNotification(sender, "from@dazbeez.com", "acct@example.com", fixtureData);
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /destination not verified/);
});

test("sendFinalizeNotification: missing binding / from / to → {ok:false}", async () => {
  assert.equal((await sendFinalizeNotification(null, "f", "t", fixtureData)).ok, false);
  assert.equal((await sendFinalizeNotification({ send: async () => undefined }, null, "t", fixtureData)).ok, false);
  assert.equal((await sendFinalizeNotification({ send: async () => undefined }, "f", null, fixtureData)).ok, false);
});
