import test from "node:test";
import assert from "node:assert/strict";
import { postPatchMembershipDate } from "@/lib/receipts/membership";

// postPatchMembershipDate is the pure decision the updateReceiptRecord hook
// applies (the side effect — assignMembershipForReceipt — is db-coupled and
// integration-tested). The headline case is the UNKNOWN→CASH classification
// path that was the reproducing bug: the date was set while payment_path=
// UNKNOWN (no assignment — UNKNOWN isn't a membership path), then the operator
// classifies UNKNOWN→CASH in a PATCH that does NOT touch the date. The hook
// must fire on the effective post-PATCH state and assign from the existing date.

test("postPatchMembershipDate: UNKNOWN→CASH classification (date not in PATCH) → assigns from the existing date", () => {
  // Reproducer: extraction set the date while UNKNOWN; this PATCH sets paymentPath=CASH only.
  const date = postPatchMembershipDate({
    effectivePaymentPath: "CASH",
    beforeExportStatementMonth: null,
    explicitOverrideInInput: false,
    effectiveTransactionDate: "2026-06-11", // before.transaction_date (PATCH didn't touch it)
  });
  assert.equal(date, "2026-06-11");
});

test("postPatchMembershipDate: CASH + date in PATCH + NULL membership → assigns from the PATCH date", () => {
  assert.equal(
    postPatchMembershipDate({
      effectivePaymentPath: "CASH",
      beforeExportStatementMonth: null,
      explicitOverrideInInput: false,
      effectiveTransactionDate: "2026-06-11", // input.transactionDate
    }),
    "2026-06-11",
  );
});

test("postPatchMembershipDate: already assigned (sticky) → skip", () => {
  assert.equal(
    postPatchMembershipDate({
      effectivePaymentPath: "CASH",
      beforeExportStatementMonth: "2026-06",
      explicitOverrideInInput: false,
      effectiveTransactionDate: "2026-06-11",
    }),
    null,
  );
});

test("postPatchMembershipDate: explicit exportStatementMonth override in PATCH → skip (explicit wins)", () => {
  assert.equal(
    postPatchMembershipDate({
      effectivePaymentPath: "CASH",
      beforeExportStatementMonth: null,
      explicitOverrideInInput: true,
      effectiveTransactionDate: "2026-06-11",
    }),
    null,
  );
});

test("postPatchMembershipDate: no date (undated receipt) → skip", () => {
  assert.equal(
    postPatchMembershipDate({
      effectivePaymentPath: "CASH",
      beforeExportStatementMonth: null,
      explicitOverrideInInput: false,
      effectiveTransactionDate: null,
    }),
    null,
  );
});

test("postPatchMembershipDate: AMEX effective → skip (not a membership path)", () => {
  assert.equal(
    postPatchMembershipDate({
      effectivePaymentPath: "AMEX",
      beforeExportStatementMonth: null,
      explicitOverrideInInput: false,
      effectiveTransactionDate: "2026-06-11",
    }),
    null,
  );
});

test("postPatchMembershipDate: UNKNOWN effective → skip (waits for CASH/DIGITAL classification)", () => {
  assert.equal(
    postPatchMembershipDate({
      effectivePaymentPath: "UNKNOWN",
      beforeExportStatementMonth: null,
      explicitOverrideInInput: false,
      effectiveTransactionDate: "2026-06-11",
    }),
    null,
  );
});

test("postPatchMembershipDate: DIGITAL behaves like CASH → assigns", () => {
  assert.equal(
    postPatchMembershipDate({
      effectivePaymentPath: "DIGITAL",
      beforeExportStatementMonth: null,
      explicitOverrideInInput: false,
      effectiveTransactionDate: "2026-07-01",
    }),
    "2026-07-01",
  );
});
