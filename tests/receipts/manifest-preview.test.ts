import test from "node:test";
import assert from "node:assert/strict";
import {
  buildManifestPreviewCsv,
  type ManifestSampleRow,
} from "@/lib/receipts/manifest-preview";

function makeRow(
  overrides: Partial<ManifestSampleRow> = {},
): ManifestSampleRow {
  return {
    receiptId: "R-abc12345",
    merchant: "Test Merchant",
    txnDate: "2026-06-15",
    amountMinor: 1000,
    categoryLabel: "supplies",
    payment: "CASH",
    alcohol: false,
    archivePath: "r2://.../abc123def456",
    invoiceRegistrationNumber: "",
    ...overrides,
  };
}

test("manifest preview CSV: invoice_registration_number column appended last", () => {
  const csv = buildManifestPreviewCsv([
    makeRow({ invoiceRegistrationNumber: "T1234567890123" }),
  ]);
  const lines = csv.split("\n");
  const headers = lines[0]!.split(",");
  const idx = headers.indexOf("invoice_registration_number");
  assert.ok(idx >= 0, "missing invoice_registration_number header");
  assert.equal(
    idx,
    headers.length - 1,
    "column must be appended last (append-only)",
  );
  const dataCols = lines[1]!.split(",");
  assert.equal(dataCols[idx], "T1234567890123");
});

test("manifest preview CSV: invoice_registration_number empty when none", () => {
  const csv = buildManifestPreviewCsv([makeRow({ invoiceRegistrationNumber: "" })]);
  const lines = csv.split("\n");
  const headers = lines[0]!.split(",");
  const idx = headers.indexOf("invoice_registration_number");
  const dataCols = lines[1]!.split(",");
  assert.equal(dataCols[idx], "");
});
