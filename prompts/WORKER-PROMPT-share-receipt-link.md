ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you hit
a design decision this prompt doesn't cover, stop and report back instead of
improvising.

# Review screen — stop faking queue position for out-of-view receipts

## Problem

In `app/(receipt-system)/receipts/review/[id]/page.tsx`:

```ts
const activeIndex = queueItems.findIndex((q) => q.id === id);
const nextReceiptId = queueItems[activeIndex + 1]?.id ?? null;
const prevReceiptId = queueItems[activeIndex - 1]?.id ?? null;
```

When the active receipt is **not** in the current working set, `activeIndex` is
`-1`. Two things then go wrong:

1. `queueIndex={Math.max(1, activeIndex + 1)}` renders **"1 of 23"** in the
   form header for a receipt that is not among those 23.
2. `nextReceiptId` becomes `queueItems[0]` — so "Skip" and save-and-advance
   send the operator into an unrelated receipt at the top of a queue they
   aren't actually in. (`prevReceiptId` is harmless: `queueItems[-2]` is
   `undefined` → null.)

The live trigger is a **shared deep link across a month boundary**. The rail's
links come from `buildReviewQueryParams`, which only emits `month` when the
operator explicitly picked one from the month picker. So a link copied from the
default current-month view carries no `month`; opened after the calendar month
rolls over, the recipient's rail defaults to the *new* month, the receipt isn't
in it, and both bugs fire. David is now sharing receipt links with a second
Clerk user, so this stops being hypothetical.

## Decisions already made with the operator (do not revisit)

1. **State it, don't fix it up.** When the receipt isn't in the queue, say so
   and disable forward navigation. Do **not** silently widen the working set to
   make it fit — the working set is export/closing-scope authority, not a
   display convenience, and quietly expanding it would let a shared link change
   what the review screen considers in scope.
2. **Scope is exactly this bug.** A "Copy link" button and a share-URL builder
   were designed and then cut: ordinary right-click-copy works for the common
   cases, and the button's only real value was pinning the month — which is a
   workaround for this bug rather than a feature. Do not build them.
3. **No auth work.** Sharing is a Clerk account + the existing protected deep
   link. No unauthenticated route, no token, no role scoping.

## 0. Read first

- `app/(receipt-system)/receipts/review/[id]/page.tsx` (~157–176)
- `components/receipts/review/form-pane.tsx` — props (~45–52), the client
  override (~93–96), the header render (~521–526), the Skip button (~800–815),
  and the save-and-advance branch (~415–425)
- `lib/receipts/review-queue-filter.ts` (house style for the pure helpers)
- `tests/receipts/queue-sort.test.ts` — test style (`tsx --test` via
  `npm test`; this repo is NOT on vitest)

## 1. Pure helper — `lib/receipts/review-queue-filter.ts`

Put the navigation resolution in a pure, tested function rather than inline
page arithmetic, so the `-1` case has a named home and a regression test:

```ts
export interface QueueNavigation {
  /** 1-based position, or null when the receipt is outside the working set. */
  index: number | null;
  total: number;
  nextId: string | null;
  prevId: string | null;
}

export function resolveQueueNavigation(
  queueItems: { id: string }[],
  activeId: string,
): QueueNavigation;
```

Rules: when `activeId` is absent from `queueItems`, return
`{ index: null, total: queueItems.length, nextId: null, prevId: null }`.
Otherwise the 1-based index and the neighbouring ids (null at either end).

Use it in `[id]/page.tsx` in place of the three lines above, and pass
`queueIndex={nav.index}` / `queueTotal={nav.total}` /
`nextReceiptId={nav.nextId}` / `prevReceiptId={nav.prevId}`.

## 2. `components/receipts/review/form-pane.tsx`

- Widen `queueIndex` to `number | null` in `FormPaneProps`.
- **Preserve the existing client-store precedence** at ~93–96:
  `useQueuePosition` still wins when `queuePos.index >= 0`; the null only
  applies when the client store also doesn't know the receipt.
- Header (~524): when the resolved index is null, render `not in this view`
  in the same muted styling instead of `{queueIndex} of {queueTotal}`.
- Skip (~803) and save-and-advance (~418) are already guarded on
  `nextReceiptId` — confirm Skip disappears and that after a save the fallback
  `router.push('/receipts/review' + queryParams)` still fires. Check nothing
  else assumes `queueIndex >= 1`.

## 3. Non-goals

No share-link builder, no Copy-link button, no icon additions. No changes to
`middleware.ts`, `PUBLIC_ROUTES`, `lib/receipts/auth.ts`, the review PATCH, the
status-transition policy, or the lock/seal guards.

## 4. Tests (pure, `tsx --test`)

Extend `tests/receipts/queue-sort.test.ts` or add
`tests/receipts/review-queue-navigation.test.ts` for `resolveQueueNavigation`:

1. Active id in the middle → correct 1-based index, both neighbours set.
2. Active id first → `prevId` null. Active id last → `nextId` null.
3. **Active id absent → `index` null AND `nextId` null** (the bug: it must not
   be `queueItems[0]`).
4. Empty queue → `{ index: null, total: 0, nextId: null, prevId: null }`.
5. Single-item queue where that item is active → `index` 1, both neighbours
   null.

## 5. Verification (per AGENTS.md)

1. `npm test` green, `npx tsc --noEmit` clean.
2. `npm run build:cf` passes.
3. `npm run cf:dev`, then by hand: open a bare
   `/receipts/review/<id>` (no query string) for a receipt from a **past**
   month. Header must read "not in this view" and Skip must be absent — not
   "1 of N" with a Skip into the current month. Then open a receipt that IS in
   the current view and confirm the normal "N of M", Skip, and
   save-and-advance are all unchanged.
4. Mass test failures right after an `npm install` on the Mac are the known
   `@esbuild/linux-arm64` quirk — reinstall with `--no-save`, don't debug them.

## 6. Report back

Files + commits, what you ran, what passed/failed, and the two hand-checks in
§5.3. Flag anything ambiguous instead of resolving it.
