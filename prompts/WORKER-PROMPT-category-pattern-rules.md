ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Category suggestions from recognized sender/merchant patterns

New capability: the system notices when receipts from the same sender or
merchant keep getting the same expense category, offers to turn that into
a rule, and — once accepted — pre-fills the category (as a visible
suggestion, never silently) on future receipts/AMEX lines matching that
rule. Intent (David's own words): "continuously build out automation based
on recognized and accepted patterns."

## Read this first — the boundary this feature sits next to

`lib/receipts/extraction.ts:323-326,445-448` sets `expenseCategoryCode:
null` at capture time with the comment "Category/attendees remain a
reviewer judgment, never machine-invented." This feature does NOT change
that principle — it never sets `expense_category_code` automatically. It
only ever offers a pre-filled SUGGESTION that still requires an explicit
operator accept, through the exact same save path as picking a category
manually. If you find yourself writing code that sets
`expense_category_code` without a human click in between, stop — that's
not what was approved.

## Decisions already made with the operator (do not revisit)

1. **Rule creation: system proposes, operator explicitly accepts.** Not
   manual-entry-only, not silent auto-learning. The system surfaces "you've
   categorized N receipts from X as Y — make this a rule?" on a Settings
   page; nothing becomes a rule without a click.
2. **Suggestions never auto-confirm.** A matched rule pre-fills a VISIBLE
   suggestion affordance, not the live `expense_category_code` field
   itself — see §4's UI note on why this is a distinct affordance rather
   than silently pre-selecting the dropdown (autosave risk).
3. **Scope: category only**, not attendees/description/other fields. The
   data model may generalize later; don't build that now.

## 1. Data model

`ls db/receipts/*.sql` to confirm the next migration number (0029 is
taken).

```sql
CREATE TABLE merchant_category_rules (
  id TEXT PRIMARY KEY,
  match_type TEXT NOT NULL CHECK (match_type IN ('sender', 'merchant')),
  match_value TEXT NOT NULL,       -- normalized sender address/domain OR canonicalized merchant key
  expense_category_code TEXT NOT NULL,
  accepted_by TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  source_receipt_ids_json TEXT     -- the receipts that established the pattern, for audit traceability
);
CREATE UNIQUE INDEX idx_category_rules_match ON merchant_category_rules(match_type, match_value);

-- Proposals the operator explicitly said no to, so the settings page
-- doesn't keep re-surfacing something already declined. Scoped to the
-- specific (match, category) pair — if a different category later becomes
-- dominant for the same sender/merchant, that's a NEW proposal, not
-- suppressed by an old dismissal of a different category.
CREATE TABLE category_rule_dismissals (
  match_type TEXT NOT NULL CHECK (match_type IN ('sender', 'merchant')),
  match_value TEXT NOT NULL,
  expense_category_code TEXT NOT NULL,
  dismissed_by TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (match_type, match_value, expense_category_code)
);
```

No new columns on `receipt_records` or `amex_statement_lines` for the
suggestion state itself — see §3 for why, and the one open question about
`amex_statement_lines.category_status` I need your read on.

## 2. Rule matching (`lib/receipts/category-rules.ts`, new file, pure)

```ts
export interface CategoryRule {
  matchType: "sender" | "merchant";
  matchValue: string;
  expenseCategoryCode: string;
}
export function findCategorySuggestion(
  input: { merchant: string | null; fromAddress: string | null },
  rules: CategoryRule[],
): { categoryCode: string; rule: CategoryRule } | null
```

- **Sender matching** supports BOTH exact address and domain-level rules
  (e.g. a rule on `cloudflare.com` matches `billing@cloudflare.com` AND
  `noreply@cloudflare.com`). Pick a clean `match_value` encoding for the
  two cases (e.g. bare domain vs full address, distinguished by presence
  of `@`) — your call, just support both.
- **Merchant matching** reuses the EXISTING canonicalization/alias logic —
  do NOT write a new fuzzy-matcher. `lib/receipts/merchant.ts`
  (`canonicalizeMerchant`) and `lib/receipts/reconciliation.ts`'s
  `descriptionContains`/`merchantAliasMatch` are the established single
  sources of truth for "are these the same merchant" — reuse them here so
  a merchant rule matches consistently with how the rest of the system
  already treats merchant identity.
- `fromAddress` for a receipt is `receipt_records`'s `captured_by` field
  when `source_type` is `email_attachment`/`email_body` (confirmed
  precedent: `promoteBodyIntake` sets `capturedBy: intake.from_address`) —
  null/not applicable for other source types.

## 3. Where suggestions surface — investigate before choosing the mechanism

**Receipts (`components/receipts/review/form-pane.tsx`):** compute the
suggestion LIVE (call `findCategorySuggestion` against the current rules +
this receipt's merchant/capturedBy) whenever `expense_category_code` is
null. No new column needed — nothing to keep in sync, always fresh against
current rules.

**AMEX lines:** `types.ts:68` / `amex_statement_lines.category_status`
already has a `"suggested"` enum value with NO current producer anywhere in
the codebase (confirmed by architect investigation) — looks like exactly
this feature was anticipated but never built. **Investigate before
deciding:** does the existing AMEX UI (`inline-category-cell.tsx`,
`reconcile-screen.tsx`) already have real conditional rendering for
`category_status === "suggested"` that would make writing `category_status
= 'suggested'` + `expense_category_code` at AMEX IMPORT time (persisted)
meaningfully less work than computing live the same way as receipts? If
yes, use the existing enum slot (write it in the import path,
`netanswerLinesToImportInputs`/`importAmexLines`). If the existing UI
treats `"suggested"` as effectively a no-op today (no real branching), just
compute live for AMEX lines too, matching the receipt approach for one
consistent mechanism. Report which you chose and why — this is a
"flag it, don't guess" item, not a big one, but I want your read on the
existing code before we commit to persisted vs. live.

Either way: a suggestion is ONLY relevant when `expense_category_code` is
currently null (never override an already-set category), and — for AMEX
lines — only when the line has NO matched receipt (a matched receipt's
category is authoritative per `resolveLineCategory`,
`lib/receipts/line-classification.ts:15-26`; suggesting on a line whose
category will be shadowed anyway is pointless).

## 4. UI — explicit accept, not a pre-selected dropdown

When a suggestion exists, render a distinct affordance NEXT TO the
(still-empty) category field — e.g. a small pill/banner: `Suggested:
{category name} — matched rule: {sender/merchant} · Accept`. Do **not**
pre-select the `<select>`'s value to the suggested category. Reasoning: the
form has autosave-on-blur/debounce behavior (`form-pane.tsx`); a silently
pre-selected dropdown risks the operator tabbing past it and autosave
committing the suggestion as if they'd chosen it, with no genuine review
having happened. A distinct "Accept" action requires a real click, and
clicking it should populate the field via the exact same code path a
manual selection uses (same state setter, same save call) — so an accepted
suggestion is indistinguishable in the DB/audit trail from a manual pick
(this is intentional: the point is it WAS reviewed, once, by a human
clicking accept).

Mirror this in `inline-category-cell.tsx` for AMEX lines (adapt to
whatever UI shape §3's investigation lands on).

## 5. Settings page `/receipts/settings/category-rules`

Mirror `trusted-senders` page structure. Two sections:

**Active rules** — table of `match_type`, `match_value`, category, accepted
by/at, source receipt count (from `source_receipt_ids_json`, maybe a couple
of example dates/merchants). Remove button per row (delete + audit entry).

**Proposed rules** — computed on page load, NOT persisted as a queryable
entity (it's a live query, not a stored candidate):
- Group receipts (`expense_category_code IS NOT NULL`, `deleted_at IS
  NULL`) by `(matchType, matchValue)` — sender for
  email_attachment/email_body sources, merchant (canonicalized) otherwise.
- Where the SAME `expense_category_code` appears ≥3 times for that group
  (name this threshold as a constant, e.g.
  `CATEGORY_RULE_PROPOSAL_THRESHOLD = 3`, easy to tune later).
- Excluding any `(matchType, matchValue)` already covered by an active
  rule, AND excluding any `(matchType, matchValue, categoryCode)` present
  in `category_rule_dismissals`.
- Render each proposal with the supporting count + a couple of example
  receipts (merchant/date/amount), **Accept** (creates the
  `merchant_category_rules` row, audit-logged, `source_receipt_ids_json`
  populated from the matching receipt ids) and **Dismiss** (writes to
  `category_rule_dismissals`, audit-logged).

Link from the settings index (`app/(receipt-system)/receipts/settings/
page.tsx`) same pattern as the trusted-senders `<li>`.

## 6. API routes

`app/api/receipts/settings/category-rules/route.ts` — GET (active rules +
computed proposals), POST (accept a proposal → create rule, body `{
matchType, matchValue, expenseCategoryCode, sourceReceiptIds }`), DELETE
(remove an active rule). Separate POST for dismiss (or a `?action=dismiss`
variant — your call, keep it simple). Clerk-auth only
(`requireReceiptsActor`) — this is a human-facing settings surface, no
processor-key variant needed (unlike the email-intake routes, nothing here
is called by the Mac consumer).

## 7. Guardrails to verify explicitly (not just assume)

- `missing_category` compliance check (`compliance.ts:79-85`) is
  completely unaffected — a suggestion sitting unaccepted must still
  correctly block export, since `expense_category_code` stays null until
  a human clicks Accept. Add a regression test confirming this.
- Deleting/revoking an active rule must NOT retroactively touch any
  receipt that already had a category set (via that rule or otherwise) —
  rules only ever affect future suggestions, never rewrite history.
- Proposal generation only ever considers receipts where
  `expense_category_code` was set by a human (which, given §2/§4's
  guarantee that nothing auto-sets it, is true of every set value today —
  no additional filtering needed, but worth a test asserting proposals
  don't somehow bootstrap off an unaccepted suggestion).

## 8. Tests

- `category-rules.ts`: sender exact match, sender domain match, merchant
  match (via canonicalization/alias reuse — not a new matcher), no match,
  existing category present → no suggestion regardless of rule match.
- Proposal computation: 3+ same-category receipts from one sender/merchant
  → proposed; 2 → not proposed; already-covered by an active rule → not
  re-proposed; dismissed → not re-proposed; a DIFFERENT category for the
  same sender/merchant after a dismissal of another category → still
  proposed (per the composite dismissal key).
- Compliance regression test from §7.
- Full existing suite: zero regressions.

## 9. Verification & report (required)

Against live bindings:

1. Manufacture (or find) 3 real receipts from the same sender/merchant
   with the same category; confirm the proposal surfaces on the settings
   page with correct supporting count/examples.
2. Accept it; confirm the rule appears in Active rules, and a NEW
   uncategorized receipt/AMEX line from that sender/merchant now shows the
   suggestion affordance (not a pre-selected dropdown).
3. Click Accept on the suggestion; confirm it saves exactly like a manual
   pick (audit entry, same shape as any other category save).
4. Dismiss a different proposal; confirm it doesn't reappear on reload.
5. Remove an active rule; confirm past receipts categorized via it are
   untouched.
6. `npm test`, `tsc --noEmit`, `npm run build:cf` clean.

Report back: which mechanism you chose for §3 (live vs. persisted
`category_status`) and why, test counts, and explicit pass/fail per step
above. Do not deploy — the architect verifies independently before deploy.
