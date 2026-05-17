# Receipts System — Design Handoff Package

**Audience:** Claude Design (sibling session working on UI/UX implementation)
**Status:** Active — module is in production with working plumbing; UI/UX is functional but rough
**Branch for design work:** `claude/receipts-system-ui-ux-DBp5W`

---

## Read these in order

1. **[`01-brief.md`](./01-brief.md)** — What we're building, who uses it, what success looks like, scope of this engagement, hard constraints (tech stack, dev environment split, bee theme).
2. **[`02-current-state.md`](./02-current-state.md)** — Full inventory of every route, API, lib module, component, and DB table that exists today. Reference, not narrative.
3. **[`03-flows-and-screens.md`](./03-flows-and-screens.md)** — The five end-to-end user journeys (capture, review, AMEX import, reconcile, export) with current UX state and what's weak about each.
4. **[`04-open-questions.md`](./04-open-questions.md)** — The design decisions we need Claude Design to drive. Each one is scoped enough to answer with mocks or a written recommendation.

---

## Companion docs already in the repo

Don't duplicate these — link to them.

- `docs/ui-ux.md` — Existing site-wide design system (bee colors, typography scale, component patterns). The receipts module must inherit this.
- `docs/dazbeez-receipt-module-prd.md` — Original PRD for the module. Domain-level context.
- `docs/receipt-module.md` — Architectural overview.
- `docs/receipt_PRD_update.md` — More recent product updates.
- `docs/receipt_review_feature_requests.md` — Specific UX requests already filed (capture acknowledgment, etc.) — these are concrete starting points.
- `docs/amex_requirements.md` — AMEX reconciliation requirements.
- `docs/expenseCat_Requirements.md` — Expense category catalog.

---

## What we want back from Claude Design

In rough priority order:

1. A **screen-by-screen visual design** for the 9 receipts routes, mobile-first, inheriting the bee theme. Tailwind class lists are fine — we don't need Figma.
2. **Interaction patterns** for the two complex screens: review detail (`/receipts/review/[id]`) and reconciliation (`/receipts/reconcile`). These are where users spend real time.
3. **A capture flow optimized for phone use** — single-hand, one-tap retry, clear upload state. The current form is a desktop drag-drop with a bolt-on mobile path.
4. **Answers to the open questions in `04-open-questions.md`**, with rationale.
5. **An implementation plan** broken into PR-sized chunks (capture polish → review polish → reconciliation polish → export polish → settings/devices polish).

---

## Working environment rules

This work happens on the **PC** side of the split documented in `/AGENTS.md`:

- Write code, run `npm run build`, run unit tests with mocked bindings.
- **Do NOT** try to connect to D1, R2, or Cloudflare Access. The Mac handles all live infrastructure.
- Use `lib/cloudflare-runtime.ts` as the pattern for any new binding-touching code.
- `npm run dev` works for visual iteration with stubbed data — that is the primary feedback loop for UI work.

---

## Quick orientation commands

```bash
npm run dev                # local dev server (stubbed bindings)
npm run build              # type-check + compile
npm test                   # unit tests (mocked)
ls app/\(receipt-system\)/receipts/   # all routes
ls components/receipts/    # all components
ls lib/receipts/           # all domain logic
```
