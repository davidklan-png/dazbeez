// Category pattern rules — pure matching + proposal logic. No D1, no network.
//
// The system proposes a rule when ≥3 receipts from the same sender/merchant
// share a category; the operator explicitly accepts on a Settings page; once a
// rule exists, matching receipts/AMEX lines get a VISIBLE suggestion affordance.
//
// PRINCIPLE (load-bearing): nothing here writes expense_category_code. A rule
// only produces a SUGGESTION; a human click (same PATCH path as a manual pick)
// sets the code. Callers must gate: only surface a suggestion when the receipt/
// line's expense_category_code is null (never override). extraction.ts:326,448
// sets it null at capture; compliance.ts:79 blocks export on null until a human
// acts — so an unaccepted suggestion never relieves the operator of categorizing.

import { canonicalizeMerchant } from "@/lib/receipts/merchant";
import { isCanonicalCode, type ExpenseCategoryCode } from "@/lib/receipts/categories";
import { createAuditEntry } from "@/lib/receipts/audit";
import { newUuid, nowIso, stringifyJson } from "@/lib/receipts/db-utils";

/** A sender/merchant must show the same category at least this many times to
 * surface as a proposed rule. Named so it's easy to tune. */
export const CATEGORY_RULE_PROPOSAL_THRESHOLD = 3;

export type CategoryMatchType = "sender" | "merchant";

export interface CategoryRule {
  matchType: CategoryMatchType;
  matchValue: string;
  expenseCategoryCode: ExpenseCategoryCode;
}

export interface CategorySuggestion {
  categoryCode: ExpenseCategoryCode;
  rule: CategoryRule;
  matchedOn: "sender_exact" | "sender_domain" | "merchant";
}

/** Receipt source types whose captured_by is a sender address. */
const SENDER_SOURCE_TYPES = new Set(["email_attachment", "email_body"]);

export function normalizeSender(value: string): string {
  return value.trim().toLowerCase();
}

/** Domain part of an email address (lowercased), or null if `value` has no @. */
export function senderDomainOf(value: string): string | null {
  const at = value.trim().toLowerCase().lastIndexOf("@");
  return at >= 0 ? value.trim().toLowerCase().slice(at + 1) : null;
}

/** A sender rule's matchValue is a full address (vs a bare domain) iff it has @. */
export function isSenderAddressRule(matchValue: string): boolean {
  return matchValue.includes("@");
}

/**
 * The (matchType, matchValue) key a receipt maps to, or null if it has no
 * categorizable identity. Email-source receipts key on sender (captured_by);
 * everything else keys on the canonicalized merchant. This is how proposals are
 * grouped, so a rule born from a pattern matches the same receipts going forward.
 */
export function receiptMatchKey(receipt: {
  sourceType: string | null;
  capturedBy: string | null;
  merchant: string | null;
}): { matchType: CategoryMatchType; matchValue: string } | null {
  if (
    receipt.sourceType &&
    SENDER_SOURCE_TYPES.has(receipt.sourceType) &&
    receipt.capturedBy
  ) {
    const addr = normalizeSender(receipt.capturedBy);
    if (addr) return { matchType: "sender", matchValue: addr };
  }
  if (receipt.merchant) {
    const key = canonicalizeMerchant(receipt.merchant);
    if (key) return { matchType: "merchant", matchValue: key };
  }
  return null;
}

function senderRuleMatches(rule: CategoryRule, fromAddress: string | null): boolean {
  if (!fromAddress) return false;
  if (isSenderAddressRule(rule.matchValue)) {
    return normalizeSender(fromAddress) === rule.matchValue; // exact address
  }
  return senderDomainOf(fromAddress) === rule.matchValue; // domain rule
}

function merchantRuleMatches(rule: CategoryRule, merchant: string | null): boolean {
  if (!merchant) return false;
  return canonicalizeMerchant(merchant) === rule.matchValue;
}

