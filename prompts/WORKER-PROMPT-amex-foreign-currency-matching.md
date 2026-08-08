ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# AMEX foreign-currency matching — USD receipts vs JPY-converted statement lines

## Problem (confirmed by architect investigation)

Overseas-billed subscriptions (Cloudflare, Anthropic, etc.) are captured as
USD receipts (`receipt_records.currency = 'USD'`), but the AMEX Netアンサー
statement only reports the JPY-converted total in its structured amount
column (`amex_statement_lines.currency` is hardcoded `'JPY'` at
`lib/receipts/validation.ts:388`). The matching gate in
`lib/receipts/reconciliation.ts:169-173` (and the consolidation-phase
mirror at line 317) does a hard `continue` when `line.currency !==
receipt.currency` — so a USD receipt is **never even considered** as a
candidate against any JPY line today. This isn't a tolerance/rounding bug,
it's a total exclusion.

The USD amount for an overseas charge exists only as free text in the
charge row's `memo` field, e.g. `現地通貨額:11.51 USD`. **UPDATE — confirmed
against a real live SAISON statement screenshot from the operator
(2026-06/07 period), which also revealed a second signal we hadn't planned
for:** the row immediately following a foreign-billed charge (no date, no
amount, merchant text like `(SAN FRANCISCO)` — currently discarded by the
parser as a benign "informational row" at validation.ts:340-359, its memo
never persisted anywhere) carries the FX rate actually used, e.g.
`円換算レート:6/11 166.6377`. Three confirmed real examples (use these
verbatim as test fixtures, not synthetic ones — see §6):

| Date | Merchant | JPY amount | Charge-row memo | Continuation-row memo | Cross-check |
|---|---|---|---|---|---|
| 2026/06/11 | CLOUDFLARE | 1918 | `現地通貨額:11.51 USD` | `円換算レート:6/11 166.6377` | 11.51 × 166.6377 = 1918.06 → ¥1918 ✓ |
| 2026/06/23 | ANTHROPIC | 11098 | `現地通貨額:66.00 USD` | `円換算レート:6/23 168.1516` | 66.00 × 168.1516 = 11098.0 → ¥11098 ✓ |
| 2026/07/04 | CLOUDFLARE | 552 | `現地通貨額:3.30 USD` | `円換算レート:7/04 167.2728` | 3.30 × 167.2728 = 551.99 → ¥552 ✓ |

Marker format confirmed: half-width colon (`:`) after both `現地通貨額` and
`円換算レート`, decimal amount, single space before the currency code /
before the rate, `M/D` date prefix on the rate line. The regex assumptions
in §2 below match this real data — but still validate against whatever
memo variance exists across the rest of the current D1 dataset, since 3
samples isn't the full picture.

There is still no *authoritative* FX rate published anywhere outside these
memo lines — do not treat `円換算レート` as more trustworthy than the two
observed amounts. Its only job is to catch a bad parse (see §2), not to
convert currency for anything else.

## Decisions already made with the operator (do not revisit)

1. **Backfill in scope.** Re-parse `memo` on already-imported
   `amex_statement_lines` rows for months still open (not yet
   finalized in `amex_reconciliations`), so this cycle's stuck
   Cloudflare/Anthropic receipts get fixed without a re-import. Finalized
   months must be left untouched — they're immutable by the existing guard,
   and this change must not need to touch them.
2. **Parse failures must surface, not silently drop.** If a line's memo
   clearly contains the 現地通貨額 marker but the amount/currency can't be
   cleanly extracted (garbled text, unexpected spacing/punctuation), that is
   a distinct state from "no foreign currency at all" — flag it visibly in
   the reconcile UI (see §4) rather than letting it fall through
   indistinguishably into "unmatched." This matches the project's existing
   error-surfacing pattern (AGENTS.md backlog theme #12 — every failure path
   must be visible, not just logged).

## 1. Migration — new columns on `amex_statement_lines`

New file `db/receipts/0026_amex_foreign_currency.sql` (next number after
`0025_email_intake_to_address.sql`):

```sql
ALTER TABLE amex_statement_lines ADD COLUMN foreign_amount_minor INTEGER;
ALTER TABLE amex_statement_lines ADD COLUMN foreign_currency TEXT;
ALTER TABLE amex_statement_lines ADD COLUMN foreign_exchange_rate REAL;
ALTER TABLE amex_statement_lines ADD COLUMN memo_currency_parse_status TEXT;
```

