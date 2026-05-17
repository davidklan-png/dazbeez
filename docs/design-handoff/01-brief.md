# Brief — Receipts System UI/UX

## What it is

An internal expense-tracking module embedded in the Dazbeez marketing site, used by Dazbeez staff to:

1. Capture business receipts (paper photos, digital records).
2. Reconcile them against monthly AMEX statements imported from Netアンサー (Japanese AMEX online portal).
3. Categorize expenses with attendees and business purpose where required by Japanese tax law.
4. Export a finalized, immutable monthly bundle (CSV manifest + receipt archive) for accounting.

It is **not** a public-facing product. Auth is Cloudflare Access JWT in production, with a trusted-device cookie path for repeated phone use, and Basic auth as a local-dev fallback.

## Who uses it

- **Primary user:** David (founder), capturing receipts on iPhone in the moment (restaurant, taxi, hotel) and reconciling on desktop monthly.
- **Secondary user:** A bookkeeper / accountant role that may review and finalize exports. Not yet a real persona but design should leave room.
- **Mobile vs desktop split:** Capture is ~95% phone. Review / reconcile / export is ~95% desktop. AMEX import is desktop-only (needs a CSV file).

## Domain model in one paragraph

A **receipt record** is one expense, created by uploading a photo to R2 and writing a row in D1. Google Cloud Vision OCRs the image and prefills merchant, date, amount, currency, and expense type. The user reviews and fills in payment path (AMEX/CASH/DIGITAL), expense category (14-item Japanese tax catalog), business purpose, and attendees (required for entertainment/meeting categories). Separately, monthly AMEX statements arrive as CSV; each statement line either matches an existing receipt (auto-matched by merchant fuzzy logic + date window) or flags a missing receipt. Reconciliation locks the month. Export generates a CSV + ZIP, stages to R2, and finalizes (immutable).

## Success criteria for this UI/UX engagement

1. **Capture takes under 10 seconds on phone** from app open to "saved" confirmation, including reasonable upload time.
2. **Review feels like editing a form, not filling out a tax return** — sensible defaults, attendees autocomplete, image always visible alongside fields.
3. **Reconciliation feels like email triage**, not spreadsheet work — fast confirm/skip/categorize keystrokes, batch operations where safe.
4. **Export shows a single clear blocker count** before allowing finalize, with one-click navigation to fix each blocker.
5. **The whole thing looks like Dazbeez** — bee theme (amber + charcoal), Inter font, rounded-xl/2xl, consistent with the marketing site in `docs/ui-ux.md`.

## Hard constraints

- **Framework:** Next.js 16.2.3 App Router. **No `getStaticProps`, no Pages Router patterns.** Read `node_modules/next/dist/docs/` if unsure — this is not the Next.js you know.
- **Styling:** Tailwind CSS only. No CSS-in-JS, no styled-components.
- **Server-first:** Default to server components. Add `"use client"` only where interactivity demands it (forms, drag-drop, live tables).
- **Theme:** Inherit `app/globals.css` — `--bee-yellow #F59E0B`, `--bee-charcoal #111827`, focus ring already defined.
- **Mobile-first:** Capture must work one-handed on iPhone. Use `<input type="file" capture="environment">` where the native camera is the right primitive.
- **No new deps without justification.** No PDF lib, no chart lib, no UI framework (no shadcn/Radix/HeadlessUI in current bundle — check before adding).
- **No live infrastructure access** during design work — see README.md "Working environment rules".

## Out of scope for this engagement

- Backend logic changes (matching algorithm, OCR, export format) — the plumbing works.
- Auth flow changes — Cloudflare Access is owned by the Mac side.
- New entity types (no projects, no clients, no budgets).
- i18n — the catalog is bilingual JA/EN but the UI is English-only for now.
- Accessibility audit beyond the basics (focus rings exist, semantic HTML, keyboard nav for the two complex screens).
