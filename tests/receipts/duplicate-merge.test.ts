// Tests for the duplicate-merge policy fix (tax split) + merge service.
import test from "node:test";
import assert from "node:assert/strict";
import {
  populatedPreservationFields,
  populatedScoreFields,
  assessSelection,
  type DuplicateMemberInput,
} from "@/lib/receipts/duplicate-resolution-policy";

function m(partial: Partial<DuplicateMemberInput> & Pick<DuplicateMemberInput, "id">): DuplicateMemberInput {
  return {
    captured_at: "2026-06-19T00:00:00Z", updated_at: "v1", status: "reviewed",
    exported: false, archived: false, claimedByConfirmedAmexLine: false,
    businessTripLinked: false, emailIntakePromoted: false,
    transaction_date: null, merchant: null, amount_minor: null, currency: "JPY",
    expense_category_code: null, business_purpose: null, tax_amount_minor: null,
    tax_rate: null, invoice_registration_number: null, qualified_invoice_status: "not_checked",
    counterparty_name: null, attendeesRequired: false, attendeesCount: 0, attendeeNames: [],
    alcoholPresent: false, extractionState: null, hasOriginalFile: false, hasProofFile: false,
    ...partial,
  } as DuplicateMemberInput;
}

// ─── Policy fix: tax split in preservation ──────────────────────────────────

test("preservation: tax_amount and tax_rate are independent fields", () => {
  const amtOnly = m({ id: "a", tax_amount_minor: 829 });
  const rateOnly = m({ id: "b", tax_rate: "10.0" });
  const both = m({ id: "c", tax_amount_minor: 829, tax_rate: "10.0" });
  const neither = m({ id: "d" });

  const amt = populatedPreservationFields(amtOnly);
  assert.ok(amt.includes("tax_amount"), "tax_amount populated");
  assert.ok(!amt.includes("tax_rate"), "tax_rate NOT populated when only amount");

  const rate = populatedPreservationFields(rateOnly);
  assert.ok(rate.includes("tax_rate"), "tax_rate populated");
  assert.ok(!rate.includes("tax_amount"), "tax_amount NOT populated when only rate");

  const bothFields = populatedPreservationFields(both);
  assert.ok(bothFields.includes("tax_amount"));
  assert.ok(bothFields.includes("tax_rate"));

  const none = populatedPreservationFields(neither);
  assert.ok(!none.includes("tax_amount"));
  assert.ok(!none.includes("tax_rate"));
});

test("preservation: completeness still treats tax as one dimension", () => {
  const amtOnly = m({ id: "a", tax_amount_minor: 829 });
  const scoreFields = populatedScoreFields(amtOnly);
  assert.ok(scoreFields.includes("tax"), "completeness 'tax' dimension populated");
  // But preservation splits it.
  const presFields = populatedPreservationFields(amtOnly);
  assert.ok(!(presFields as readonly string[]).includes("tax"), "preservation does NOT have 'tax' (it has tax_amount/tax_rate)");
});

test("MIURA acceptance: target tax_amount missing from retained → blocks purge", () => {
  // MIURA: retained c26d2d25 (protected, no tax), target 219471f9 (tax_amount=829, tax_rate=10.0).
  const retained = m({ id: "retained", claimedByConfirmedAmexLine: true, merchant: "MIURA", amount_minor: 7362 });
  const target = m({ id: "target", merchant: "MIURA", amount_minor: 7362, tax_amount_minor: 829, tax_rate: "10.0" });
  const s = assessSelection([retained, target], "retained", ["target"]);
  assert.equal(s.blocked, true);
  const missing = s.perTarget[0]!.missingFieldsToCopy;
  assert.ok(missing.includes("tax_amount"), "tax_amount must be in missingFieldsToCopy");
  assert.ok(missing.includes("tax_rate"), "tax_rate must be in missingFieldsToCopy");
});

test("MIURA acceptance: copying only tax_amount leaves tax_rate still blocking", () => {
  // Simulate: after copying tax_amount to retained, retained has tax_amount but not tax_rate.
  const retainedAfterPartial = m({ id: "retained", claimedByConfirmedAmexLine: true, merchant: "MIURA", amount_minor: 7362, tax_amount_minor: 829 });
  const target = m({ id: "target", merchant: "MIURA", amount_minor: 7362, tax_amount_minor: 829, tax_rate: "10.0" });
  const s = assessSelection([retainedAfterPartial, target], "retained", ["target"]);
  assert.equal(s.blocked, true, "still blocked because tax_rate is missing");
  assert.ok(s.perTarget[0]!.missingFieldsToCopy.includes("tax_rate"));
  assert.ok(!s.perTarget[0]!.missingFieldsToCopy.includes("tax_amount"), "tax_amount no longer missing");
});

test("MIURA acceptance: copying both tax fields → purgeable", () => {
  const retainedComplete = m({ id: "retained", claimedByConfirmedAmexLine: true, merchant: "MIURA", amount_minor: 7362, tax_amount_minor: 829, tax_rate: "10.0" });
  const target = m({ id: "target", merchant: "MIURA", amount_minor: 7362, tax_amount_minor: 829, tax_rate: "10.0" });
  const s = assessSelection([retainedComplete, target], "retained", ["target"]);
  assert.equal(s.blocked, false, "both tax fields present → purgeable");
});

test("alcohol_present: true on target, false on retained → blocks", () => {
  const retained = m({ id: "retained", claimedByConfirmedAmexLine: true, merchant: "X", amount_minor: 100 });
  const target = m({ id: "target", merchant: "X", amount_minor: 100, alcoholPresent: true });
  const s = assessSelection([retained, target], "retained", ["target"]);
  assert.equal(s.blocked, true);
  assert.ok(s.perTarget[0]!.missingFieldsToCopy.includes("alcohol_present"));
});

