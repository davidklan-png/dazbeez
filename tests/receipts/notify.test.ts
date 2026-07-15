import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeNotifyTest,
  buildFinalizeEmailBody,
  buildFinalizeEmailSubject,
  resolveNotificationRecipient,
  sendFinalizeNotification,
  sendViaResend,
  summarizeByCategory,
  type FinalizeNoticeData,
} from "@/lib/receipts/notify";
import type { ExportRow } from "@/lib/receipts/types";

function row(over: Partial<ExportRow>): ExportRow {
  return {
    rowType: "amex_line", lineId: "l", matchStatus: null, receiptStatus: null,
    missingReceiptReason: null, cardholderName: null, businessTripStatus: null,
    receiptId: "r", status: "reviewed", originalR2Key: null,
    transactionDate: "2026-06-01", merchant: "M", amountMinor: 1000,
    currency: "JPY", expenseType: "UNKNOWN", expenseCategoryCode: "communications",
    expenseCategoryJa: "通信費", expenseCategoryEn: "Communications",
    paymentPath: "AMEX", businessPurpose: null, attendees: [],
    invoiceRegistrationNumber: null, qualifiedInvoiceStatus: null,
    taxRate: null, taxAmountMinor: null, sourceType: null, counterpartyName: null,
    ...over,
  };
}

const fixtureData: FinalizeNoticeData = {
  month: "2026-06", monthLabel: "2026年6月", exportId: "exp-test", revision: 2,
  rowCount: 43, receiptCount: 40,
  categoryTotals: [
    { code: "rd", ja: "研究開発費", count: 5, totalMinor: 150000 },
    { code: "travel", ja: "旅費交通費", count: 8, totalMinor: 42000 },
  ],
  noticeText: "【お知らせ】これは架空の通知本文です。",
};

// ─── summarizeByCategory ────────────────────────────────────────────────────
test("summarizeByCategory: groups by code, sums totals, sorts desc", () => {
  const totals = summarizeByCategory([
    row({ expenseCategoryCode: "rd", expenseCategoryJa: "研究開発費", amountMinor: 10000 }),
    row({ expenseCategoryCode: "rd", expenseCategoryJa: "研究開発費", amountMinor: 5000 }),
    row({ expenseCategoryCode: "travel", expenseCategoryJa: "旅費交通費", amountMinor: 2000 }),
  ]);
  assert.equal(totals.length, 2);
  assert.equal(totals[0]!.code, "rd");
  assert.equal(totals[0]!.totalMinor, 15000);
});

// ─── buildFinalizeEmailBody / Subject ───────────────────────────────────────
test("buildFinalizeEmailBody: month, revision, counts, totals, notice, link", () => {
  const body = buildFinalizeEmailBody(fixtureData);
  assert.ok(body.includes("2026年6月"));
  assert.ok(body.includes("改訹: 2（差替え）"));
  assert.ok(body.includes("研究開発費: 5件 / ¥150,000"));
  assert.ok(body.includes("https://dazbeez.com/receipts/export?month=2026-06"));
});

test("buildFinalizeEmailSubject: test mode prefixes 【テスト送信】", () => {
  const real = buildFinalizeEmailSubject(fixtureData);
  const testSubj = buildFinalizeEmailSubject(fixtureData, { test: true });
  assert.ok(testSubj.startsWith("【テスト送信】"));
  assert.ok(testSubj.endsWith(real));
});

test("buildFinalizeEmailBody: test mode opens with test banner", () => {
  const body = buildFinalizeEmailBody(fixtureData, { test: true });
  assert.ok(body.startsWith("※これは通知チャネルのテスト送信です。"));
  assert.ok(body.includes("【勘定科目別集計】"), "real template follows banner");
});

// ─── Recipient resolution (settings → fallback → null) ─────────────────────
test("resolveNotificationRecipient: settings value wins over fallback", () => {
  const r = resolveNotificationRecipient("manager@dazbeez.com", "fallback@dazbeez.com");
  assert.equal(r.email, "manager@dazbeez.com");
  assert.equal(r.source, "settings");
});

test("resolveNotificationRecipient: falls back to var when settings empty", () => {
  const r = resolveNotificationRecipient("", "admin@dazbeez.com");
  assert.equal(r.email, "admin@dazbeez.com");
  assert.equal(r.source, "fallback");
});

test("resolveNotificationRecipient: null when both unconfigured", () => {
  const r = resolveNotificationRecipient("", null);
  assert.equal(r.email, null);
  assert.equal(r.source, null);
});

// ─── sendViaResend (isolated seam — mock fetch) ─────────────────────────────
test("sendViaResend: {ok:true} on 200", async () => {
  const fakeFetch = (async () => ({ ok: true, status: 200, json: async () => ({ id: "x" }) })) as unknown as typeof fetch;
  const res = await sendViaResend(fakeFetch, "key", "from@d.com", "to@d.com", "subj", "text", "<p>html</p>");
  assert.equal(res.ok, true);
});

test("sendViaResend: non-2xx → {ok:false} with Resend error message verbatim", async () => {
  const fakeFetch = (async () => ({
    ok: false, status: 422,
    json: async () => ({ name: "validation_error", message: "The `from` address is not verified", statusCode: 422 }),
  })) as unknown as typeof fetch;
  const res = await sendViaResend(fakeFetch, "key", "bad@d.com", "to@d.com", "subj", "text", "<p>html</p>");
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /from.*not verified/);
});

test("sendViaResend: network error → {ok:false} without throwing", async () => {
  const fakeFetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  const res = await sendViaResend(fakeFetch, "key", "from@d.com", "to@d.com", "subj", "text", "<p>html</p>");
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /network down/);
});

// ─── sendFinalizeNotification (missing config → {ok:false}, no fetch call) ──
test("sendFinalizeNotification: missing key/from/to → {ok:false} without throwing", async () => {
  const noopFetch = (async () => { throw new Error("should not be called"); }) as unknown as typeof fetch;
  assert.equal((await sendFinalizeNotification(null, "f", "t", fixtureData, undefined, noopFetch)).ok, false);
  assert.equal((await sendFinalizeNotification("key", null, "t", fixtureData, undefined, noopFetch)).ok, false);
  assert.equal((await sendFinalizeNotification("key", "f", null, fixtureData, undefined, noopFetch)).ok, false);
});

// ─── authorizeNotifyTest (Clerk-only — processor-key rejected) ──────────────
test("authorizeNotifyTest: rejects null (processor-key-only / no session)", () => {
  assert.throws(() => authorizeNotifyTest(null), /Unauthorized/);
});

test("authorizeNotifyTest: accepts a Clerk actor", () => {
  assert.equal(authorizeNotifyTest("op@dazbeez.com"), "op@dazbeez.com");
});