`foreign_exchange_rate` is new since the operator's screenshot review —
the rate parsed off the continuation row (§2), stored purely as an
informational cross-check / audit value. It is never authoritative and is
never used to convert anything; matching still compares
`foreign_amount_minor` directly against the receipt's amount (§4).

- `foreign_amount_minor`: the parsed foreign-currency amount in the same
  minor-unit convention already used elsewhere (cents for non-JPY — see
  `receipt_records.amount_minor` convention in `lib/receipts/extraction.ts`
  `parseAmountMinor`). Sign must match the line's own sign (a refund line's
  foreign amount is also negative) — the memo text itself is a magnitude
  only, so inherit the sign from `amount_minor`.
- `foreign_currency`: ISO code, e.g. `'USD'`. Uppercase, matching the
  existing `.toUpperCase()` comparisons in reconciliation.ts.
- `memo_currency_parse_status`: `NULL` when the memo has no foreign-currency
  marker at all (ordinary domestic JPY line — must behave 100% identically
  to today), `'parsed'` when successfully extracted, `'unparsed'` when the
  marker is present but extraction failed.

All three nullable — no backfill-at-migration-time, no default. Apply the
migration against live D1 first (per Verification below), confirm schema,
then proceed.

## 2. Single parser — `lib/receipts/foreign-currency.ts` (new file)

```ts
export type ForeignCurrencyParseResult =
  | { status: "none" }
  | { status: "parsed"; amountMinor: number; currency: string; exchangeRate: number | null }
  | { status: "unparsed" };

export function parseForeignCurrencyMemo(memo: string | null): ForeignCurrencyParseResult

export function parseExchangeRateMemo(memo: string | null): number | null
```

`parseForeignCurrencyMemo` (charge-row memo):
- Detection marker: memo contains `現地通貨額` — confirmed live against a
  real 2026-06/07 SAISON statement (see the table above); still validate
  against whatever memo variance exists across the rest of current D1 data.
  If production memos elsewhere use a materially different label or shape,
  **stop and report the actual text back to the architect** rather than
  guessing at more regex variants.
- On marker found, extract amount + ISO currency code. Confirmed real
  shape: half-width colon `:`, decimal amount (`11.51`, `66.00`, `3.30`),
  single space, 3-letter uppercase code. Still handle full-width `：` and
  comma-thousands defensively in case larger charges format differently.
  Round to minor units the same way `parseAmountMinor` does elsewhere.
- Marker present but regex doesn't cleanly yield both an amount and a
  3-letter currency code → `{ status: "unparsed" }`.
- No marker at all → `{ status: "none" }`.

`parseExchangeRateMemo` (continuation-row memo, new):
- Detection marker: `円換算レート`. Confirmed real shape: half-width colon,
  then an `M/D` date (e.g. `6/11`), a space, then a decimal rate (e.g.
  `166.6377`). Extract and return just the rate as a `number`; return
  `null` if the marker isn't present or the rate can't be cleanly parsed
  (this is a soft signal, not a hard failure by itself).

**Row correlation (new — the continuation row currently gets silently
discarded, see validation.ts:340-359):** in `parseAmexNetanswer`, when a
row is about to be classified as the benign "no date, no amount,
informational" skip AND the immediately preceding pushed line in `lines[]`
has `memoCurrencyParseStatus === "parsed"`, run `parseExchangeRateMemo` on
*this* row's memo and attach the result as `foreignExchangeRate` on that
previous `lines` entry (mutate `lines[lines.length - 1]`) instead of
letting the memo vanish into `skippedLines` unread.

**Cross-check (new):** once both `foreign_amount_minor`/`foreign_currency`
(status `parsed`) and a non-null `foreign_exchange_rate` are available for
a line, verify `round((foreignAmountMinor / 100) * exchangeRate)` is within
±1 yen of `abs(amount_minor)`. If it's NOT within tolerance, **downgrade
`memo_currency_parse_status` to `"unparsed"`** even though the primary
regex succeeded — a mismatch here means the parse likely grabbed the wrong
row or a garbled currency code, and matching on it would be worse than not
matching at all. If the rate row is missing or its own parse fails but the
foreign amount parsed cleanly, leave status as `"parsed"` (the rate is a
bonus check, not a requirement) but note the missing rate in your report so
we know how often this happens across real data.