/**
 * Best category suggestion for a receipt/AMEX line, or null if no rule matches.
 *
 * Precedence (deterministic): exact-sender > merchant > sender-domain. Exact
 * sender is the most specific identity; merchant is an intentional, named match;
 * a domain rule is the broadest catch-all (so it yields to a specific merchant).
 *
 * The caller MUST only call this when the target's expense_category_code is null
 * — a suggestion never overrides an already-set category.
 */
export function findCategorySuggestion(
  input: { merchant: string | null; fromAddress: string | null },
  rules: readonly CategoryRule[],
): CategorySuggestion | null {
  const exactSender = rules.find(
    (r) =>
      r.matchType === "sender" &&
      isSenderAddressRule(r.matchValue) &&
      senderRuleMatches(r, input.fromAddress),
  );
  if (exactSender) {
    return { categoryCode: exactSender.expenseCategoryCode, rule: exactSender, matchedOn: "sender_exact" };
  }

  const merchant = rules.find(
    (r) => r.matchType === "merchant" && merchantRuleMatches(r, input.merchant),
  );
  if (merchant) {
    return { categoryCode: merchant.expenseCategoryCode, rule: merchant, matchedOn: "merchant" };
  }

  const domainSender = rules.find(
    (r) =>
      r.matchType === "sender" &&
      !isSenderAddressRule(r.matchValue) &&
      senderRuleMatches(r, input.fromAddress),
  );
  if (domainSender) {
    return { categoryCode: domainSender.expenseCategoryCode, rule: domainSender, matchedOn: "sender_domain" };
  }

  return null;
}

// ─── Proposal computation (settings page) ────────────────────────────────────

export interface ProposalReceipt {
  id: string;
  merchant: string | null;
  capturedBy: string | null;
  sourceType: string | null;
  expenseCategoryCode: string | null;
  transactionDate: string | null;
  amountMinor: number | null;
}

export interface CategoryProposal {
  matchType: CategoryMatchType;
  matchValue: string;
  expenseCategoryCode: ExpenseCategoryCode;
  count: number;
  sourceReceiptIds: string[];
  examples: {
    id: string;
    merchant: string | null;
    transactionDate: string | null;
    amountMinor: number | null;
  }[];
}

/**
 * Rule proposals from receipt history: for each (matchKey, category) appearing
 * ≥ threshold times, propose a rule — excluding any matchKey already covered by
 * an active rule (any category) and any (matchKey, category) the operator
 * previously dismissed. Pure; caller passes categorized receipts + active rules
 * + dismissals.
 */
export function computeCategoryProposals(
  receipts: readonly ProposalReceipt[],
  activeRules: readonly CategoryRule[],
  dismissals: readonly {
    matchType: CategoryMatchType;
    matchValue: string;
    expenseCategoryCode: string;
  }[],
  threshold: number = CATEGORY_RULE_PROPOSAL_THRESHOLD,
): CategoryProposal[] {
  const activeKeys = new Set(activeRules.map((r) => `${r.matchType}|${r.matchValue}`));
  const dismissalKeys = new Set(
    dismissals.map((d) => `${d.matchType}|${d.matchValue}|${d.expenseCategoryCode}`),
  );

  type Group = {
    matchType: CategoryMatchType;
    matchValue: string;
    category: string;
    receipts: ProposalReceipt[];
  };
  const groups = new Map<string, Group>();
  for (const r of receipts) {
    if (!r.expenseCategoryCode) continue; // only receipts a human categorized
    const key = receiptMatchKey(r);
    if (!key) continue;
    const gk = `${key.matchType}|${key.matchValue}|${r.expenseCategoryCode}`;
    let g = groups.get(gk);
    if (!g) {
      g = { matchType: key.matchType, matchValue: key.matchValue, category: r.expenseCategoryCode, receipts: [] };
      groups.set(gk, g);
    }
    g.receipts.push(r);
  }

  const proposals: CategoryProposal[] = [];
  for (const g of groups.values()) {
    if (g.receipts.length < threshold) continue;
    if (activeKeys.has(`${g.matchType}|${g.matchValue}`)) continue; // rule exists for this key
    if (dismissalKeys.has(`${g.matchType}|${g.matchValue}|${g.category}`)) continue; // dismissed
    proposals.push({
      matchType: g.matchType,
      matchValue: g.matchValue,
      expenseCategoryCode: g.category as ExpenseCategoryCode,
      count: g.receipts.length,
      sourceReceiptIds: g.receipts.map((r) => r.id),
      examples: g.receipts.slice(0, 3).map((r) => ({
        id: r.id,
        merchant: r.merchant,
        transactionDate: r.transactionDate,
        amountMinor: r.amountMinor,
      })),
    });
  }
  // Deterministic order: count desc, then matchValue for stability.
  proposals.sort((a, b) => b.count - a.count || a.matchValue.localeCompare(b.matchValue));
  return proposals;
}

