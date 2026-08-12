# Export workflow UX — staged, predictable month-close

**Status:** design only, not scheduled. Backlog #24. Do not start until
2026-06 is sent and closed.

**Problem statement (operator, 2026-08-11):** "Review and finalize" and
"Send" need to be separate, clearly-sequenced steps. Each of draft →
review → finalize → send must follow a predictable pattern with visual
cues for what is complete, in progress, and pending. The operator should
never have to hunt the page for what comes next.

---

## 1. What the code actually does today

### 1.1 A pipeline exists, but it models the wrong lifecycle

`components/receipts/export/export-screen.tsx:269` renders a five-step
`Pipeline`: **Reconcile → Draft → Review → Finalize → Archived**.

- **Send is not a stage.** Delivery — the step that actually closes the
  month for reporting — is absent from the model. It is bolted on as a red
  banner (`delivery-month-banner.tsx`) rendered *below the export history
  table*, the furthest point on the page from the pipeline that is supposed
  to be telling the operator where they are.
- **"Archived" is a property, not a stage.** It is `done: finalized` with
  sub "7-year retention" — nothing happens there and no action is
  available. It goes green the instant finalize completes, so the pipeline
  shows two consecutive green steps at the exact moment the month is
  *least* complete: sealed, undelivered, not closed.
- **`stepIndex` contains dead logic.** Line 278:
  `finalized ? 3 : draftBuilt && blockerCount === 0 ? 2 : draftBuilt ? 2 : 1`
  — the two middle branches both yield `2`, so the blocker count doesn't
  affect the step at all.
- **"Reconcile" is hardcoded `done: true`.** It never reflects whether the
  month's reconciliation is actually signed off — even though that is
  finalize gate #1 and the single most common blocker.

### 1.2 The next action has no fixed home

Depending on state, the thing to click next is in one of four places:

| Action | Where it lives |
|---|---|
| Build / Rebuild draft | `TopBar`, top-right of the export page |
| Review & finalize | `ReviewLinkCard`, right rail, mid-page |
| Finalize (actual) | a different page — `/export/[month]/review` |
| Send | a red banner at the page bottom → a third page, `/export/[month]/send` |

Three pages and four locations for one linear workflow. The screenshot
that prompted this shows the failure precisely: "Review & finalize" sits
in the right rail while the red 未送信 banner sits far below the export
history, with no visual relationship between them and no indication that
one follows the other.

### 1.3 The map disappears exactly when it's needed

`Pipeline` renders **only** on the export page. `/review` and `/send` each
have their own bespoke headers (`ReviewHeader`, the composer header). The
moment the operator advances a stage, they lose the one component that
tells them what stage they're in and what remains.

---

## 2. Design principles

1. **One derived stage, server-side.** A single `deriveMonthStage()`
   computes the month's position from existing state — reconciliation
   signoff, `bundle_built_at`, gate blockers, export status, delivery
   state. Every surface reads it. This mirrors the pattern already used by
   `delivery-status.ts` and the `ExportBlocker` union: one authority, many
   renderers. Nothing recomputes stage locally.
2. **One primary action, one fixed location.** Exactly one primary button
   per stage, always immediately beneath the pipeline. Everything else on
   the page is secondary or informational. The operator's eye goes to the
   same place every time.
3. **The pipeline is the map, on every screen.** The same component renders
   on the export page, the review page, and the send composer, with the
   current stage highlighted. Leaving a page never loses the map.
4. **Stages are honest.** A stage is green only when its work is genuinely
   done. Sealed-but-unsent must never read as complete — that mis-signal is
   how 2026-06 sat undelivered from 2026-08-11.
5. **Blocked is a distinct visual state.** Not "pending". A blocked stage is
   red, names the reason, and links to where the blocker is cleared —
   consistent with the `ExportBlocker.href` work already shipped.

---

## 3. Target model

**Reconcile → Draft → Review → Finalize → Send → Closed**

