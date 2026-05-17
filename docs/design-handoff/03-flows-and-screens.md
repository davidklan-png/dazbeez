# End-to-End Flows & Screen-by-Screen Audit

The five user journeys, what each one is, what the current UI does, and where it falls short. Use this to scope screen work.

---

## Flow 1 — Rapid phone capture (the high-frequency case)

**User story:** "I just paid for dinner. Photograph the receipt before the server walks away. Done."

**Current path:**
1. User opens `/receipts/capture?mode=rapid` (bookmarked or via NFC).
2. Drag-drop area on a desktop-shaped layout; on iPhone Safari, tapping it opens the system file picker (which offers camera).
3. Browser-side HEIC→JPEG conversion + resize to ≤2MP (`lib/receipts/client-image.ts`).
4. POST to `/api/receipts/upload`. Spinner during upload.
5. Success: small card with link to review + "Add another" button.

**What's weak:**
- The drop area is a desktop pattern. On phone, the "tap to capture" affordance is not the dominant visual.
- No explicit acknowledgment between "photo taken" and "upload finished" (already filed in `docs/receipt_review_feature_requests.md` — implement this).
- The success state hides under the form; thumb has to scroll up. Should be a full-screen confirmation in rapid mode.
- No undo / retake within the success state. If the photo was blurry the user has to delete-then-recapture.
- Offline behavior is undefined. If the connection drops mid-upload, the user gets a generic error.

**Design opportunity:** Treat phone capture as a single full-screen experience: huge tap-target, instant feedback, three-state machine (idle → uploading → saved), with retake and "add another" as primary actions on the saved state.

---

## Flow 2 — Review and finalize a single receipt (desktop, batches)

**User story:** "It's Sunday. I have 23 receipts from last week to clean up. For each one, confirm what OCR got right, add what it missed, move on."

**Current path:**
1. `/receipts/review` lists the 50 most recent in a table.
2. Click row → `/receipts/review/[id]`.
3. Form on left, image viewer on right. Fields: payment path, expense type, category, transaction date, merchant, amount, currency, business purpose, attendees, alcohol-present flag.
4. Each field PATCHes on debounce. Save state is implicit.
5. No "next receipt" affordance — user must back-button to the list.

**What's weak:**
- One-receipt-at-a-time loop with back-and-forth navigation kills momentum.
- Form is a vertical wall of inputs; no sense of progress or what's required vs optional.
- Implicit save is anxiety-inducing — was that last edit saved?
- Attendee editor is functional but doesn't surface the autocomplete directory clearly.
- Image viewer doesn't support pinch-zoom, rotate, or "view original" for blurry text.
- No keyboard shortcuts (j/k to next/prev, enter to confirm).
- Category code → attendee requirement coupling is logical but invisible: pick "Entertainment" and the attendees section should snap into focus with a "required" cue.

**Design opportunity:** Treat this like an email triage UI. Persistent list on the side or top, current receipt in focus, keyboard nav, explicit save indicator, smart focus order following category requirements.

---

## Flow 3 — Import AMEX statement (monthly, ~5 minutes)

**User story:** "Once a month I download the Netアンサー CSV and load it so I can reconcile."

**Current path:**
1. Download CSV from Japanese AMEX portal manually.
2. `/receipts/amex` → upload form + month picker.
3. POST to `/api/receipts/amex/import`. CSV is parsed, deduped by `(month, amex_reference, cardholder)`, inserted. Prior artifacts for the same month are marked `replaced` (so re-uploads are safe).
4. Page redraws with stats + artifact history table.

**What's weak:**
- The "what just happened?" feedback is a small stat block; for a 50-line statement it should be more obvious how many were new, replaced, or flagged as business-trip candidates.
- No preview before commit. The user uploads and the import is immediate.
- Validation errors come back as a list; there's no inline highlighting in the CSV.
- No visible link to the new reconciliation work this import created.

**Design opportunity:** Upload → preview (parsed rows in a scrollable table with deltas) → confirm → success state that links straight into `/receipts/reconcile?month=YYYY-MM`.

---

## Flow 4 — Reconcile a month (the dense screen)

**User story:** "AMEX is loaded. For each line, either confirm the suggested receipt, pick a different one, or mark 'no receipt'. Then categorize. Then sign off."

**Current path:**
1. `/receipts/reconcile?month=YYYY-MM` with month switcher.
2. `<ReconciliationTable>` shows each AMEX line as a card: merchant, amount, date, suggested receipt thumbnail, match confidence, category dropdown, attendee mini-editor, action buttons (confirm / unlink / no-receipt).
3. Orphan receipts (no AMEX line matched) shown in a separate list at the bottom.
4. Bulk-confirm action with a progress bar.
5. "Finalize reconciliation" button locks the month.

**What's weak:**
- The card-per-line layout consumes vertical space; on a 27" monitor you see 4-5 lines at once. For a 50-line month this is a lot of scrolling.
- Category dropdown + attendee editor inline per card is dense. Most lines need only a confirm click; the heavy editors should be progressive disclosure.
- Match confidence is a number; doesn't communicate "you should look at this one" vs "obvious match".
- Orphan receipts at the bottom are visually equal to matched lines but semantically different.
- No keyboard navigation. This is the screen most in need of one.
- Locked-month state isn't visually distinctive enough — it looks like editable state but with greyed buttons.

**Design opportunity:** Two-column or table-based layout for high information density. Confidence as a visual cue (color + icon, not a number). Inline expand for the cases that need editing. Keyboard shortcuts. Clear locked-state styling.

---

## Flow 5 — Export and lock the month

**User story:** "Reconciliation is done. I want one button that says 'send this to accounting' and one that says 'lock it'."

**Current path:**
1. `/receipts/export` shows blockers: unreviewed receipts, uncategorized AMEX, missing attendees, unresolved business trips. Each as a count with a link.
2. Once blockers are zero, "Generate" button creates a draft export (CSV + ZIP staged to R2).
3. Review the draft, download to verify, then "Finalize" makes it immutable.
4. Export history shown below.

**What's weak:**
- Blocker list is a flat list. Some blockers (missing attendees) block; others (unresolved business trips) might be warnings. Hierarchy isn't visual.
- No way to see what's in the draft before downloading — for a casual sanity check, a row count + total amount would be enough.
- Finalize is one click with no confirmation modal. This is the only one-way action in the system.
- Export history shows IDs and timestamps but no clear "what was in this export" summary.

**Design opportunity:** Pipeline view (Draft → Review → Finalize → Done) with the current step highlighted. Blocker triage with severity. Confirmation modal on finalize. Per-export summary chip (line count, total amount).

---

## Cross-cutting screens

### Dashboard `/receipts`

Six quick-link cards, alert banner. Polished already. Could earn its keep by surfacing **this month's status at a glance** (X receipts captured, Y unreviewed, Z reconciled, finalized/not).

### Settings & devices `/receipts/settings/*` and `/receipts/enroll`

Placeholder territory. Devices list works but is utilitarian. Enrollment is a one-time flow that needs to feel trustworthy (it's giving a phone a long-lived cookie).
