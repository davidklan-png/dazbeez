ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Fix: mobile capture's AMEX/CASH preselect chip never reaches the upload

Bug report from David: "when I capture from iPhone and preselect AMEX or
CASH, it should apply to all captures in the series. I'm not sure if any
of the captures properly record the payment type." Confirmed by the
architect via direct code read (not just reported) — this is real, not a
misunderstanding.

## The bug, traced end to end (do not re-diagnose, just fix)

`components/receipts/capture/capture-mobile.tsx`:

- Line 25: `const [paymentChip, setPaymentChip] = useState<PaymentPath |
  null>(props.initialPayment);` — local state, seeded once from a prop.
- Lines 126-146: the "Preselect AMEX" / "Preselect CASH" buttons call
  `setPaymentChip`, updating this local state.
- Line 128: `paymentChip` is read for exactly one thing — the button's own
  `aria-pressed`/highlight styling. **It is never read anywhere else.**
- Lines 31-36 (`onFile`): calls `props.onPickFile(f)` with no payment
  info at all.

`components/receipts/receipt-capture-form.tsx`:

- Line 126: `await upload(file, initialPayment, source);` — uses the
  top-level `initialPayment` PROP (a static value computed once,
  server-side, from the `?payment=` URL query string in
  `app/(receipt-system)/receipts/capture/page.tsx` lines 21-30), **not**
  the live `paymentChip` state the user is actually toggling one
  component down.
- Line 164: `onPickFile`'s `useCallback` dependency array is
  `[isMobile, upload, initialPayment]` — confirms `initialPayment` (the
  stale prop) is the only payment-related dependency; `paymentChip`
  doesn't exist at this level at all.
- Line 150 (desktop branch): also uses `initialPayment`, but this is
  moot for desktop — `capture-desktop.tsx` has no chip UI at all
  (confirmed: zero references to `paymentChip`/`PaymentPath` in that
  file), so desktop's `initialPayment` only ever reflects the URL seed,
  which is correct/unchanged behavior for that path.

**Net effect:** tapping "Preselect AMEX/CASH" changes only the button's
own visual state. What actually gets uploaded is whatever `?payment=` was
in the URL when the page first loaded — and the primary entry point, the
bottom-nav "Capture" tab (`capture-mobile.tsx` line 402), links to
`/receipts/capture?mode=rapid` with **no** `payment` param. So through
normal navigation, every mobile capture lands with `payment_path =
'UNKNOWN'` regardless of what the user taps. This matches David's
suspicion exactly.

## Decisions already made (do not revisit)

1. **Fix: make the live chip state reach the upload call, not the stale
   prop.** Recommended minimal-diff approach — lift `paymentChip` state
   up from `CaptureMobile` into `ReceiptCaptureForm` (where `onPickFile`
   lives), seeded from `initialPayment` as before:
   - In `ReceiptCaptureForm`, add
     `const [paymentChip, setPaymentChip] = useState<PaymentPath |
     null>(initialPayment);` alongside the other state.
   - Change `onPickFile`'s upload calls (both the mobile branch, line
     126, and the desktop branch, line 150) from `initialPayment` to
     `paymentChip`. Desktop behavior is unchanged by this (nothing there
     ever calls `setPaymentChip`, so `paymentChip` stays equal to
     `initialPayment` for that path — same as today).
   - Add `paymentChip` to the `useCallback` dependency array (line 164),
     removing `initialPayment` if it's no longer directly referenced
     inside the callback (it's still used once, as the `useState` seed
     outside the callback — that's fine, no dependency needed there).
   - Pass `paymentChip` and `setPaymentChip` down to `CaptureMobile` as
     props (replacing its own local `useState` for this). Thread them
     through to `CaptureIdleMobile`, which already accepts
     `paymentChip`/`setPaymentChip` as props (lines 75-87) — only the
     *source* of those props changes (parent state instead of local
     state), the chip-button JSX itself (lines 126-146) shouldn't need
     to change.
   - If you find a cleaner pattern than lifting state (e.g. a ref) that
     achieves the same outcome without a stale closure, that's fine —
     the requirement is the OUTCOME in §2, not this exact mechanism.
2. **"Applies to all captures in the series" requires no new
   abstraction.** `CaptureMobile` already stays mounted across repeated
   "Capture next" taps (phase cycles idle → uploading → saved → idle
   without unmounting). Once `paymentChip` is correctly wired, it will
   naturally persist across consecutive captures in the same session for
   free — verify this explicitly in §4, don't just assume it.
3. **Do not persist the chip choice across a full page reload/navigation
   beyond what already exists.** The `?payment=CASH` URL shortcut
   (`capture-mobile.tsx` line 172, "Cash receipt, no photo" link) is a
   separate, existing mechanism for seeding a fresh page load — leave it
   as-is, don't add `sessionStorage`/`localStorage` persistence for the
   chip. Scope is: correct within-session behavior, not cross-reload
   behavior.
4. **Do not touch the native iOS app** (`ios/DazbeezCapture/` — confirmed
   non-functional scaffold, `ReceiptCaptureView` is literally
   `Text("Receipt capture (M2)")`, no camera, no payment UI) or the
   desktop capture path beyond the minimal shared-callback change in
   decision #1.
5. **Do not attempt to reclassify historical `payment_path='UNKNOWN'`
   receipts.** Whether an old UNKNOWN receipt was actually AMEX, CASH, or
   genuinely unknown isn't inferable from code — that's a data-quality
   call for David, not something to auto-fix. Quantify it (§0), don't
   fix it.

## 0. Live investigation FIRST (read-only, include output in report)

Quantify the blast radius so David knows how much historical data this
affected:

```sql
SELECT source, payment_path, COUNT(*) AS n,
       MIN(captured_at) AS earliest, MAX(captured_at) AS latest
  FROM receipt_records
 WHERE deleted_at IS NULL
 GROUP BY source, payment_path
 ORDER BY source, payment_path;
```

Report the full result. Specifically call out: how many
`source='mobile_capture'` rows have `payment_path='UNKNOWN'`, and their
date range — that's the population plausibly affected by this bug (not
all of them necessarily WERE meant to be AMEX/CASH, but this is the set
worth a manual look).

