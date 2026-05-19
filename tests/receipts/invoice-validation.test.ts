import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidRegistrationNumberFormat,
  normalizeRegistrationNumber,
  validateInvoiceRegistrationNumber,
} from "@/lib/receipts/invoice";

test("invoice: T + 13 digits is valid", () => {
  assert.equal(isValidRegistrationNumberFormat("T1234567890123"), true);
});

test("invoice: missing T prefix is invalid", () => {
  assert.equal(isValidRegistrationNumberFormat("1234567890123"), false);
});

test("invoice: wrong digit count is invalid", () => {
  assert.equal(isValidRegistrationNumberFormat("T12345"), false);
  assert.equal(isValidRegistrationNumberFormat("T12345678901234"), false);
});

test("invoice: lowercase t is normalized to T", () => {
  assert.equal(isValidRegistrationNumberFormat("t1234567890123"), true);
});

test("invoice: hyphens and whitespace are stripped", () => {
  const result = normalizeRegistrationNumber("T1234-5678-90123");
  assert.equal(result.normalized, "T1234567890123");
  assert.equal(result.formatValid, true);
});

test("invoice: fullwidth digits normalize", () => {
  // T followed by 13 fullwidth digits
  const fullwidth = "T１２３４５６７８９０１２３";
  const result = normalizeRegistrationNumber(fullwidth);
  assert.equal(result.normalized, "T1234567890123");
  assert.equal(result.formatValid, true);
});

test("invoice: empty input yields missing status", () => {
  const result = validateInvoiceRegistrationNumber(null);
  assert.equal(result.registrationStatus, "unchecked");
  assert.equal(result.qualifiedInvoiceStatus, "missing_registration_number");
});

test("invoice: invalid format yields invalid status with message", () => {
  const result = validateInvoiceRegistrationNumber("NOT-A-NUMBER");
  assert.equal(result.registrationStatus, "format_invalid");
  assert.equal(result.qualifiedInvoiceStatus, "invalid");
  assert.match(result.message ?? "", /T.*13 digits/);
});

test("invoice: valid format yields valid status", () => {
  const result = validateInvoiceRegistrationNumber("T9876543210123");
  assert.equal(result.registrationStatus, "format_valid");
  assert.equal(result.qualifiedInvoiceStatus, "valid");
  assert.equal(result.normalizedNumber, "T9876543210123");
});

test("invoice: known unregistered counterparty changes missing status", () => {
  const result = validateInvoiceRegistrationNumber("", {
    counterpartyKnownUnregistered: true,
  });
  assert.equal(result.qualifiedInvoiceStatus, "unregistered_counterparty");
});
