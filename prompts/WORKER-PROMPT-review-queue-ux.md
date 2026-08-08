ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Review queue UX — month-scoped queue, sort/search, lock surfacing

## Decisions already made with the operator (do not revisit)

1. **Hybrid data model.** The working set is chosen SERVER-side (month
   filter + lock computation, via query params). Sort and text search run
   CLIENT-side within that set. Rationale: a single month never exceeds
   `RECEIPT_VIEW_LIMIT` (200), so in-memory sort/search is complete and
   instant, while the month/lock predicates stay correct in SQL.
2. **Locked receipts are hidden from the default queue.** A "Locked"
   filter reveals them; opening one renders the form read-only with a
   banner. Never let the operator type into a locked receipt and discover
   the 409 at save time.
3. Lock definition is the EXISTING split-lock model (month-lock.ts header
   comment, audit A5). Do not invent a third lock:
   - CASH/DIGITAL/UNKNOWN receipt → locked iff its transaction month is
     export-sealed: `status='finalized'` export exists AND no `'draft'`
     revision (exactly `loadSealedExportMonths()` in
     `lib/receipts/membership.ts`).
   - AMEX-path receipt → locked iff matched to an `amex_statement_lines`
     row whose statement month's `amex_reconciliations.status='finalized'`
     (same predicate as `rejectIfReceiptInFinalizedReconciliation`,
     `lib/receipts/db.ts` ~line 338).

## 0. Live investigation FIRST (read-only, include output in report)

- `SELECT substr(transaction_date,1,7) m, status, COUNT(*) FROM receipt_records WHERE deleted_at IS NULL GROUP BY m, status ORDER BY m;`
- `SELECT export_month, status FROM receipt_exports ORDER BY export_month;`
- `SELECT statement_month, status FROM amex_reconciliations ORDER BY statement_month;`
- `SELECT COUNT(*) FROM receipt_records WHERE deleted_at IS NULL AND transaction_date IS NULL;`
- Report: how many receipts currently sit in sealed months, and how many
  are undated. This calibrates the default month choice below.

## 1. Server: lock computation (`lib/receipts/db.ts` or new `lib/receipts/receipt-locks.ts`)

New helper (prefer a new file `lib/receipts/receipt-locks.ts` to keep
db.ts from growing):

```ts
export type ReceiptLockInfo = {
  locked: boolean;
  kind: "export" | "reconciliation" | null;
  month: string | null;   // the sealed YYYY-MM driving the lock
};
export async function getReceiptLocks(
  receipts: ReceiptRecord[],
): Promise<Map<string, ReceiptLockInfo>>;
```

Implementation: one call to `loadSealedExportMonths()`, plus ONE
set-returning query for the reconciliation side (adapt the
`rejectIfReceiptInFinalizedReconciliation` join into
`WHERE asl.matched_receipt_id IN (...)` over the passed ids — do NOT loop
the per-receipt predicate N times). Use `transactionMonthOf()` from
month-lock.ts for the export side. AMEX-path receipts are NOT export-lock
gated and CASH/DIGITAL are NOT reconciliation gated (month-lock.ts header
comment is the authority); a receipt with `payment_path='AMEX'` but no
matched line is unlocked. Undated receipts are never locked.

## 2. Server: month-scoped working set (`app/(receipt-system)/receipts/review/page.tsx` and `[id]/page.tsx`)

- New `?month=YYYY-MM` search param. `listReceiptRecords` already supports
  `month` (transaction_date LIKE) — use it. Validate the param against
  `/^\d{4}-\d{2}$/`; ignore if malformed.
- **Undated receipts must never disappear.** When a month is selected,
  additionally include receipts with `transaction_date IS NULL` (they are
  usually pending extraction — the ones most needing review). Extend
  `ListReceiptsFilter` with `includeUndated?: boolean` that ORs
  `transaction_date IS NULL` into the month condition, rather than a
  second query.
- Default month = current calendar month. `month=all` keeps today's
  behavior (200 most recent). The month picker (see §4) offers the months
  present in the data plus "All".
- Compute `getReceiptLocks()` over the fetched set. Default queue =
  unlocked receipts only. `?filter=locked` = locked receipts only.
- Counts: `needsAttention` counts the UNLOCKED needs-review set;
  `capturedThisMonth` label becomes month-aware ("{n} in {month}" or
  "{n} recent" for all). A separate muted count "{n} locked" links to the
  locked filter so hidden rows are always one click from visible.
- Keep the bare-URL auto-redirect to the first queue item ONLY when no
  params at all are present (preserves the rapid-review entry point);
  never redirect when `month` or `filter` params are set.
