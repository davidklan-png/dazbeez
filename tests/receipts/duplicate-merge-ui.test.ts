import test from "node:test";
import assert from "node:assert/strict";
import { buildResolutionNeeds } from "@/lib/receipts/duplicate-merge-ui";
import type { DuplicateMemberInput } from "@/lib/receipts/duplicate-resolution-policy";

function member(id: string, over: Partial<DuplicateMemberInput> = {}): DuplicateMemberInput {
  return {
    id, captured_at: "2026-05-03", updated_at: "v1", status: "reviewed",
    exported: false, archived: false, claimedByConfirmedAmexLine: false,
    businessTripLinked: false, emailIntakePromoted: false, transaction_date: "2026-05-03",
    merchant: "MIURA", amount_minor: 7362, currency: "JPY", expense_category_code: null,
    business_purpose: null, tax_amount_minor: null, tax_rate: null,
    invoice_registration_number: null, qualified_invoice_status: "not_checked",
    counterparty_name: null, attendeesRequired: false, attendeesCount: 0, attendeeNames: [],
    alcoholPresent: false, extractionState: "processed", hasOriginalFile: true, hasProofFile: false,
    ...over,
  };
}

test("MIURA produces separate required controls for tax amount and tax rate", () => {
  const needs = buildResolutionNeeds([
    member("retained"),
    member("source", { tax_amount_minor: 829, tax_rate: "10.0" }),
  ], "retained", ["source"]);
  assert.deepEqual(needs.filter((need) => need.required).map((need) => need.field), ["tax_amount", "tax_rate"]);
  assert.equal(needs[0]!.sources[0]!.receiptId, "source");
});

test("target-only attendee is required even when retained already has attendees", () => {
  const needs = buildResolutionNeeds([
    member("retained", { attendeesCount: 1, attendeeNames: ["Alice"] }),
    member("source", { attendeesCount: 2, attendeeNames: ["Alice", "Bob"] }),
  ], "retained", ["source"]);
  const attendees = needs.find((need) => need.field === "attendees");
  assert.equal(attendees?.required, true);
  assert.equal(attendees?.sources[0]?.displayValue, "Alice, Bob");
});

test("populated disagreement is offered as an optional conflict", () => {
  const needs = buildResolutionNeeds([
    member("retained", { merchant: "THE MIURA ROOFTOP TERRACE" }),
    member("source", { merchant: "MIURA TERRACE" }),
  ], "retained", ["source"]);
  const merchant = needs.find((need) => need.field === "merchant");
  assert.equal(merchant?.kind, "conflict");
  assert.equal(merchant?.required, false);
});
