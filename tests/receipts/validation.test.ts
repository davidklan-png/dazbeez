import test from "node:test";
import assert from "node:assert/strict";
import {
  validateReceiptFile,
  validateReceiptDate,
  validateAmountMinor,
  validateCurrency,
  parseAmexCsv,
  MAX_RECEIPT_FILE_BYTES,
  ALLOWED_RECEIPT_MIME_TYPES,
} from "@/lib/receipts/validation";

// ─── Helper: create a minimal File-like object ────────────────────────────────

function makeFile(name: string, type: string, sizeBytes: number): File {
  const content = new Uint8Array(sizeBytes);
  return new File([content], name, { type });
}

// ─── validateReceiptFile ───────────────────────────────────────────────────────

test("validateReceiptFile: allowed MIME types pass", () => {
  for (const mime of ALLOWED_RECEIPT_MIME_TYPES) {
    const ext = mime.split("/")[1] ?? "jpg";
    const file = makeFile(`receipt.${ext}`, mime, 1024);
    assert.equal(validateReceiptFile(file), null, `expected null for ${mime}`);
  }
});

test("validateReceiptFile: unsupported MIME type is rejected", () => {
  const file = makeFile("malware.exe", "application/octet-stream", 1024);
  const err = validateReceiptFile(file);
  assert.ok(err !== null, "expected an error for unsupported type");
  assert.match(err!, /not allowed/i);
});

test("validateReceiptFile: file over 10 MiB is rejected", () => {
  const file = makeFile("big.jpg", "image/jpeg", MAX_RECEIPT_FILE_BYTES + 1);
  const err = validateReceiptFile(file);
  assert.ok(err !== null, "expected an error for oversized file");
  assert.match(err!, /too large/i);
});

test("validateReceiptFile: file exactly at 10 MiB limit passes", () => {
  const file = makeFile("max.jpg", "image/jpeg", MAX_RECEIPT_FILE_BYTES);
  assert.equal(validateReceiptFile(file), null);
});

test("validateReceiptFile: PDF is accepted", () => {
  const file = makeFile("invoice.pdf", "application/pdf", 500_000);
  assert.equal(validateReceiptFile(file), null);
});

// ─── validateReceiptDate ──────────────────────────────────────────────────────

test("validateReceiptDate: valid past date passes", () => {
  assert.equal(validateReceiptDate("2024-01-15"), true);
});

test("validateReceiptDate: today's date passes", () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(validateReceiptDate(today), true);
});

test("validateReceiptDate: future date is rejected", () => {
  assert.equal(validateReceiptDate("2099-12-31"), false);
});

test("validateReceiptDate: invalid format is rejected", () => {
  assert.equal(validateReceiptDate("01/15/2024"), false);
  assert.equal(validateReceiptDate("2024-13-01"), false);
  assert.equal(validateReceiptDate(""), false);
  assert.equal(validateReceiptDate("not-a-date"), false);
});

// ─── validateAmountMinor ──────────────────────────────────────────────────────

test("validateAmountMinor: valid integer strings pass", () => {
  assert.equal(validateAmountMinor("1500"), 1500);
  assert.equal(validateAmountMinor("0"), 0);
  assert.equal(validateAmountMinor(2000), 2000);
});

test("validateAmountMinor: null/undefined/empty returns null", () => {
  assert.equal(validateAmountMinor(null), null);
  assert.equal(validateAmountMinor(undefined), null);
  assert.equal(validateAmountMinor(""), null);
});

test("validateAmountMinor: non-integer is rejected", () => {
  assert.equal(validateAmountMinor("12.50"), null);
  assert.equal(validateAmountMinor("abc"), null);
});

test("validateAmountMinor: negative value is rejected", () => {
  assert.equal(validateAmountMinor(-100), null);
  assert.equal(validateAmountMinor("-500"), null);
});

// ─── validateCurrency ────────────────────────────────────────────────────────

test("validateCurrency: known currencies pass", () => {
  assert.equal(validateCurrency("JPY"), true);
  assert.equal(validateCurrency("USD"), true);
  assert.equal(validateCurrency("EUR"), true);
});

test("validateCurrency: unknown currency is rejected", () => {
  assert.equal(validateCurrency("XYZ"), false);
  assert.equal(validateCurrency(""), false);
});

// ─── parseAmexCsv ────────────────────────────────────────────────────────────

test("parseAmexCsv: parses single-date-column AMEX CSV", () => {
  const csv = [
    "Date,Description,Amount",
    "01/15/2024,AMAZON.COM,3800",
    "01/18/2024,STARBUCKS TOKYO,650",
  ].join("\n");

  const rows = parseAmexCsv(csv, "2024-01");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.transactionDate, "2024-01-15");
  assert.equal(rows[0]!.merchant, "AMAZON.COM");
  assert.equal(rows[0]!.amountMinor, 380000);
  assert.equal(rows[1]!.transactionDate, "2024-01-18");
  assert.equal(rows[1]!.merchant, "STARBUCKS TOKYO");
});

test("parseAmexCsv: handles YYYY/MM/DD date format", () => {
  const csv = [
    "Date,Description,Amount",
    "2024/01/20,CONVENIENCE STORE,320",
  ].join("\n");

  const rows = parseAmexCsv(csv, "2024-01");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.transactionDate, "2024-01-20");
});

test("parseAmexCsv: skips header row and empty lines", () => {
  const csv = [
    "Transaction Date,Post Date,Description,Amount",
    "",
    "01/10/2024,01/12/2024,RESTAURANT ABC,4500",
  ].join("\n");

  const rows = parseAmexCsv(csv, "2024-01");
  assert.equal(rows.length, 1);
});

test("parseAmexCsv: returns empty array for malformed CSV", () => {
  assert.deepEqual(parseAmexCsv("", "2024-01"), []);
  assert.deepEqual(parseAmexCsv("header only\n", "2024-01"), []);
});

test("parseAmexCsv: statementMonth is set on all rows", () => {
  const csv = [
    "Date,Description,Amount",
    "02/01/2024,SHOP,1000",
  ].join("\n");
  const rows = parseAmexCsv(csv, "2024-02");
  assert.equal(rows[0]!.statementMonth, "2024-02");
});
