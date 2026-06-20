import assert from "node:assert/strict";
import test from "node:test";
import { buildGuardedExtraction } from "@/lib/receipts/extraction";

const JP_RECEIPT = `株式会社テストストア
領収書
2026年5月16日
小計 ¥1,364
消費税 ¥136
合計 ¥1,500`;

test("guardrail: regex amount is authoritative; model disagreement is flagged", () => {
  // Model confidently misreads the total. The regex parses ¥1,500 from the
  // text, so the regex wins and the disagreement is surfaced for review.
  const { result, discrepancies } = buildGuardedExtraction(JP_RECEIPT, {
    amountMinor: 9999,
    merchant: "株式会社テストストア",
  });
  assert.equal(result.amountMinor, 1500);
  assert.ok(discrepancies.includes("amountMinor"));
});

test("guardrail: regex date is authoritative; agreement records no discrepancy", () => {
  const { result, discrepancies } = buildGuardedExtraction(JP_RECEIPT, {
    transactionDate: "2026-05-16",
  });
  assert.equal(result.transactionDate, "2026-05-16");
  assert.ok(!discrepancies.includes("transactionDate"));
});

test("guardrail: model fills amount when regex finds none", () => {
  const { result, discrepancies } = buildGuardedExtraction("alpha\nbravo", {
    amountMinor: 5000,
  });
  assert.equal(result.amountMinor, 5000);
  assert.ok(!discrepancies.includes("amountMinor"));
});

test("guardrail: merchant is model-primary, regex fallback, with discrepancy", () => {
  const { result, discrepancies } = buildGuardedExtraction(JP_RECEIPT, {
    merchant: "Cafe Bee",
  });
  assert.equal(result.merchant, "Cafe Bee");
  assert.ok(discrepancies.includes("merchant"));
});

test("guardrail: coerces stringy model amounts and rejects junk", () => {
  // Untyped JSON from the consumer may send amounts as strings.
  assert.equal(
    buildGuardedExtraction("alpha\nbravo", { amountMinor: "5000" as unknown as number }).result.amountMinor,
    5000,
  );
  assert.equal(
    buildGuardedExtraction("alpha\nbravo", { amountMinor: "5,000" as unknown as number }).result.amountMinor,
    5000,
  );
  assert.equal(
    buildGuardedExtraction("alpha\nbravo", { amountMinor: "¥5,000" as unknown as number }).result.amountMinor,
    5000,
  );
  // Non-numeric junk must not reach amount_minor.
  assert.equal(
    buildGuardedExtraction("alpha\nbravo", { amountMinor: "five thousand" as unknown as number }).result.amountMinor,
    null,
  );
  // Stringy tax amount is coerced too.
  assert.equal(
    buildGuardedExtraction("alpha\nbravo", { taxAmountMinor: "754" as unknown as number }).result.taxAmountMinor,
    754,
  );
});

test("guardrail: model fills invoice registration number when regex finds none", () => {
  const { result } = buildGuardedExtraction("no invoice number here", {
    invoiceRegistrationNumber: "T1234567890123",
  });
  assert.equal(result.invoiceRegistrationNumber, "T1234567890123");
});

test("guardrail: provider label is carried onto the result; no invented category", () => {
  const { result } = buildGuardedExtraction(JP_RECEIPT, {}, "mlx_local:qwen2-vl");
  assert.equal(result.provider, "mlx_local:qwen2-vl");
  assert.equal(result.expenseType, null);
  assert.deepEqual(result.attendeeNames, []);
  assert.equal(result.rawText, JP_RECEIPT);
});
