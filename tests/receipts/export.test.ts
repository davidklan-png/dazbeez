import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMonthlyExportCsv,
  buildExportSummaryCsv,
  bomPrefixedCrlf,
  hashCsvContent,
  buildArchiveKey,
  buildManifestKey,
  buildSummaryKey,
} from "@/lib/receipts/export";
import {
  ExportFinalizedError,
  transactionMonthOf,
} from "@/lib/receipts/month-lock";
import type { ExportRow } from "@/lib/receipts/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeReceiptRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    rowType: "receipt",
    lineId: null,
    matchStatus: null,
    receiptStatus: null,
    missingReceiptReason: null,
    cardholderName: null,
    businessTripStatus: null,
    receiptId: "r-abc-123",
    status: "reviewed",
    originalR2Key: "receipts/2024/01/r-abc-123/file.jpg",
    transactionDate: "2024-01-15",
    merchant: "Starbucks Tokyo",
    amountMinor: 650,
    currency: "JPY",
    expenseType: "misc",
    expenseCategoryCode: null,
    expenseCategoryJa: null,
    expenseCategoryEn: null,
    paymentPath: "CASH",
    businessPurpose: "Team coffee",
    attendees: [],
    invoiceRegistrationNumber: null,
    qualifiedInvoiceStatus: null,
    taxRate: null,
    taxAmountMinor: null,
    sourceType: null,
    counterpartyName: null,
    ...overrides,
  };
}

function makeAmexLineRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    rowType: "amex_line",
    lineId: "amex-line-1",
    matchStatus: "confirmed",
    receiptStatus: "matched",
    missingReceiptReason: null,
    cardholderName: "David Klan",
    businessTripStatus: "not_applicable",
    receiptId: "r-def-456",
    status: "reconciled",
    originalR2Key: "receipts/2024/01/r-def-456/file.jpg",
    transactionDate: "2024-01-12",
    merchant: "Power Lunch Sushi",
    amountMinor: 5400,
    currency: "JPY",
    expenseType: "entertainment-alcohol",
    expenseCategoryCode: "entertainment",
    expenseCategoryJa: "接待（飲酒あり）",
    expenseCategoryEn: "Entertainment (alcohol)",
    paymentPath: "AMEX",
    businessPurpose: "Client meeting",
    attendees: ["Client A", "David Klan"],
    invoiceRegistrationNumber: "T1234567890123",
    qualifiedInvoiceStatus: "valid",
    taxRate: "0.10",
    taxAmountMinor: 490,
    sourceType: "paper_scanned",
    counterpartyName: "Power Lunch Sushi K.K.",
    ...overrides,
  };
}

// ─── buildMonthlyExportCsv ────────────────────────────────────────────────────

test("buildMonthlyExportCsv: produces header row with RowType", () => {
  const csv = buildMonthlyExportCsv([], new Map());
  const header = csv.split("\n")[0]!;
  assert.ok(header.includes("RowType"), "header must include RowType");
  assert.ok(header.includes("Merchant"), "header must include Merchant");
  assert.ok(header.includes("Amount"), "header must include Amount");
  assert.ok(header.includes("LineId"), "header must include LineId");
  assert.ok(header.includes("MissingReceiptReason"), "header must include MissingReceiptReason");
});

test("buildMonthlyExportCsv: one data row per input row", () => {
  const rows = [makeReceiptRow(), makeReceiptRow({ receiptId: "r-def-456" })];
  const csv = buildMonthlyExportCsv(rows, new Map());
  const lines = csv.split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 3, "header + 2 data rows");
});

test("buildMonthlyExportCsv: No is the first column and 1-based (proofs join key)", () => {
  const rows = [makeReceiptRow(), makeReceiptRow({ receiptId: "r-2" }), makeReceiptRow({ receiptId: "r-3" })];
  const csv = buildMonthlyExportCsv(rows, new Map());
  const lines = csv.split("\n");
  assert.equal(lines[0]!.split(",")[0], "No", "No is the header's first column");
  // 1-based row sequence, first field of each data line.
  assert.equal(lines[1]!.split(",")[0], "1");
  assert.equal(lines[2]!.split(",")[0], "2");
  assert.equal(lines[3]!.split(",")[0], "3");
});

test("buildMonthlyExportCsv: JPY amounts are not divided by 100", () => {
  const csv = buildMonthlyExportCsv(
    [makeReceiptRow({ amountMinor: 1500, currency: "JPY" })],
    new Map(),
  );
  assert.ok(csv.includes("1500"), "JPY amount should be 1500, not 15.00");
  assert.ok(!csv.includes("15.00"), "JPY should not be divided");
});

test("buildMonthlyExportCsv: USD amounts are divided by 100", () => {
  const csv = buildMonthlyExportCsv(
    [makeReceiptRow({ amountMinor: 1250, currency: "USD" })],
    new Map(),
  );
  assert.ok(csv.includes("12.50"), "USD 1250 minor units should display as 12.50");
});

