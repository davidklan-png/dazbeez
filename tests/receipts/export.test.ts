import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMonthlyExportCsv,
  hashCsvContent,
  buildArchiveKey,
  buildManifestKey,
} from "@/lib/receipts/export";
import type { ExportRow } from "@/lib/receipts/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    receiptId: "r-abc-123",
    transactionDate: "2024-01-15",
    merchant: "Starbucks Tokyo",
    amountMinor: 650,
    currency: "JPY",
    expenseType: "misc",
    paymentPath: "CASH",
    businessPurpose: "Team coffee",
    attendees: [],
    status: "reviewed",
    originalR2Key: "receipts/2024/01/r-abc-123/file.jpg",
    ...overrides,
  };
}

// ─── buildMonthlyExportCsv ────────────────────────────────────────────────────

test("buildMonthlyExportCsv: produces header row", () => {
  const csv = buildMonthlyExportCsv([], new Map());
  const header = csv.split("\n")[0];
  assert.ok(header!.includes("ReceiptId"), "header must include ReceiptId");
  assert.ok(header!.includes("Merchant"), "header must include Merchant");
  assert.ok(header!.includes("Amount"), "header must include Amount");
});

test("buildMonthlyExportCsv: one data row per receipt", () => {
  const rows = [makeRow(), makeRow({ receiptId: "r-def-456" })];
  const csv = buildMonthlyExportCsv(rows, new Map());
  const lines = csv.split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 3, "header + 2 data rows");
});

test("buildMonthlyExportCsv: JPY amounts are not divided by 100", () => {
  const csv = buildMonthlyExportCsv([makeRow({ amountMinor: 1500, currency: "JPY" })], new Map());
  assert.ok(csv.includes("1500"), "JPY amount should be 1500, not 15.00");
  assert.ok(!csv.includes("15.00"), "JPY should not be divided");
});

test("buildMonthlyExportCsv: USD amounts are divided by 100", () => {
  const csv = buildMonthlyExportCsv(
    [makeRow({ amountMinor: 1250, currency: "USD" })],
    new Map(),
  );
  assert.ok(csv.includes("12.50"), "USD 1250 minor units should display as 12.50");
});

test("buildMonthlyExportCsv: null amount renders as empty string", () => {
  const row = makeRow({ amountMinor: null });
  const csv = buildMonthlyExportCsv([row], new Map());
  const dataLine = csv.split("\n")[1]!;
  const cols = dataLine.split(",");
  assert.equal(cols[3], "", "null amount should be empty column");
});

test("buildMonthlyExportCsv: attendees are joined with semicolons and quoted", () => {
  const row = makeRow({ receiptId: "r-1" });
  const attendeeMap = new Map([["r-1", ["Alice Nakamura", "Bob Smith"]]]);
  const csv = buildMonthlyExportCsv([row], attendeeMap);
  assert.ok(
    csv.includes('"Alice Nakamura; Bob Smith"'),
    "attendees should be semicolon-joined and quoted",
  );
});

test("buildMonthlyExportCsv: merchant with commas is properly quoted", () => {
  const row = makeRow({ merchant: "Shop, Ltd." });
  const csv = buildMonthlyExportCsv([row], new Map());
  assert.ok(csv.includes('"Shop, Ltd."'), "comma in merchant must be quoted");
});

test("buildMonthlyExportCsv: merchant with double-quotes is escaped", () => {
  const row = makeRow({ merchant: 'Shop "Best" Ltd.' });
  const csv = buildMonthlyExportCsv([row], new Map());
  assert.ok(csv.includes('"Shop ""Best"" Ltd."'), "double quotes must be escaped");
});

// ─── hashCsvContent ────────────────────────────────────────────────────────────

test("hashCsvContent: same content produces same hash", async () => {
  const csv = "ReceiptId,Amount\nr-1,1500";
  const hash1 = await hashCsvContent(csv);
  const hash2 = await hashCsvContent(csv);
  assert.equal(hash1, hash2);
});

test("hashCsvContent: different content produces different hash", async () => {
  const hash1 = await hashCsvContent("content-a");
  const hash2 = await hashCsvContent("content-b");
  assert.notEqual(hash1, hash2);
});

test("hashCsvContent: returns 64-character hex string", async () => {
  const hash = await hashCsvContent("test");
  assert.match(hash, /^[0-9a-f]{64}$/, "SHA-256 hex should be 64 chars");
});

// ─── Key generators ───────────────────────────────────────────────────────────

test("buildArchiveKey: uses correct path pattern", () => {
  const key = buildArchiveKey("2024-01", "export-uuid");
  assert.equal(key, "exports/2024-01/export-uuid-receipts.csv");
});

test("buildManifestKey: uses correct path pattern", () => {
  const key = buildManifestKey("2024-01", "export-uuid");
  assert.equal(key, "exports/2024-01/export-uuid-manifest.csv");
});