This parsing logic is the **single source of truth** — both the import
path (§3) and the backfill script (§3b) must call the same functions. Do
not duplicate the regex or the cross-check.

## 3. Import path — persist at parse time

`lib/receipts/validation.ts`:
- `NetanswerParsedLine` (or the type it maps to) gains
  `foreignAmountMinor`, `foreignCurrency`, `memoCurrencyParseStatus`,
  computed via `parseForeignCurrencyMemo(memo)` where `memo` is already
  captured (validation.ts:334). Apply the sign-inheritance rule from §1.
- `netanswerLinesToImportInputs` (validation.ts:431-455) passes these three
  fields through into `ImportAmexLineInput`.
- Whatever DB insert path consumes `ImportAmexLineInput` (find it — likely
  in `lib/receipts/db.ts`) must insert the three new columns.
- Update `AmexStatementLine` in `lib/receipts/types.ts` (currently ends
  around line 367) with the three new fields.

### 3b. Backfill script (open months only)

New script (mirror whatever pattern the repo already uses for one-off D1
fixes — check `scripts/` and any prior backfill approach referenced in
AGENTS.md backlog #5's "15 orphans backfilled on 2026-07-04" for the
established convention; if that was done via an ad hoc D1 SQL/console pass
rather than a checked-in script, that's fine to follow too, but prefer a
checked-in script here since this may need re-running).

Logic: select `amex_statement_lines` rows where `statement_month` is NOT in
a finalized `amex_reconciliations` status, and `memo IS NOT NULL`; run
`parseForeignCurrencyMemo`; `UPDATE` the three new columns. Must be
idempotent (safe to re-run). Dry-run mode that reports counts
(none/parsed/unparsed) before writing is preferred so you can sanity-check
against real data before committing the update.

## 4. Matching logic — `lib/receipts/reconciliation.ts`

Replace the hard gate at lines 169-173 (and the consolidation-phase mirror
at line 317) with an eligibility check that accepts EITHER:

- same-currency path (today's behavior, unchanged): `line.currency.toUpperCase() === receipt.currency.toUpperCase()`,
  amount comparison uses `line.amount_minor` vs `receipt.amount_minor` — or
- foreign-currency path (new): `line.foreign_currency?.toUpperCase() === receipt.currency.toUpperCase()`,
  amount comparison uses `line.foreign_amount_minor` vs `receipt.amount_minor`
  instead of the JPY `amount_minor`.

Keep the existing exact/≈1% tolerance scoring (lines 179-196) — just make it
operate on whichever pair of amounts matches the eligible path. Add a
distinguishing reason string on the foreign-currency path, e.g. `"exact
amount (foreign currency)"` / `"approximate amount (foreign currency)"`, so
operators can see in the UI why a JPY-denominated line matched a USD
receipt (do not silently reuse the same reason text as the JPY path —
that would look like a bug to whoever reviews match reasons later).

Apply the same two-path change to the phase-3 consolidation gate (line 317)
for consistency, but this is lower priority — Cloudflare/Anthropic are
single-line subscriptions, not consolidation candidates. If threading the
foreign-currency amounts through the consolidation sum logic gets
complicated, stop and confirm with the architect before deep-diving; it's
fine to leave consolidation JPY-only for this pass if flagged clearly in
your report.

Do not touch the `none`-status path — a line with no foreign-currency memo
data at all must match exactly as it does today (protects existing
domestic-JPY matching from any regression).

## 5. UI — `components/receipts/reconcile/reconcile-screen.tsx`

- When `line.memo_currency_parse_status === "unparsed"`, render a `Pill`
  (mirror the existing pattern at ~line 988, e.g. `tone="amber"`) labeled
  something like "Currency unparsed — review memo" in the detail pane, and
  find + update the equivalent list-row rendering (wherever the left-pane
  queue rows render their status pills — locate it; don't guess the file)
  so it's visible before opening the line.
- In the comparison card (~lines 986-1004), when a match came from the
  foreign-currency path, show both amounts for clarity — e.g. "AMEX: ¥1,753
  (11.51 USD) vs Receipt: $11.51" — so the operator isn't confused by a JPY
  line matching a USD receipt. Check `matchExplanation()` (referenced near
  line 999) — it likely needs the same foreign-currency-aware update for
  already-confirmed lines (no live `match` object).

## 6. Tests

- `foreign-currency.ts` unit tests: use the **three real rows from the
  operator's screenshot verbatim** as primary fixtures (not synthetic
  strings) —
  `2026/06/11 CLOUDFLARE ¥1918`, memo `現地通貨額:11.51 USD` + continuation
  memo `円換算レート:6/11 166.6377` → `parsed`, `foreignAmountMinor: 1151`,
  `foreignCurrency: "USD"`, `foreignExchangeRate: 166.6377`, cross-check
  passes;
  `2026/06/23 ANTHROPIC ¥11098`, memo `現地通貨額:66.00 USD` + continuation
  `円換算レート:6/23 168.1516` → same shape, `foreignAmountMinor: 6600`;
  `2026/07/04 CLOUDFLARE ¥552`, memo `現地通貨額:3.30 USD` + continuation
  `円換算レート:7/04 167.2728` → `foreignAmountMinor: 330`.
  Plus: full-width colon variant; comma-thousands amount; marker present
  but garbled → `unparsed`; no marker → `none`; sign inheritance for a
  refund line; cross-check failure (rate × foreign amount does NOT
  reproduce the JPY amount) forces `unparsed` even though the primary regex
  succeeded; missing/unparseable rate row leaves status `parsed` (soft
  signal only).
- `validation.ts` / amex-parser tests: build full synthetic CSV rows
  reproducing the three real examples above (charge row + continuation row
  pair) and confirm `parseAmexNetanswer` produces `foreign_currency: "USD"`,
  `foreign_amount_minor`, `foreign_exchange_rate`,
  `memo_currency_parse_status: "parsed"` on the correct `lines[]` entry
  (not the discarded continuation row), and on
  `netanswerLinesToImportInputs` output.
- `reconciliation.test.ts`: the existing test "currency mismatch (USD
  receipt vs JPY line) is not matched" (~lines 421-428) needs to be split —
  (a) a JPY line WITHOUT foreign-currency data still does NOT match a USD
  receipt (today's protective behavior, unchanged); (b) a JPY line WITH
  parsed foreign USD data DOES match a same-amount USD receipt via the new
  path, with the distinguishing reason string; (c) a JPY line with foreign
  data in a currency OTHER than the receipt's (e.g. EUR) still does not
  match.
- Backfill script: dry-run count test against a small fixture set (or
  whatever harness the existing scripts/tests use).
- Run the full existing suite; ZERO regressions accepted, in particular on
  today's JPY-JPY matching (this is the highest-traffic path — do not let
  the two-path branch change any existing outcome for `none`-status lines).

## 7. Verification & report (required)

Against live bindings (`npm run cf:dev` or the standard live workflow):

1. Apply migration `0026`; confirm the 3 columns exist via a `PRAGMA
   table_info(amex_statement_lines);` or equivalent.
2. Run the backfill in dry-run mode first against the current open
   month(s); report counts (none / parsed / unparsed) before writing.
   Spot-check a couple of `unparsed` rows' actual memo text if any turn up
   — report the raw text back if the marker format differs from what §2
   assumed.
3. Run the backfill for real (open months only — confirm no finalized month
   was touched).
4. Re-run reconciliation matching; confirm the Cloudflare/Anthropic
   receipts that prompted this fix now appear as match candidates against
   the correct AMEX lines, with the new "(foreign currency)" reason string
   and correct confidence.
5. Confirm a known-good existing domestic JPY match (pick any currently
   confirmed line) is completely unaffected — same match, same score.
6. Reconcile UI: unparsed lines (if any exist in current data) show the new
   pill in both list row and detail pane; foreign-currency matches show the
   dual-amount comparison text.
7. `npm test` (expect to need multiple chunks per the sandbox's 45s
   per-call limit — same as noted in prior sessions), `tsc --noEmit`,
   `npm run build:cf` clean.

Report back: migration confirmation, backfill dry-run + real counts (by
month), test counts before/after, and explicit pass/fail per verification
step above. Flag any memo-format surprises immediately rather than working
around them silently. Do not deploy — the architect verifies independently
before deploy, per the existing two-agent workflow.
