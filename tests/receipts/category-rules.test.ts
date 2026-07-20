// Tests for lib/receipts/category-rules.ts (pure matching + proposal logic).
// No D1/network — the data functions are pure, exercised directly here.

import test from "node:test";
import assert from "node:assert/strict";
import {
  findCategorySuggestion,
  computeCategoryProposals,
  normalizeSender,
  senderDomainOf,
  isSenderAddressRule,
  receiptMatchKey,
  CATEGORY_RULE_PROPOSAL_THRESHOLD,
  type CategoryRule,
  type ProposalReceipt,
} from "@/lib/receipts/category-rules";

// ─── findCategorySuggestion ──────────────────────────────────────────────────

test("findCategorySuggestion: exact sender address match", () => {
  const rules: CategoryRule[] = [
    { matchType: "sender", matchValue: "david@gmail.com", expenseCategoryCode: "communications" },
  ];
  const s = findCategorySuggestion({ merchant: null, fromAddress: "David@Gmail.com" }, rules);
  assert.equal(s?.categoryCode, "communications");
  assert.equal(s?.matchedOn, "sender_exact");
});

test("findCategorySuggestion: sender domain matches any address at that domain", () => {
  const rules: CategoryRule[] = [
    { matchType: "sender", matchValue: "cloudflare.com", expenseCategoryCode: "communications" },
  ];
  assert.equal(
    findCategorySuggestion({ merchant: null, fromAddress: "billing@cloudflare.com" }, rules)?.categoryCode,
    "communications",
  );
  assert.equal(
    findCategorySuggestion({ merchant: null, fromAddress: "noreply@cloudflare.com" }, rules)?.categoryCode,
    "communications",
  );
  assert.equal(findCategorySuggestion({ merchant: null, fromAddress: "x@other.com" }, rules), null);
});

test("findCategorySuggestion: merchant match (reuses canonicalizeMerchant)", () => {
  const rules: CategoryRule[] = [
    { matchType: "merchant", matchValue: "Starbucks", expenseCategoryCode: "meeting" },
  ];
  assert.equal(
    findCategorySuggestion({ merchant: "Starbucks", fromAddress: null }, rules)?.categoryCode,
    "meeting",
  );
  assert.equal(findCategorySuggestion({ merchant: "OtherCafe", fromAddress: null }, rules), null);
});

test("findCategorySuggestion: no rule → null", () => {
  assert.equal(findCategorySuggestion({ merchant: "X", fromAddress: "a@b.com" }, []), null);
});

test("findCategorySuggestion: precedence exact-sender > merchant > sender-domain", () => {
  const rules: CategoryRule[] = [
    { matchType: "merchant", matchValue: "Cloudflare", expenseCategoryCode: "utilities" },
    { matchType: "sender", matchValue: "cloudflare.com", expenseCategoryCode: "communications" }, // domain
    { matchType: "sender", matchValue: "david@cloudflare.com", expenseCategoryCode: "supplies" }, // exact
  ];
  const s = findCategorySuggestion({ merchant: "Cloudflare", fromAddress: "david@cloudflare.com" }, rules);
  assert.equal(s?.matchedOn, "sender_exact");
  assert.equal(s?.categoryCode, "supplies");
});

test("findCategorySuggestion: merchant beats sender-domain", () => {
  const rules: CategoryRule[] = [
    { matchType: "sender", matchValue: "cloudflare.com", expenseCategoryCode: "communications" },
    { matchType: "merchant", matchValue: "Cloudflare", expenseCategoryCode: "utilities" },
  ];
  const s = findCategorySuggestion({ merchant: "Cloudflare", fromAddress: "david@cloudflare.com" }, rules);
  assert.equal(s?.matchedOn, "merchant");
  assert.equal(s?.categoryCode, "utilities");
});

// ─── computeCategoryProposals ────────────────────────────────────────────────

function receipt(over: Partial<ProposalReceipt> & { id: string }): ProposalReceipt {
  return {
    merchant: null,
    capturedBy: null,
    sourceType: "manual_upload",
    expenseCategoryCode: null,
    transactionDate: null,
    amountMinor: null,
    ...over,
  };
}

test("computeCategoryProposals: 3+ same category from a sender → proposed", () => {
  const receipts = [
    receipt({ id: "1", sourceType: "email_attachment", capturedBy: "x@cloudflare.com", expenseCategoryCode: "communications" }),
    receipt({ id: "2", sourceType: "email_attachment", capturedBy: "x@cloudflare.com", expenseCategoryCode: "communications" }),
    receipt({ id: "3", sourceType: "email_attachment", capturedBy: "x@cloudflare.com", expenseCategoryCode: "communications" }),
  ];
  const p = computeCategoryProposals(receipts, [], []);
  assert.equal(p.length, 1);
  assert.equal(p[0]!.matchType, "sender");
  assert.equal(p[0]!.matchValue, "x@cloudflare.com");
  assert.equal(p[0]!.expenseCategoryCode, "communications");
  assert.equal(p[0]!.count, 3);
  assert.equal(p[0]!.sourceReceiptIds.length, 3);
});