test("buildMonthlyExportCsv: null amount renders as empty string", () => {
  const row = makeReceiptRow({ amountMinor: null });
  const csv = buildMonthlyExportCsv([row], new Map());
  const dataLine = csv.split("\n")[1]!;
  const cols = dataLine.split(",");
  // Header: No(0), RowType(1), TransactionDate(2), Merchant(3), Amount(4)
  assert.equal(cols[4], "", "null amount should be empty column");
});

test("buildMonthlyExportCsv: attendees are joined with semicolons and quoted", () => {
  const row = makeReceiptRow({ receiptId: "r-1" });
  const attendeeMap = new Map([["r-1", ["Alice Nakamura", "Bob Smith"]]]);
  const csv = buildMonthlyExportCsv([row], attendeeMap);
  assert.ok(
    csv.includes('"Alice Nakamura; Bob Smith"'),
    "attendees should be semicolon-joined and quoted",
  );
});

test("buildMonthlyExportCsv: merchant with commas is properly quoted", () => {
  const row = makeReceiptRow({ merchant: "Shop, Ltd." });
  const csv = buildMonthlyExportCsv([row], new Map());
  assert.ok(csv.includes('"Shop, Ltd."'), "comma in merchant must be quoted");
});

test("buildMonthlyExportCsv: merchant with double-quotes is escaped", () => {
  const row = makeReceiptRow({ merchant: 'Shop "Best" Ltd.' });
  const csv = buildMonthlyExportCsv([row], new Map());
  assert.ok(csv.includes('"Shop ""Best"" Ltd."'), "double quotes must be escaped");
});

test("buildMonthlyExportCsv: AMEX line row carries line-only fields", () => {
  const csv = buildMonthlyExportCsv([makeAmexLineRow()], new Map());
  assert.ok(csv.includes("amex_line"), "rowType=amex_line must appear");
  assert.ok(csv.includes("amex-line-1"), "lineId must be present");
  assert.ok(csv.includes("David Klan"), "cardholderName must be present");
});

test("buildMonthlyExportCsv: missing-receipt line ships with reason in CSV", () => {
  // Audit A4 #1: missing-receipt lines MUST appear in the CSV with their
  // reasons; previously they were silently absent.
  const row = makeAmexLineRow({
    receiptId: null,
    status: null,
    originalR2Key: null,
    matchStatus: "no_receipt",
    receiptStatus: "missing_receipt",
    missingReceiptReason: "Lost during travel",
    merchant: "Airport Coffee",
    attendees: [],
  });
  const csv = buildMonthlyExportCsv([row], new Map());
  assert.ok(csv.includes("missing_receipt"), "receiptStatus must be present");
  assert.ok(csv.includes("Lost during travel"), "missingReceiptReason must be present");
});

test("buildMonthlyExportCsv: formula-injection guard prefixes = + - @", () => {
  // A5: a merchant starting with = + - @ gets prefixed with a single quote
  // so Excel does not evaluate it as a formula on open.
  for (const prefix of ["=", "+", "-", "@"]) {
    const row = makeReceiptRow({ merchant: `${prefix}cmd|'/c calc'!A1` });
    const csv = buildMonthlyExportCsv([row], new Map());
    assert.ok(
      csv.includes(`'${prefix}cmd`),
      `merchant starting with ${prefix} must be single-quote prefixed`,
    );
  }
});

test("buildMonthlyExportCsv: matched receipt attendees read from bundle.attendees when attendeeMap misses", () => {
  // A receipt matched to a line should still surface its attendees even if
  // the caller passed an empty attendeeMap (the bundle row carries them).
  const row = makeAmexLineRow({ attendees: ["Inline Attendee"] });
  const csv = buildMonthlyExportCsv([row], new Map());
  assert.ok(csv.includes("Inline Attendee"), "row.attendees used as fallback");
});

// ─── bomPrefixedCrlf (A5 CSV hardening) ───────────────────────────────────────

test("bomPrefixedCrlf: prepends UTF-8 BOM and converts LF to CRLF", () => {
  const out = bomPrefixedCrlf("a\nb\n");
  assert.equal(out.charCodeAt(0), 0xfeff, "must start with U+FEFF BOM");
  assert.ok(out.includes("\r\n"), "LF must become CRLF");
  assert.ok(!out.slice(1).includes("\n\r"), "no stray lone LF");
});

test("bomPrefixedCrlf: handles text that already has CRLF", () => {
  const out = bomPrefixedCrlf("a\r\nb\r\n");
  assert.equal(out.charCodeAt(0), 0xfeff);
  // Idempotent on line endings.
  assert.equal((out.match(/\r\n/g) ?? []).length, 2);
  assert.equal((out.match(/(?<!\r)\n/g) ?? []).length, 0);
});

// ─── buildExportSummaryCsv (A5 summary CSV) ───────────────────────────────────

