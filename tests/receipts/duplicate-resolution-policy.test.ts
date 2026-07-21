import test from "node:test";
import assert from "node:assert/strict";
import {
  recommendRetention,
  completeness,
  protectionTier,
  canPurge,
  type DuplicateMemberInput,
} from "@/lib/receipts/duplicate-resolution-policy";

let n = 0;
/** Minimal member: unregistered, reviewed, no accounting fields populated. */
function m(partial: Partial<DuplicateMemberInput> & Pick<DuplicateMemberInput, "id">): DuplicateMemberInput {
  n += 1;
  return {
    captured_at: `2026-06-0${(n % 9) + 1}T00:00:0${n % 5}Z`,
    updated_at: `2026-06-0${(n % 9) + 1}T00:00:0${n % 5}Z`,
    status: "reviewed",
    exported: false,
    archived: false,
    claimedByConfirmedAmexLine: false,
    businessTripLinked: false,
    emailIntakePromoted: false,
    transaction_date: null,
    merchant: null,
    amount_minor: null,
    currency: "JPY",
    expense_category_code: null,
    business_purpose: null,
    tax_amount_minor: null,
    tax_rate: null,
    invoice_registration_number: null,
    qualified_invoice_status: "not_checked",
    counterparty_name: null,
    attendeesRequired: false,
    attendeesCount: 0,
    attendeeNames: [],
    extractionState: null,
    hasOriginalFile: false,
    hasProofFile: false,
    ...partial,
  } as DuplicateMemberInput;
}

// ─── protection tier ─────────────────────────────────────────────────────────

test("tier: exported / AMEX-claimed / archived / reconciled are protected (cannot purge)", () => {
  for (const over of [
    { exported: true },
    { archived: true },
    { claimedByConfirmedAmexLine: true },
    { status: "reconciled" as const },
  ]) {
    const mm = m({ id: "x", ...over });
    assert.equal(protectionTier(mm).tier, "protected");
    assert.equal(canPurge(mm), false);
  }
});

test("tier: business-trip / email-intake linkage is registered (still purgeable)", () => {
  for (const over of [{ businessTripLinked: true }, { emailIntakePromoted: true }]) {
    const mm = m({ id: "x", ...over });
    assert.equal(protectionTier(mm).tier, "registered");
    assert.equal(canPurge(mm), true);
  }
  assert.equal(protectionTier(m({ id: "u" })).tier, "unregistered");
});

// ─── precedence rule 1: protected/registered retained over unregistered ──────

test("rule 1: a protected (claimed) receipt is retained over a more-complete unregistered one", () => {
  // 岡芳 shape: f3e866f6 is the matched canonical (claimed) vs an unregistered dup.
  const retained = m({ id: "f3e866f6", claimedByConfirmedAmexLine: true, merchant: "岡芳商店", amount_minor: 3862 });
  const dup = m({ id: "c118d6b5", merchant: "岡芳商店", amount_minor: 3862, expense_category_code: "supplies", business_purpose: "stationery" });
  const r = recommendRetention([retained, dup]);
  assert.equal(r.retainedId, "f3e866f6");
  assert.equal(r.assessments.get("f3e866f6")!.canPurge, false);
  assert.equal(r.assessments.get("c118d6b5")!.canPurge, true);
});

test("rule 1: registered (trip-linked) retained over unregistered at equal completeness", () => {
  const reg = m({ id: "reg", businessTripLinked: true, merchant: "X", amount_minor: 100 });
  const unreg = m({ id: "unreg", merchant: "X", amount_minor: 100 });
  assert.equal(recommendRetention([reg, unreg]).retainedId, "reg");
});

// ─── precedence rule 2: higher completeness ──────────────────────────────────

test("rule 2: among same-tier unregistered, the more complete record is retained", () => {
  const rich = m({ id: "rich", merchant: "PERFECT", amount_minor: 14040, expense_category_code: "entertainment", business_purpose: "client drinks", tax_amount_minor: 1276, invoice_registration_number: "T123" });
  const poor = m({ id: "poor", merchant: "PERFECT", amount_minor: 14040 });
  const r = recommendRetention([poor, rich]); // input order shouldn't matter
  assert.equal(r.retainedId, "rich");
  assert.ok(r.retainedReasons.includes("More complete record"));
});

// ─── precedence rule 3: tie → earliest capture ───────────────────────────────

test("rule 3: tied tier + completeness → earliest capture retained (original record)", () => {
  const early = m({ id: "early", captured_at: "2026-06-09T00:00:00Z", merchant: "HOLIDAY SKY LOUNGE 新宿", amount_minor: 10680 });
  const late = m({ id: "late", captured_at: "2026-07-04T00:00:00Z", merchant: "HOLIDAY SKY LOUNGE 新宿", amount_minor: 10680 });
  const r = recommendRetention([late, early]);
  assert.equal(r.retainedId, "early");
  assert.ok(r.retainedReasons.some((x) => x.includes("Earliest capture")));
});

// ─── rule 6: target-only populated field blocks purge ────────────────────────

