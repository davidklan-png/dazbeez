ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified, and reported back — not redesigned. If you hit a design decision
this prompt doesn't cover, stop and report back instead of improvising.

# Review queue — per-row closing-attention reason badges

## Problem (observed live by the operator)

The amber "N need attention" pill on /receipts/review is driven by the
closing-attention authority (`lib/receipts/review-attention.ts`), but the
queue-rail rows carry NO per-row marker from that authority. The rail's only
"needs X" badge comes from the legacy `needsFlag()` in
`lib/receipts/queue-items.ts`, which knows just three reasons (attendees /
purpose / re-review). Result: the pill says "3 need attention" while all three
rows render unmarked — the operator cannot see which items, or why. The
attention set is currently consumed only by the pill count and the
"Needs review" filter tab.

## Decisions already made with the operator (do not revisit)

1. **The authority returns reasons, not bare membership.** The pure core
   returns `Map<receiptId, ClosingAttentionCode[]>`. The existing
   Set-returning exports remain as thin adapters (`new Set(map.keys())`) so
   membership semantics — and every existing membership test — are unchanged.
2. **Accumulate ALL firing codes per receipt.** The current core
   short-circuits (`continue` after the first hit). Remove the early exits and
   collect every applicable code, in the existing canonical check order
   (1)→(9). Membership (the key set) is identical by construction.
3. **The legacy `needsFlag()` is retired.** `QueueItem.needs` is replaced by
   `QueueItem.attentionCodes`. The legacy flag was a second, drifting source
   of truth for the same semantics. Its "re-review" case is covered by the
   authority's `amex_re_review_needed` code.
4. **Operational badges stay.** `stuck?` (time-based), `extraction failed`
   (with failureReason tooltip), and `sealed` badges in the rail are
   unchanged. The new amber badge may coexist with them on the same row.
5. **Scope: review rail + both review pages only.** No form-pane surfacing,
   no dashboard changes — those are follow-ups that will reuse the same code
   map.

## 0. Read first

- `lib/receipts/review-attention.ts` (the authority — full file)
- `lib/receipts/reconciliation-signoff.ts` (~lines 95–135: `AmexLineSignoffCode`)
- `lib/receipts/queue-items.ts`, `lib/receipts/queue-sort.ts`
- `components/receipts/review/queue-rail.tsx`
- `app/(receipt-system)/receipts/review/page.tsx` and `.../review/[id]/page.tsx`
- `tests/receipts/review-attention.test.ts`, `tests/receipts/queue-sort.test.ts`

## 1. New pure module: `lib/receipts/attention-codes.ts`

Client-safe (no db / server imports — the rail is a client component and must
import the labels without dragging in `@/lib/cloudflare-runtime`):

```ts
import type { AmexLineSignoffCode } from "@/lib/receipts/reconciliation-signoff";
// NOTE: type-only import — erased at compile time, so no server code leaks.
// If reconciliation-signoff.ts turns out to have side-effectful top-level
// imports that break the client bundle even for type imports, inline the
// union instead and add a comment pointing at the source of truth.

export type ClosingAttentionCode =
  | "extraction_pending"        // check (1): pending / stuck extraction
  | "extraction_failed"         // check (1): extraction_state === 'failed'
  | "unreviewed"                // check (2)
  | "unknown_path"              // check (3)
  | "missing_date"              // check (4) gates, one code per gate
  | "missing_merchant"
  | "missing_amount"
  | "missing_category"
  | "attendees_missing"
  | "attendee_unresolved"
  | "missing_proof_file"
  | "compliance_open"           // check (5)
  | `amex_${AmexLineSignoffCode}` // check (6): line sign-off, provenance kept
  | "amex_total_mismatch"       // check (6): consolidated mismatch
  | "cross_month_ambiguous"     // check (7)
  | "possible_duplicate"        // check (8)
  | "ic_topup_candidate";       // check (9)

/** Short operator-facing labels for the rail badge + tooltip. */
export const CLOSING_ATTENTION_LABELS: Record<ClosingAttentionCode, string>;
```

Labels (keep them this terse — they render in a 10px badge):
extraction_pending "processing", extraction_failed "extraction failed",
unreviewed "unreviewed", unknown_path "unknown payment path",
missing_date "no date", missing_merchant "no merchant",
missing_amount "no amount", missing_category "no category",
attendees_missing "attendees missing", attendee_unresolved "attendee not in
directory", missing_proof_file "no proof file", compliance_open "compliance
check", amex_unresolved_match "AMEX match unresolved",
amex_missing_category "AMEX category missing", amex_matched_not_confirmed
"AMEX match unconfirmed", amex_missing_reason "AMEX reason missing",
amex_attendees_required "AMEX attendees required", amex_attendee_unresolved
"AMEX attendee unresolved", amex_business_trip_candidate "business-trip
candidate", amex_re_review_needed "re-review", amex_total_mismatch "AMEX
total mismatch", cross_month_ambiguous "cross-month match",
possible_duplicate "possible duplicate", ic_topup_candidate "IC top-up?".