test("buildExportSummaryCsv: 集計 — per-category + payment-path + grand total", () => {
  const rows: ExportRow[] = [
    makeAmexLineRow({ amountMinor: 5000, expenseCategoryCode: "entertainment" }),
    makeReceiptRow({
      amountMinor: 1500,
      paymentPath: "CASH",
      expenseCategoryCode: "meeting",
    }),
    makeReceiptRow({
      amountMinor: 3000,
      paymentPath: "DIGITAL",
      expenseCategoryCode: "software",
    }),
  ];
  const csv = buildExportSummaryCsv(rows, "2026-05", "2026-05-19T12:00:00Z");
  assert.match(csv, /Month,2026-05/);
  assert.match(csv, /勘定科目,件数,合計金額/);
  assert.match(csv, /支払方法,件数,合計金額/);
  // Per-category (Japanese name when present; code fallback when JA is null).
  assert.match(csv, /接待（飲酒あり）,1,5000/);
  assert.match(csv, /meeting,1,1500/);
  assert.match(csv, /software,1,3000/);
  // Per-payment-path.
  assert.match(csv, /AMEX,1,5000/);
  assert.match(csv, /現金,1,1500/);
  assert.match(csv, /デジタル,1,3000/);
  // Grand total = exact sum of the rows' amountMinor (5000+1500+3000 = 9500),
  // matching what the receipts CSV's amounts sum to — no float re-derivation.
  assert.match(csv, /総合計,3,9500/);
});

test("buildExportSummaryCsv: uncategorized bucket when category null", () => {
  const csv = buildExportSummaryCsv(
    [makeReceiptRow({ expenseCategoryCode: null })],
    "2026-05",
    "t",
  );
  assert.match(csv, /uncategorized,1,/);
});

// ─── Compliance columns on main CSV (A5) ──────────────────────────────────────

test("buildMonthlyExportCsv: compliance columns populated from receipt", () => {
  const csv = buildMonthlyExportCsv(
    [makeAmexLineRow({
      invoiceRegistrationNumber: "T2810074043972",
      qualifiedInvoiceStatus: "valid",
      taxRate: "0.10",
      taxAmountMinor: 490,
      sourceType: "paper_scanned",
      counterpartyName: "Power Lunch Sushi K.K.",
    })],
    new Map(),
  );
  assert.ok(csv.includes("T2810074043972"), "invoice registration number");
  assert.ok(csv.includes("valid"), "qualified invoice status");
  assert.ok(csv.includes("0.10"), "tax rate");
  assert.ok(csv.includes("490"), "tax amount minor");
  assert.ok(csv.includes("paper_scanned"), "source type");
  assert.ok(csv.includes("Power Lunch Sushi K.K."), "counterparty name");
});

test("buildMonthlyExportCsv: header carries compliance column names", () => {
  const csv = buildMonthlyExportCsv([], new Map());
  const header = csv.split("\n")[0]!;
  for (const col of [
    "InvoiceRegistrationNumber",
    "QualifiedInvoiceStatus",
    "TaxRate",
    "TaxAmount",
    "SourceType",
    "CounterpartyName",
  ]) {
    assert.ok(header.includes(col), `header must include ${col}`);
  }
});

// ─── buildSummaryKey ──────────────────────────────────────────────────────────

test("buildSummaryKey: uses correct path pattern", () => {
  const key = buildSummaryKey("2024-01", "export-uuid");
  assert.equal(key, "exports/2024-01/export-uuid-summary.csv");
});

// ─── Split lock model helpers (audit A5) ──────────────────────────────────────

test("transactionMonthOf: extracts YYYY-MM from YYYY-MM-DD", () => {
  assert.equal(transactionMonthOf("2026-05-15"), "2026-05");
});

test("transactionMonthOf: returns null for null/empty/malformed", () => {
  assert.equal(transactionMonthOf(null), null);
  assert.equal(transactionMonthOf(""), null);
  assert.equal(transactionMonthOf("not-a-date"), null);
});

test("transactionMonthOf: accepts ISO timestamps too", () => {
  assert.equal(transactionMonthOf("2026-05-15T08:30:00Z"), "2026-05");
});

test("ExportFinalizedError: carries month and message", () => {
  const err = new ExportFinalizedError("2026-05", "locked");
  assert.equal(err.month, "2026-05");
  assert.equal(err.message, "locked");
  assert.equal(err.name, "ExportFinalizedError");
  assert.ok(err instanceof Error);
});

test("ExportFinalizedError: routes via instanceof, not substring matching on message", () => {
  // Routes catch this with `instanceof ExportFinalizedError` (see app/api/receipts/*).
  // A plain Error carrying the same string in its message must NOT be confused
  // for the typed signal — that's the whole point of having a typed error class.
  function catchResult(err: unknown): "locked" | "passthrough" {
    if (err instanceof ExportFinalizedError) return "locked";
    return "passthrough";
  }
  assert.equal(catchResult(new ExportFinalizedError("2026-05", "x")), "locked");
  assert.equal(
    catchResult(new Error("Month 2026-05 is export-finalized")),
    "passthrough",
    "plain Error must not satisfy the instanceof check",
  );
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