Also re-confirm the four file locations above still match current source
before editing (the architect read them directly, but confirm nothing
changed since).

## 1. Implementation

Per decision #1 above. Touch only:
`components/receipts/receipt-capture-form.tsx`,
`components/receipts/capture/capture-mobile.tsx`. Do not touch
`capture-desktop.tsx`, the API route, or any lib/receipts files — this is
purely a client-state wiring bug, nothing server-side is broken (the
server already correctly reads `paymentPath` from form data and defaults
to `UNKNOWN` only when it's genuinely absent).

## 2. Required outcome (verify, don't just assert)

- Tapping "Preselect AMEX" then capturing a photo results in a
  `receipt_records` row with `payment_path = 'AMEX'`.
- Without retapping anything, capturing a SECOND photo ("Capture next")
  also results in `payment_path = 'AMEX'` — the series behavior from
  decision #2.
- Tapping "Preselect CASH" (switching mid-series) then capturing results
  in `payment_path = 'CASH'` for that and subsequent captures, until
  changed again.
- Tapping the active chip again to deselect it (existing toggle-off
  behavior, `onClick={() => setPaymentChip(on ? null : chip)}`) returns
  to no preselection — next capture should land at `payment_path =
  'UNKNOWN'` (the existing default), not silently keep the old value.
- Loading `/receipts/capture?payment=CASH` directly still preselects CASH
  on first load (the existing URL-shortcut behavior must be unaffected).

## 3. Tests

Check `tests/receipts/` for any existing coverage of
`receipt-capture-form.tsx` / `capture-mobile.tsx` first — if none exists,
don't build new component-test infrastructure just for this fix; it's a
small, directly-verifiable-live change. If any pure logic naturally falls
out of the fix that's easy to unit test without DOM (unlikely here, this
is mostly state wiring), test it; otherwise rely on the live verification
in §4. Run the full existing suite regardless; ZERO regressions accepted.

## 4. Verification & report (required)

Against live bindings (`npm run cf:dev` or the standard live workflow):

1. Walk through every bullet in §2 on an actual mobile viewport (or
   device), confirming via a live D1 query
   (`SELECT id, payment_path, captured_at FROM receipt_records ORDER BY
   captured_at DESC LIMIT 5;`) after each capture — don't just trust the
   UI's own display.
2. Desktop capture path: confirm unaffected (drop a file, confirm
   `payment_path` still reflects whatever `?payment=` was in the URL, or
   `UNKNOWN` if absent — same as before this change).
3. `npx tsc --noEmit` clean.
4. `npm test` — report pass/fail counts, zero regressions.
5. `npm run build:cf` clean.

Report back: §0 query results (the blast-radius numbers), files touched,
the §2 walkthrough results (pass/fail per bullet), and test counts. Do not
deploy; the architect verifies independently before deploy.