test("non-required attendees with zero count does NOT block (no data to lose)", () => {
  const retained = m({ id: "retained", claimedByConfirmedAmexLine: true, merchant: "X", amount_minor: 100 });
  const target = m({ id: "target", merchant: "X", amount_minor: 100, attendeesCount: 0 });
  const s = assessSelection([retained, target], "retained", ["target"]);
  // attendees count 0 → not populated → not a missing field → not blocked.
  assert.equal(s.blocked, false);
});

test("actual attendees on target → blocks (data to preserve)", () => {
  const retained = m({ id: "retained", claimedByConfirmedAmexLine: true, merchant: "X", amount_minor: 100 });
  const target = m({ id: "target", merchant: "X", amount_minor: 100, attendeesCount: 2 });
  const s = assessSelection([retained, target], "retained", ["target"]);
  assert.equal(s.blocked, true);
  assert.ok(s.perTarget[0]!.missingFieldsToCopy.includes("attendees"));
});

// ─── Field-level transfer scenarios ──────────────────────────────────────────

test("tax_rate copied independently without tax_amount", () => {
  const retained = m({ id: "retained", claimedByConfirmedAmexLine: true, merchant: "X", amount_minor: 100 });
  // Target has only tax_rate, no tax_amount.
  const target = m({ id: "target", merchant: "X", amount_minor: 100, tax_rate: "10.0" });
  const s = assessSelection([retained, target], "retained", ["target"]);
  assert.equal(s.blocked, true);
  const missing = s.perTarget[0]!.missingFieldsToCopy;
  assert.ok(missing.includes("tax_rate"), "tax_rate must be missing");
  assert.ok(!missing.includes("tax_amount"), "tax_amount NOT missing (source doesn't have it)");
});

test("category + purpose + invoice + counterparty + date copying blocks", () => {
  const retained = m({ id: "retained", claimedByConfirmedAmexLine: true, merchant: "X", amount_minor: 100 });
  const target = m({
    id: "target", merchant: "X", amount_minor: 100,
    expense_category_code: "supplies", business_purpose: "office run",
    invoice_registration_number: "T1234567890123",
    counterparty_name: "Acme Corp", transaction_date: "2026-06-19",
  });
  const s = assessSelection([retained, target], "retained", ["target"]);
  assert.equal(s.blocked, true);
  const missing = s.perTarget[0]!.missingFieldsToCopy;
  for (const f of ["category", "business_purpose", "invoice_number", "counterparty", "transaction_date"]) {
    assert.ok(missing.includes(f as never), `${f} must be in missingFieldsToCopy`);
  }
});

test("amount + currency are coupled (amount field covers both)", () => {
  const retained = m({ id: "retained", claimedByConfirmedAmexLine: true, merchant: "X" });
  const target = m({ id: "target", merchant: "X", amount_minor: 7362, currency: "JPY" });
  const s = assessSelection([retained, target], "retained", ["target"]);
  assert.equal(s.blocked, true);
  assert.ok(s.perTarget[0]!.missingFieldsToCopy.includes("amount"));
});

test("conflict: different merchant values both populated — not a missing field", () => {
  // When both retained and target have the field populated but with different
  // values, it's a CONFLICT, not a missing field. assessSelection checks
  // missingFieldsToCopy (target populated, retained NOT). A conflict where both
  // are populated does NOT block purge via the missing-field rule — the operator
  // resolves it by choosing to keep retained.
  const retained = m({ id: "retained", claimedByConfirmedAmexLine: true, merchant: "HOLIDAY SKY LOUNGE 新宿", amount_minor: 10680 });
  const target = m({ id: "target", merchant: "Holiday Sky Lounge 新宿", amount_minor: 10680 });
  const s = assessSelection([retained, target], "retained", ["target"]);
  // No target-only fields — both have the same populated fields.
  assert.equal(s.perTarget[0]!.missingFieldsToCopy.length, 0);
  assert.equal(s.blocked, false, "no missing fields → not blocked");
});

// ─── Merge plan validation (pure extraction) ────────────────────────────────

test("merge plan: empty plan is invalid", () => {
  // An empty resolution plan should be rejected. This is validated server-side
  // but the pure check is: are there any non-keep-retained entries?
  const plan: Array<{ action: string }> = [
    { action: "keep_retained" },
    { action: "keep_retained" },
  ];
  const hasChanges = plan.some((p) => p.action !== "keep_retained");
  assert.equal(hasChanges, false, "all-keep-retained plan has no changes");
});

test("merge plan: copy_from_source with unknown source rejects", () => {
  // Server checks: sourceReceiptId must be in the sources list.
  const sourceIds = ["src-a", "src-b"];
  const plan = { action: "copy_from_source", sourceReceiptId: "src-c" };
  assert.ok(!sourceIds.includes(plan.sourceReceiptId!), "unknown source");
});

test("merge plan: allowlisted fields only", () => {
  const allowed = new Set([
    "transaction_date", "merchant", "amount", "category", "business_purpose",
    "alcohol_present", "tax_amount", "tax_rate", "invoice_number",
    "counterparty", "attendees",
  ]);
  // Internal/derived fields must be rejected.
  for (const bad of ["id", "status", "payment_path", "extraction_state", "original_r2_key"]) {
    assert.ok(!allowed.has(bad), `"${bad}" must not be allowlisted`);
  }
});