| Stage | Done when | Primary action | Blocked when |
|---|---|---|---|
| Reconcile | reconciliation `finalized` for the month | Go to Reconcile | `reconciliation_not_finalized` (unmatched/unconfirmed lines) |
| Draft (optional) | `bundle_built_at` set AND not stale | Preview side-action (Build / Rebuild) — **not a prerequisite** | `message_stale` (cleared by Rebuild draft) — the one case where Draft gates |
| Review | no Review-stage blockers | Review & finalize | `message_not_reviewed` + receipt / attendee / compliance blockers |
| Finalize | export `status='finalized'` | Finalize | — (blockers live on earlier stages) |
| Send | delivery state `delivered` | Send | preflight failure, missing To, config errors |
| Closed | delivered | — (retention shown as metadata) | — |

**Draft is optional (architect ruling, 2026-08-12).** Decision 4 of the one-shot
finalize prompt (`prompts/WORKER-PROMPT-one-shot-finalize-ui.md`) was absorbed
into this model in substance, superseded in form: building a draft is a preview
affordance, not a gate. The one-shot path builds + seals in one request, so a
month with reconciliation done and a clean gate reaches Review & Finalize
without ever building a draft — the pipeline never renders "build the draft
first" as a prerequisite. Draft shows as an available side-action ("preview the
pack before sealing") and is `done` only when `bundle_built_at` is set and not
stale. `message_stale` stays on Draft per the placement rule below — a stale
message still requires a rebuild, so Draft is genuinely blocking in that one
case; that is the exception, and it is correct.

**Blocker placement — the organising rule.** A blocker sits on the stage whose
*action* clears it, not on the gate number that emits it:

- `reconciliation_not_finalized` → **Reconcile** (cleared by reconciliation signoff)
- `message_stale` → **Draft** (cleared by Rebuild draft)
- `message_not_reviewed` + every other gate blocker → **Review** (cleared by fixing receipts / attendees / compliance / the preface decision)

Placing `message_stale` on Review or Finalize would put the blocker on a
different page from the Rebuild-draft button that clears it — the exact 2026-06
trap, reproduced every month. *(Corrected on architect review 2026-08-12: an
earlier draft of this table listed `message_*` under Finalize, which is the
misplacement this rule exists to prevent.)*

"Archived / 7-year retention" stops being a step and becomes a metadata
line on the Closed stage, where it belongs.

Note the model already exists in the domain vocabulary — `delivery-state.ts`
says it explicitly: *"sealing and closing are different things. Seal locks
edits; delivery closes the month for reporting."* The UI simply doesn't
reflect it yet. This work makes the screen agree with the doctrine.

---

## 4. Implementation sketch

1. **`lib/receipts/month-stage.ts`** — `deriveMonthStage(month)` returning
   `{ stage, status: 'done'|'current'|'pending'|'blocked', blockers,
   primaryAction: { label, href, kind } }[]`. Pure core + async wrapper,
   same shape as `validateMonthReadyForExportCore` / its async sibling, so
   the stage logic is unit-testable without D1.
2. **`components/receipts/export/month-pipeline.tsx`** — replaces
   `Pipeline`. Takes the derived stages. Completed stages are navigable
   links; pending are inert; blocked show the reason inline.
3. **`components/receipts/export/next-action-card.tsx`** — renders the
   single primary action for the current stage, directly under the
   pipeline, on all three pages.
4. **Mount on all three surfaces** — export page, `/review`, `/send`.
   Delete `delivery-month-banner.tsx`'s standalone bottom placement; the
   Send stage subsumes it. Demote `ReviewLinkCard` to a secondary link or
   remove it.
5. **Retire the dead `stepIndex` logic** and the hardcoded `Reconcile:
   done: true`.

**Not in scope:** changing any server-side gate, the finalize/send
decoupling (D1/D2), or the three-page split. The pages are correctly
separated; only the wayfinding between them is broken.

---

## 5. Verification

- Unit tests on `deriveMonthStage` for every state combination, especially
  sealed-undelivered (must render Finalize done / Send current, never a
  fully-green pipeline).
- Screenshots of all six stages, including at least one blocked state.
- Confirm the primary action lands in the same screen position across all
  three pages.