// ─── DB access (injected db; mirrors trusted-senders.ts) ─────────────────────
//
// The functions above are pure matching/proposal logic. These are the CRUD
// functions the Settings page + API use. `db` is injected (testability
// precedent); callers pass getReceiptsDb().

export interface MerchantCategoryRuleRow {
  id: string;
  match_type: CategoryMatchType;
  match_value: string;
  expense_category_code: ExpenseCategoryCode;
  accepted_by: string;
  accepted_at: string;
  source_receipt_ids_json: string | null;
}

export interface CategoryRuleDismissalRow {
  match_type: CategoryMatchType;
  match_value: string;
  expense_category_code: string;
  dismissed_by: string;
  dismissed_at: string;
}

/** Normalize a rule key at write time: sender → lowercase; merchant → canonical. */
function normalizeMatchValue(matchType: CategoryMatchType, matchValue: string): string {
  return matchType === "sender" ? normalizeSender(matchValue) : canonicalizeMerchant(matchValue);
}

export async function listCategoryRules(db: D1Database): Promise<MerchantCategoryRuleRow[]> {
  const result = await db
    .prepare(
      `SELECT id, match_type, match_value, expense_category_code,
              accepted_by, accepted_at, source_receipt_ids_json
         FROM merchant_category_rules
        ORDER BY accepted_at DESC`,
    )
    .all<MerchantCategoryRuleRow>();
  return result.results ?? [];
}

export async function addCategoryRule(
  db: D1Database,
  input: {
    matchType: CategoryMatchType;
    matchValue: string;
    expenseCategoryCode: ExpenseCategoryCode;
    sourceReceiptIds?: string[];
  },
  actor: string,
): Promise<void> {
  if (input.matchType !== "sender" && input.matchType !== "merchant") {
    throw new Error(`Invalid match_type "${input.matchType}".`);
  }
  if (!isCanonicalCode(input.expenseCategoryCode)) {
    throw new Error(`Invalid expense_category_code "${String(input.expenseCategoryCode)}".`);
  }
  const matchValue = normalizeMatchValue(input.matchType, input.matchValue);
  if (!matchValue) throw new Error("match_value is empty after normalization.");

  const id = newUuid();
  const now = nowIso();
  const sourceJson =
    input.sourceReceiptIds && input.sourceReceiptIds.length > 0
      ? stringifyJson(input.sourceReceiptIds)
      : null;

  // Upsert — one rule per (match_type, match_value): re-accepting for the same
  // key (e.g. a different category) replaces the prior rule.
  await db
    .prepare(
      `INSERT INTO merchant_category_rules
         (id, match_type, match_value, expense_category_code,
          accepted_by, accepted_at, source_receipt_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_type, match_value) DO UPDATE SET
         expense_category_code = excluded.expense_category_code,
         accepted_by = excluded.accepted_by,
         accepted_at = excluded.accepted_at,
         source_receipt_ids_json = excluded.source_receipt_ids_json`,
    )
    .bind(id, input.matchType, matchValue, input.expenseCategoryCode, actor, now, sourceJson)
    .run();

  await createAuditEntry(db, {
    actor,
    action: "category_rule.created",
    objectType: "category_rule",
    objectId: `${input.matchType}:${matchValue}`,
    newValueJson: stringifyJson({
      matchType: input.matchType,
      matchValue,
      expenseCategoryCode: input.expenseCategoryCode,
      sourceReceiptIds: input.sourceReceiptIds ?? [],
    }),
  });
}