test("rule 6: target has invoice_number missing from retained → blocked + required transfer", () => {
  // Retained is chosen by TIER (claimed → protected) even though the target is
  // more complete; the target's extra populated fields must transfer first.
  const retained = m({ id: "ret", claimedByConfirmedAmexLine: true, merchant: "X", amount_minor: 100 });
  const target = m({ id: "tgt", merchant: "X", amount_minor: 100, invoice_registration_number: "T999", counterparty_name: "Acme" });
  const r = recommendRetention([retained, target]);
  assert.equal(r.retainedId, "ret");
  assert.equal(r.blocked, true);
  const transfer = r.requiredTransfers.find((t) => t.fromId === "tgt");
  assert.ok(transfer, "expected a required transfer from tgt");
  assert.ok(transfer!.fields.includes("invoice_number"));
  assert.ok(transfer!.fields.includes("counterparty"));
  assert.ok(r.blockReasons.some((b) => b.includes("Purge blocked")));
});

test("rule 6: does not block when retained is at least as complete as target", () => {
  const retained = m({ id: "ret", merchant: "X", amount_minor: 100, expense_category_code: "supplies" });
  const target = m({ id: "tgt", merchant: "X", amount_minor: 100 });
  const r = recommendRetention([retained, target]);
  assert.equal(r.blocked, false);
  assert.equal(r.requiredTransfers.length, 0);
});

// ─── rule 5 / multi-protected: never purge a protected receipt ────────────────

test("two protected members → blocked (neither can be purged)", () => {
  const a = m({ id: "a", claimedByConfirmedAmexLine: true, merchant: "X", amount_minor: 1 });
  const b = m({ id: "b", claimedByConfirmedAmexLine: true, merchant: "X", amount_minor: 1, business_purpose: "p" });
  const r = recommendRetention([a, b]);
  assert.equal(r.assessments.get("a")!.canPurge, false);
  assert.equal(r.assessments.get("b")!.canPurge, false);
  assert.equal(r.blocked, true);
  assert.ok(r.blockReasons.some((x) => x.includes("protected")));
});

// ─── conflicts (rule 7) ───────────────────────────────────────────────────────

test("conflicts: divergent populated merchant + amount are surfaced", () => {
  const a = m({ id: "a", merchant: "PERFECT", amount_minor: 14040 });
  const b = m({ id: "b", merchant: "PBK四ッ谷/Air", amount_minor: 14040 });
  const r = recommendRetention([a, b]);
  const merchants = r.conflicts.find((c) => c.field === "merchant");
  assert.ok(merchants && merchants.values.length === 2);
  // amount identical → not a conflict
  assert.equal(r.conflicts.some((c) => c.field === "amount"), false);
});

// ─── real shapes ─────────────────────────────────────────────────────────────

test("NFCTAGS shape: matched (mobile) retained over desktop-PDF unregistered dup", () => {
  const matched = m({ id: "8d71768d", claimedByConfirmedAmexLine: true, merchant: "NFCTAGS", amount_minor: 5940 });
  const dup = m({ id: "244e5467", merchant: "株式会社ファイン・ラベル", amount_minor: 5940 });
  assert.equal(recommendRetention([matched, dup]).retainedId, "8d71768d");
});

test("MIURA shape: exported canonical retained; needs_review dup is the purge target", () => {
  const exported = m({ id: "c26d2d25", exported: true, merchant: "THE MIURA ROOFTOP TERRACE", amount_minor: 7362 });
  const dup = m({ id: "219471f9", status: "needs_review", merchant: "THE MIURA ROOFTOP TERRACE", amount_minor: 7362 });
  const r = recommendRetention([exported, dup]);
  assert.equal(r.retainedId, "c26d2d25");
  assert.equal(r.assessments.get("219471f9")!.canPurge, true);
});

test("HOLIDAY triple: all unregistered + equal → exactly one retained (earliest), two purge targets", () => {
  const a = m({ id: "dabbd12e", captured_at: "2026-06-09T11:00:00Z", merchant: "HOLIDAY SKY LOUNGE 新宿", amount_minor: 10680 });
  const b = m({ id: "f9d41d48", captured_at: "2026-06-20T03:46:00Z", merchant: "Holiday Sky Lounge 新宿", amount_minor: 10680 });
  const c = m({ id: "42d3e5cc", captured_at: "2026-07-04T23:19:00Z", merchant: "HOLIDAY SKY LOUNGE 新宿", amount_minor: 10680 });
  const r = recommendRetention([a, b, c]);
  assert.equal(r.retainedId, "dabbd12e");
  const purgeTargets = [a, b, c].filter((x) => x.id !== r.retainedId);
  assert.equal(purgeTargets.length, 2);
  assert.equal(purgeTargets.every((x) => r.assessments.get(x.id)!.canPurge), true);
});

// ─── completeness scoring sanity ──────────────────────────────────────────────

test("completeness: counts only meaningful accounting fields; ignores defaults", () => {
  const empty = m({ id: "empty" });
  // No accounting fields populated; only the attendees parameter is satisfied
  // (not required by category → no gap). Score 1, not 0, and it is uniform across
  // same-category dups so it never biases the comparison.
  assert.equal(completeness(empty).score, 1);
  assert.deepEqual(completeness(empty).completed, ["attendees"]);
});

test("completeness: attendees field completed when not required (no gap) OR present when required", () => {
  assert.equal(completeness(m({ id: "a", attendeesRequired: false })).completed.includes("attendees"), true);
  assert.equal(completeness(m({ id: "b", attendeesRequired: true, attendeesCount: 0 })).completed.includes("attendees"), false);
  assert.equal(completeness(m({ id: "c", attendeesRequired: true, attendeesCount: 2 })).completed.includes("attendees"), true);
});

test("completeness: 'not_checked' invoice status without a number is NOT complete", () => {
  const c = completeness(m({ id: "x", qualified_invoice_status: "not_checked" }));
  assert.equal(c.completed.includes("invoice_number"), false);
});