test("computeCategoryProposals: 2 → not proposed (below threshold)", () => {
  const receipts = [
    receipt({ id: "1", capturedBy: "x@c.com", sourceType: "email_attachment", expenseCategoryCode: "communications" }),
    receipt({ id: "2", capturedBy: "x@c.com", sourceType: "email_attachment", expenseCategoryCode: "communications" }),
  ];
  assert.equal(computeCategoryProposals(receipts, [], []).length, 0);
});

test("computeCategoryProposals: already covered by an active rule → not proposed", () => {
  const receipts = [
    receipt({ id: "1", capturedBy: "x@c.com", sourceType: "email_attachment", expenseCategoryCode: "communications" }),
    receipt({ id: "2", capturedBy: "x@c.com", sourceType: "email_attachment", expenseCategoryCode: "communications" }),
    receipt({ id: "3", capturedBy: "x@c.com", sourceType: "email_attachment", expenseCategoryCode: "communications" }),
  ];
  const active: CategoryRule[] = [
    { matchType: "sender", matchValue: "x@c.com", expenseCategoryCode: "utilities" },
  ];
  assert.equal(computeCategoryProposals(receipts, active, []).length, 0);
});

test("computeCategoryProposals: dismissed (match, category) → not re-proposed", () => {
  const receipts = [
    receipt({ id: "1", merchant: "Starbucks", sourceType: "manual_upload", expenseCategoryCode: "meeting" }),
    receipt({ id: "2", merchant: "Starbucks", sourceType: "manual_upload", expenseCategoryCode: "meeting" }),
    receipt({ id: "3", merchant: "Starbucks", sourceType: "manual_upload", expenseCategoryCode: "meeting" }),
  ];
  const dismissals = [{ matchType: "merchant" as const, matchValue: "Starbucks", expenseCategoryCode: "meeting" }];
  assert.equal(computeCategoryProposals(receipts, [], dismissals).length, 0);
});

test("computeCategoryProposals: different category after a dismissal → still proposed", () => {
  const receipts = [
    receipt({ id: "1", merchant: "Starbucks", expenseCategoryCode: "meeting" }),
    receipt({ id: "2", merchant: "Starbucks", expenseCategoryCode: "meeting" }),
    receipt({ id: "3", merchant: "Starbucks", expenseCategoryCode: "meeting" }),
    receipt({ id: "4", merchant: "Starbucks", expenseCategoryCode: "supplies" }),
    receipt({ id: "5", merchant: "Starbucks", expenseCategoryCode: "supplies" }),
    receipt({ id: "6", merchant: "Starbucks", expenseCategoryCode: "supplies" }),
  ];
  const dismissals = [{ matchType: "merchant" as const, matchValue: "Starbucks", expenseCategoryCode: "meeting" }];
  const p = computeCategoryProposals(receipts, [], dismissals);
  assert.equal(p.length, 1);
  assert.equal(p[0]!.expenseCategoryCode, "supplies");
});

test("computeCategoryProposals: uncategorized receipts ignored", () => {
  const receipts = [
    receipt({ id: "1", merchant: "Starbucks", expenseCategoryCode: null }),
    receipt({ id: "2", merchant: "Starbucks", expenseCategoryCode: null }),
    receipt({ id: "3", merchant: "Starbucks", expenseCategoryCode: null }),
  ];
  assert.equal(computeCategoryProposals(receipts, [], []).length, 0);
});

test("computeCategoryProposals: non-email receipts key on merchant", () => {
  const receipts = [
    receipt({ id: "1", merchant: "Cloudflare", sourceType: "manual_upload", expenseCategoryCode: "communications" }),
    receipt({ id: "2", merchant: "Cloudflare", sourceType: "manual_upload", expenseCategoryCode: "communications" }),
    receipt({ id: "3", merchant: "Cloudflare", sourceType: "manual_upload", expenseCategoryCode: "communications" }),
  ];
  const p = computeCategoryProposals(receipts, [], []);
  assert.equal(p.length, 1);
  assert.equal(p[0]!.matchType, "merchant");
  assert.equal(p[0]!.matchValue, "Cloudflare");
});

// ─── helpers ─────────────────────────────────────────────────────────────────

test("normalizeSender / senderDomainOf / isSenderAddressRule", () => {
  assert.equal(normalizeSender("  David@Gmail.com  "), "david@gmail.com");
  assert.equal(senderDomainOf("david@cloudflare.com"), "cloudflare.com");
  assert.equal(senderDomainOf("not-an-email"), null);
  assert.equal(isSenderAddressRule("david@gmail.com"), true);
  assert.equal(isSenderAddressRule("cloudflare.com"), false);
});

test("receiptMatchKey: email source → sender; other → merchant; none → null", () => {
  assert.deepEqual(
    receiptMatchKey({ sourceType: "email_body", capturedBy: "X@Y.com", merchant: "M" }),
    { matchType: "sender", matchValue: "x@y.com" },
  );
  assert.deepEqual(
    receiptMatchKey({ sourceType: "manual_upload", capturedBy: null, merchant: "Starbucks" }),
    { matchType: "merchant", matchValue: "Starbucks" },
  );
  assert.equal(receiptMatchKey({ sourceType: "manual_upload", capturedBy: null, merchant: null }), null);
});

test("CATEGORY_RULE_PROPOSAL_THRESHOLD is 3", () => {
  assert.equal(CATEGORY_RULE_PROPOSAL_THRESHOLD, 3);
});