export async function removeCategoryRule(
  db: D1Database,
  id: string,
  actor: string,
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT match_type, match_value, expense_category_code
         FROM merchant_category_rules WHERE id = ?`,
    )
    .bind(id)
    .first<{ match_type: CategoryMatchType; match_value: string; expense_category_code: string }>();
  if (!row) return; // idempotent no-op

  await db.prepare(`DELETE FROM merchant_category_rules WHERE id = ?`).bind(id).run();

  await createAuditEntry(db, {
    actor,
    action: "category_rule.removed",
    objectType: "category_rule",
    objectId: `${row.match_type}:${row.match_value}`,
    oldValueJson: stringifyJson({
      matchType: row.match_type,
      matchValue: row.match_value,
      expenseCategoryCode: row.expense_category_code,
    }),
  });
}

export async function listDismissals(db: D1Database): Promise<CategoryRuleDismissalRow[]> {
  const result = await db
    .prepare(
      `SELECT match_type, match_value, expense_category_code, dismissed_by, dismissed_at
         FROM category_rule_dismissals
        ORDER BY dismissed_at DESC`,
    )
    .all<CategoryRuleDismissalRow>();
  return result.results ?? [];
}

export async function addDismissal(
  db: D1Database,
  input: {
    matchType: CategoryMatchType;
    matchValue: string;
    expenseCategoryCode: string;
  },
  actor: string,
): Promise<void> {
  const matchValue = normalizeMatchValue(input.matchType, input.matchValue);
  // Idempotent: re-dismissing the same (match, category) is a no-op.
  await db
    .prepare(
      `INSERT INTO category_rule_dismissals
         (match_type, match_value, expense_category_code, dismissed_by, dismissed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(match_type, match_value, expense_category_code) DO NOTHING`,
    )
    .bind(input.matchType, matchValue, input.expenseCategoryCode, actor, nowIso())
    .run();

  await createAuditEntry(db, {
    actor,
    action: "category_rule.dismissed",
    objectType: "category_rule",
    objectId: `${input.matchType}:${matchValue}`,
    newValueJson: stringifyJson({
      matchType: input.matchType,
      matchValue,
      expenseCategoryCode: input.expenseCategoryCode,
    }),
  });
}

/** Categorized, non-deleted receipts — the input to computeCategoryProposals. */
export async function listCategorizedReceiptsForProposals(
  db: D1Database,
): Promise<ProposalReceipt[]> {
  const result = await db
    .prepare(
      `SELECT id, merchant, captured_by, source_type, expense_category_code,
              transaction_date, amount_minor
         FROM receipt_records
        WHERE expense_category_code IS NOT NULL AND deleted_at IS NULL`,
    )
    .all<{
      id: string;
      merchant: string | null;
      captured_by: string | null;
      source_type: string | null;
      expense_category_code: string | null;
      transaction_date: string | null;
      amount_minor: number | null;
    }>();
  return (result.results ?? []).map((r) => ({
    id: r.id,
    merchant: r.merchant,
    capturedBy: r.captured_by,
    sourceType: r.source_type,
    expenseCategoryCode: r.expense_category_code,
    transactionDate: r.transaction_date,
    amountMinor: r.amount_minor,
  }));
}
