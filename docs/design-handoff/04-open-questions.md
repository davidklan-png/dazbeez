# Open Questions for Claude Design

Each question is scoped so a single mock, written recommendation, or short Tailwind sketch is enough to answer it. Tackle them in order — early answers constrain later ones.

---

## A. Capture flow

**A1. Phone capture as full-screen vs in-page?**
Should `/receipts/capture` on mobile become a near-full-screen experience (dominant capture button, status fills the viewport) or stay an in-page form? The rapid mode (`?mode=rapid`) leans full-screen; the deliberate mode less so.

**A2. Retake before commit, or always commit then delete?**
Currently every photo creates a record. Should we add a client-side "preview → confirm" step on phone so misfires don't pollute the DB? Trade-off: extra tap vs cleanup load.

**A3. Surface OCR preview at capture time?**
Vision OCR runs server-side after upload. Should the capture success state show the extracted fields (merchant, amount, date) for instant verification, or save that for the review screen?

---

## B. Review flow

**B1. List vs single-detail vs split-view?**
For `/receipts/review`, three options:
- (a) List page → click → detail page (current). Simple, slow.
- (b) Split view: list on left, detail on right. Fast triage, more code.
- (c) Single-detail with next/prev nav and a queue indicator. Email-style, very fast for batches.

Pick one and justify.

**B2. Save model: explicit save button, debounced auto-save with indicator, or per-field optimistic with badge?**
Current implicit per-field debounce is anxiety-inducing. Recommend a clear pattern.

**B3. Field grouping & progressive disclosure?**
Receipt has ~12 editable fields. Group as: (1) Identification — merchant/date/amount/currency. (2) Classification — payment path, category, expense type. (3) Documentation — business purpose, attendees, alcohol. Or different grouping? Show all at once or progressive?

**B4. Image viewer affordances?**
What's the minimum viable image viewer — zoom, pan, rotate, fullscreen, side-by-side with form? It's the single thing most likely to make review feel professional.

---

## C. Reconciliation flow

**C1. Table vs cards vs split view for `/receipts/reconcile`?**
A 50-line month is the typical case. Cards (current) waste space. Plain table is dense but loses visual hierarchy. Split view (line list + detail panel) is the email pattern again. Recommend one with reasoning.

**C2. Confidence display?**
Match confidence is a 0–1 number. Render as: traffic-light icon, percentage bar, color-shaded row background, or a label like "obvious" / "likely" / "review"? Pick one.

**C3. Bulk operations UX?**
Bulk confirm exists but is hidden. Should there be a "confirm all matches above 90% confidence" macro? A select-multiple + bulk-categorize? What's the minimum to avoid feeling unsafe?

**C4. Keyboard shortcuts — yes or no?**
For a screen used monthly for ~30 minutes by a power user, keyboard nav (j/k, c=confirm, n=no-receipt, e=expand for edit) is high value. Worth designing if Claude Design will also implement.

**C5. Orphan receipts placement?**
Receipts with no matching AMEX line live at the bottom currently. Surface them: (a) where they are, (b) as a tab/section toggle, (c) interleaved by date with a different visual treatment?

---

## D. Export flow

**D1. Pipeline visualization?**
Should `/receipts/export` show a horizontal pipeline (Draft → Review → Finalize → Archived) with the current step lit, or keep the current scrolling-list layout?

**D2. Finalize confirmation pattern?**
Modal? Type-the-month-to-confirm? Two-step button? It's the only irreversible action in the system.

**D3. Export summary chip per row?**
For the history table, what info belongs on each row beyond month + status? Line count, total amount, finalized-by-actor, finalized-at?

---

## E. Cross-cutting

**E1. Dashboard `/receipts` content?**
Currently 6 navigation cards + alert. Should it also show "this month at a glance" (counts, status)? If yes, does that make the cards redundant?

**E2. Empty states?**
What does each screen look like with zero data? First-ever capture, first-ever AMEX import, first-ever export. The system is internal-only so this only matters early in the year for "no receipts yet this month" states — but still worth designing.

**E3. Locked-month visual language?**
After reconciliation sign-off and after export finalize, multiple screens shift to read-only. Is the pattern (a) global banner + disabled inputs, (b) full read-only mode with a separate "view-only" treatment, (c) edit-protected but visually identical with toast feedback on attempted edit?

**E4. Error states across the app?**
There's no consistent error pattern today. Banner at top of page? Toast? Inline below field? Pick one default plus one for destructive-action-failed.

**E5. Trusted-device enrollment UX?**
`/receipts/enroll` gives a phone a 1-year cookie. Should this feel like a "pair a device" flow (confirmation, name the device, success state explaining what just happened) or stay a simple form?

**E6. Loading skeletons vs spinners vs progress bars?**
Pick the default. Currently mixed.

---

## F. Implementation packaging

**F1. PR sequence?**
Propose 5-7 PR-sized chunks in dependency order. Likely shape: foundations (shell + tokens) → capture → review list/detail → reconcile → export → settings/devices → polish pass. Refine.

**F2. Component reuse from the marketing site?**
The marketing site has its own button, card, and layout idioms. Should the receipts module reuse them verbatim, fork them with receipt-specific variants, or share a primitives layer?