## 2. `lib/receipts/review-attention.ts`

- New core: `computeClosingAttentionReasons(input): Map<string, ClosingAttentionCode[]>`.
  Restructure the per-receipt loop to append codes instead of `continue`-ing:
  - check (1): `isPendingProcessing` → `extraction_pending`;
    `extraction_state === "failed"` → `extraction_failed`. Preserve the
    current semantics that a pending/failed receipt is NOT also evaluated
    against checks (2)–(9) (today's `continue` skips them; keep that skip so
    half-extracted rows don't spray "no merchant / no amount" noise). All
    OTHER checks (2)–(9) accumulate freely with no early exit.
  - check (4): one code per failed gate (a receipt can be both
    `missing_date` and `missing_proof_file`).
  - check (6): for sign-off, map each fired `AmexLineSignoffCode` to
    `amex_${code}`; dedupe codes when several matched lines fire the same
    one. Consolidated mismatch → `amex_total_mismatch`.
- `computeClosingAttentionReceiptIds` becomes
  `new Set(computeClosingAttentionReasons(input).keys())` — signature
  unchanged.
- New async wrapper `collectClosingAttentionReasons(receipts)` mirroring the
  existing batch-loading wrapper; `collectClosingAttentionReceiptIds` becomes
  a thin adapter over it. ONE set of batched queries, exactly as today.
- Update the header comment: the module now feeds THREE consumers (pill
  count, Needs-review tab, per-row badges) from one computation.

## 3. `lib/receipts/queue-items.ts`

- `QueueItem`: remove `needs`; add
  `attentionCodes: ClosingAttentionCode[]` (empty array when none).
- `buildQueueItems(receipts, attentionReasons: ReadonlyMap<string, ClosingAttentionCode[]>, now, locks)`
  — the `reReviewIds` parameter is REMOVED (its only consumer was
  `needsFlag`). Delete `needsFlag()`.

## 4. `lib/receipts/queue-sort.ts`

`needsFirst(item)` → `item.attentionCodes.length > 0 || item.stuck || item.extractionFailed`.
"Needs first" sort now agrees with the authority instead of the legacy flag.

## 5. `components/receipts/review/queue-rail.tsx`

Replace the `item.needs` badge block with: when
`item.attentionCodes.length > 0 && !item.locked`, render ONE amber badge
(same styling as the old one: `bg-amber-100 text-amber-700`):

- text: label of the FIRST code, plus ` +N` when more than one
  (e.g. "no proof file +2");
- `title` attribute: all labels joined with " · " so hover explains every
  reason.

Locked rows keep only the gray "sealed" badge (they're excluded from the
pill count, so an amber badge there would contradict the header).

## 6. Both review pages

`app/(receipt-system)/receipts/review/page.tsx` and `.../review/[id]/page.tsx`:

- Call `collectClosingAttentionReasons(workingReceipts)` once; derive the id
  set for `filterReviewQueue` and the pill count from `.keys()` (pill logic —
  unlocked ∩ attention — is unchanged).
- Pass the reasons map into `buildQueueItems`.
- List page: `getAmexMatchFlagsByReceiptIds` was only feeding `reReviewIds`
  — delete the call entirely (one query saved per render).
- Detail page: KEEP `getAmexMatchFlagsByReceiptIds` (it still feeds
  `activeFlags` for the form pane) but stop building `reReviewIds` from it.

## 7. Tests (`npm test` — tsx --test, NOT vitest)

- `tests/receipts/review-attention.test.ts`: existing membership tests must
  pass UNCHANGED (they exercise the Set adapter). Add a new block asserting
  codes via `computeClosingAttentionReasons`:
  - a receipt failing two gates (e.g. no date + no proof file) carries BOTH
    codes, in check order;
  - pending receipt → exactly `["extraction_pending"]` even when it would
    also fail gates (the skip semantics);
  - AMEX sign-off receipt → `amex_`-prefixed code; two lines firing the same
    code → deduped;
  - clean receipt → absent from the map (NOT present with `[]`).
- `tests/receipts/queue-sort.test.ts`: update the item factory (`needs` →
  `attentionCodes`) and the needsFirst cases.
- Grep for any other `QueueItem` literal in tests/components that sets
  `needs` and update it.

## 8. Verify + report

- `npx tsc --noEmit`, `npm run lint`, `npm test` — all green.
- `npm run dev` (or cf:dev): open /receipts/review for the current month and
  for 2026-06. Confirm: pill count N, and exactly N unlocked rows carry the
  amber badge; hover shows the reason list; "Needs review" tab shows the
  same N rows; "Needs first" sort floats them.
- Report back: test/lint output, a screenshot-level description of one badged
  row (label + tooltip text), which reason codes actually fired for the
  operator's current 3 attention items, and any place you had to deviate.
  Do NOT push; commit on a feature branch and report the branch name.