- `[id]/page.tsx`: same working-set changes (propagate the month param
  through queue links so j/k navigation stays within the chosen view),
  plus fetch this receipt's `ReceiptLockInfo` and pass it to FormPane and
  ImagePane-adjacent chrome. Build a `MonthLock` via the existing
  `buildMonthLock()` where it fits; if the shape doesn't fit the
  reconciliation case, pass `ReceiptLockInfo` directly — do not fork a
  second badge vocabulary ("Sealed" stays the word).

## 3. Client: real sort + search (`components/receipts/review/`)

Replace the placeholder search span in `review-layout.tsx` (it is
currently a non-functional styled `<span>`) with a working control. The
queue data is already client-side in `QueueRail`; lift sort/search state
into a small client wrapper (`queue-controls.tsx`) that owns:

- **Search**: single text input, matches merchant (case-insensitive
  substring), amount (digits typed match `amountLabel` digits), and
  category label. Filters the in-memory `QueueItem[]`. `/` focuses it,
  `Esc` clears (register via the existing `useKeyboardShortcuts`; make
  sure typing in the input doesn't trigger j/k — check how form-pane.tsx
  already guards text inputs and reuse that guard).
- **Sort**: select with `Needs first (default)` / `Date ↓` / `Date ↑` /
  `Amount ↓` / `Merchant A–Z`. "Needs first" = needs/stuck/failed items
  before reviewed, date desc within each group (this preserves today's
  triage feel as the default).
- j/k navigation and the "n of m" footer must follow the sorted+filtered
  order, not the server order. State is client-only (no URL churn, no
  server round-trip); do not persist to localStorage in this pass.
- Add `locked` + `lockKind` to `QueueItem` (`lib/receipts/queue-items.ts`)
  and render a gray "sealed" badge in the rail row when set (only visible
  under the locked filter, but build it data-driven, not filter-driven).

## 4. Client: month picker + locked filter (`review-layout.tsx`)

- Month picker in the SubHeader (left of the filter pills): a select of
  available months (server passes the distinct months present plus the
  current month) + "All". Changing it navigates to
  `/receipts/review?month=…` (server round-trip — this is the hybrid
  boundary, that's expected).
- Append a `Locked` pill to `FILTERS` → `/receipts/review?filter=locked`
  (month param preserved). Style it visually distinct (gray, lock glyph)
  from the workflow filters.
- Existing filter pills must preserve the month param when clicked.

## 5. FormPane read-only mode (`components/receipts/review/form-pane.tsx`)

New prop `lock: ReceiptLockInfo`. When `lock.locked`:

- Render a banner at the top of the pane: for `kind="export"` —
  "Sealed — the {month} export is finalized. Open a revision to edit."
  linking to `/receipts/export` (the correction flow entry); for
  `kind="reconciliation"` — "Sealed — the {month} AMEX reconciliation is
  finalized. Reopen it to edit." linking to `/receipts/reconcile`.
- Disable every mutating control: all inputs/selects, attendee editor,
  payment-path segmented control, membership override, reprocess/extract
  buttons, and the `s` save shortcut. Read-only display of values stays.
  Navigation (j/k, open original, rotate view) stays live.
- Suppress the autosave debounce entirely while locked (don't fire and
  swallow 409s).
- The server 409 path stays untouched as the backstop — do not weaken any
  API-side enforcement.

## 6. Tests

- `receipt-locks` unit tests with a fake D1 (pattern: `MonthLockD1` in
  month-lock.ts): export-sealed CASH receipt locked; draft revision
  releases it; AMEX-matched receipt in finalized reconciliation locked;
  AMEX unmatched unlocked; undated never locked; CASH not affected by
  reconciliation seal and vice versa.
- `queue-items` tests for the `locked` flag pass-through.
- Sort/search: pure-function tests for the comparator + matcher (extract
  them from the component so they're testable without DOM).
- Page-level: filterQueue with `filter=locked` returns only locked;
  default excludes locked; undated included under a month param.
- Run the full existing suite; ZERO regressions accepted.

## 7. Verification & report (required)

Against live bindings (`npm run cf:dev` or the standard live workflow):

1. `/receipts/review` bare → still redirects to first unlocked item.
2. `?month=<a sealed month from §0>` → queue empty or only unlocked
   strays; "{n} locked" count present; `filter=locked` shows them with
   sealed badges.
3. Open a locked receipt → banner with correct kind + month, every input
   disabled, `s` does nothing, no PATCH fires (check network log).
4. Open a revision draft for that month via the export flow → receipt
   becomes editable (lock released); delete/finalize the draft → locked
   again.
5. Search: type a merchant fragment and an amount; j/k walks the filtered
   order. `/` focuses, typing in fields doesn't trigger j/k.
6. Sort by Amount ↓ and confirm footer "n of m" follows the sorted order.
7. `npm run build:cf` clean.

Report back: §0 query output, files touched, test counts before/after,
and explicit pass/fail per verification step. Do not deploy; the
architect verifies independently before deploy.
