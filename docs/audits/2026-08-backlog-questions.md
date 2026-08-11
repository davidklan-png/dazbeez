# 2026-08 Untested invariants + open backlog questions

**Scope:** `lib/receipts/`, `app/api/receipts/`. Read-only. Two deliverables in one
doc, per overnight-run Item 7:
- **Part (a)** — a ranked list of invariants documented in comments but not
  asserted in tests. The list is the deliverable; the architect picks which
  matter. **No tests are written here.**
- **Part (b)** — evidence (not binding proposals) on four open backlog questions.

The canonical incident for Part (a): the `operator_message_updated_at` /
`bundle_built_at` lockstep was documented at `types.ts:545` with no test, so
changing it was silent. That is a class, not one bug.

---

# Part (a) — documented-but-untested invariants

Method: grep for invariant language ("always", "must", "in lockstep", "single
authority", "never", "exactly one", "by construction", "cannot drift") in
comments/JSDoc, then check whether a test would FAIL if the invariant broke.
Calibration bar (TESTED — not findings): `operator-message-contract.test.ts`
(the canonical incident, now pinned by `18299ee`), the `buildDeliveryEmail`
single-importer source-tree assertion, the capture-contract "exactly one INSERT"
test, gate/tile parity, `decideSendAction` matrix, `assertExactlyOneRowWritten`.

Verified = personally re-read; agent-reported = precise file:line, not separately
re-verified.

## TIER 1 — HIGH blast radius (sealed/delivered-month corruption)

### T1-1 — **ALREADY BROKEN** (verified) — `serializeExportRowCells` is not the "single serialization authority" it claims
- **Claimed:** shared by the receipts CSV and the CASH/DIGITAL 照合CSVs "so the split files cannot drift from the machine-layer CSV" (`lib/receipts/export.ts:136-140`).
- **Status:** FALSE today. `reconciliation-files.ts:32` imports only `csvEscape, resolveRowAttendees` (not `serializeExportRowCells`) and `formatYenAmount` from `proofs.ts` — it re-implements amount formatting inline. The comment has already silently stopped holding.
- **Breaks:** the delivered receipts CSV and the 照合CSVs can disagree on amount formatting / formula-injection escaping; any future hardening to `serializeExportRowCells` won't propagate to the 照合 builders. Reconciliation discrepancy on a sealed month's 10-year record.
- **This is the live analog of the canonical incident.** Highest-priority: either correct the comment or unify the code, and add a structural test pinning whichever claim is intended.

### T1-2 — `buildExportBundle` "single source of truth / a matched receipt appears once, never twice" — no test at all (agent-reported)
- `lib/receipts/month-closing.ts:32, 54-56`. Enforced by `matchedReceiptMap` + `seenReceiptIds`. Zero references in `tests/`; the function is D1-coupled with no fake-DB harness (unlike its siblings).
- **Breaks:** a receipt both AMEX-matched AND CASH/DIGITAL-assigned → two rows → double-counted amount in the sealed pack's CSV, ZIP, and `receipt_export_items`.

### T1-3 — numbering authority feeding 照合CSVs AND proofs ZIP not structurally pinned (agent-reported)
- One 科目＆No per receipt; assignments feed the recon CSVs AND the proofs ZIP entry names (`app/api/receipts/export/month/route.ts:237-242`, `reconciliation-files.ts:23-27`). Each builder is tested separately, but no test feeds identical inputs to BOTH and asserts the same label/filename.
- **Breaks:** the accountant matches a line to its proof via 科目＆No in the 照合CSV, then the filename doesn't exist in the ZIP — broken evidence chain on a sealed month.

### T1-4 — `validateMonthReadyForExport` "single authority" for finalize not structurally pinned (agent-reported)
- `lib/receipts/month-closing.ts:223-228`. The gate is heavily tested; no test asserts every finalize route calls it. The comment itself documents this drift already happened once ("audit-9 drift").
- **Breaks:** a route bypasses gates → seals/delivers a month with unsealed reconciliation, UNKNOWN/unreviewed receipts, missing proofs, or a stale operator message.

### T1-5 — `delivery_state` written in the SAME D1 batch as the attempt row — not asserted (agent-reported)
- `lib/receipts/db.ts:3273-3276` (repeated at :3294, :3377, :3406, :3432). Pure derivation is tested; the atomic-batch claim is not.
- **Breaks:** list pill disagrees with attempt history → operator re-sends an already-delivered sealed month, or believes a failed month landed.

### T1-6 — "a failed send never touches the seal" — not asserted (agent-reported)
- `lib/receipts/db.ts:3276, :3409, :3437`. No test asserts `markDeliveryFailed`/`markDeliveryAmbiguous` don't write sealed columns.
- **Breaks:** a failed delivery mutates the sealed bundle's SHA/R2 key → the immutable sealed revision is silently corrupted; downloaded pack ≠ audited hash.

### T1-7 — exhaustive reads throw-at-cap, never silently truncate — throw not asserted (agent-reported)
- `lib/receipts/db.ts:616-628` (throw :649-653), `:688-692` (throws :718, :735). No test asserts the throw.
- **Breaks:** a month >N receipts silently truncates the export bundle → a receipt omitted from the accountant's CSV/ZIP. Permanent, undetected completeness failure on a tax record. **Worst-class failure.**

### T1-8 — per-line sign-off rules "shared by finalize gate and closing-attention collector so they cannot drift" (agent-reported)
- `lib/receipts/reconciliation-signoff.ts:97-107, 128-137, 255-266, 299-306`. Predicates well-tested; no test feeds both consumers identical inputs / no structural import assertion.
- **Breaks:** gate blocks on a rule the review screen doesn't surface (or vice-versa). The consolidated-sum rule is a hard accounting invariant for the sealed pack.

### T1-9 — `finalizeExport` refuses to run twice (`status='draft'` guard) — not asserted (agent-reported)
- `lib/receipts/db.ts:3199-3203, :3224-3227`. No test asserts re-finalize throws.
- **Breaks:** re-finalize re-writes `finalization_hash`/`finalized_at` on a sealed row, or re-promotes receipts. Sealed immutability broken.

### T1-10 — cross-month sealed-claim guard in `updateAmexReconciliation` (agent-reported)
- `lib/receipts/db.ts:1475-1504`. `cross-month-claims.test.ts` tests the higher-level guard, not the in-function SQL defense-in-depth.
- **Breaks:** a receipt in a finalized-reconciliation month gets mutated by a confirm elsewhere → finalized-month immutability broken.

## TIER 2 — HIGH/MEDIUM (agent-reported, summarised)
- **T2-1** `deriveFinalizedMonthsDeliveryState` "the ONE server helper" surfaces share — no test (`delivery-status.ts:1-7`).
- **T2-2** `composeDelivery` parity test omits the composer PAGE (only pins send route + preview) — `delivery-compose.test.ts:121`.
- **T2-3** "sealing and closing are different things / edit-lock never depends on delivery" — not pinned (`delivery-state.ts:10-16`).
- **T2-4** `runPreflightOnSealedZip` purity / "nothing re-fetches" — not structurally asserted (`delivery-preflight.ts:1-7`).
- **T2-5** `listUnknownInScopeReceipts` "shared by gate 2 and the export tile" — not pinned (`membership.ts:59-65`).
- **T2-6** capture failure semantics (manifest LOUD / enqueue BEST-EFFORT, "do not unify") — contract not tested (`capture.ts:8-13`).
- **T2-7** `extraction_state='captured'` seeded only for status='captured' — not asserted (`db.ts:107-113`).
- **T2-8** `computeExportBlockers` "PRESENTATION ONLY / add rules to the gate, not here" — not structurally pinned (`blockers.ts:6-11`).

## TIER 3 — MEDIUM (agent-reported, one-liners)
- `month-lock.ts:66-69` two lock populations never overlap (system-disjointness untested).
- `db.ts:56-64` `derivePreservationStatus` "no path writes a literal" — structural half untested.
- `storage.ts:5-10` shared filename sanitizer "cannot drift" between receipts key and intake key.
- `month-lock.ts:118-137` `isMonthExportFinalized` self-declared untested.
- `db.ts:1548-1556` UNKNOWN→AMEX classification in same batch as match confirmation.
- `db.ts:1106-1108` AMEX line `receipt_status`/`receipt_missing_reason` set on first insert only.
- `email-intake.ts:355-357` `recordBlockedIntake` row + audit in one batch.
- `review-attention.ts:1-10` "SINGLE authority" across three consumers.
- `merchant.ts:143-148` canonical key "read-side only, never persisted as a category-rule key".
- `app/api/receipts/duplicates/purge/route.ts:13` "the ONLY path that performs permanent purge" — no source-tree grep.

## Patterns (for the architect)
1. **The dominant untested idiom is "shared by X and Y so the two cannot drift" / "single authority"** (T1-1, T1-3, T1-4, T1-8, T2-1, T2-5, T3-8). Sharing is enforced only by an import that happens to exist today. The structural-assertion technique is proven (`operator-message-contract.test.ts`, `capture-contract.test.ts`, `delivery-compose.test.ts:107`) — grep for callers, assert the import graph. **These are the highest-leverage test adds.**
2. **`buildExportBundle` (T1-2) has no fake-DB harness at all**, unlike its siblings. One harness covers T1-2 and part of T2-5.
3. **D1 batch/transaction atomicity + throw-at-cap claims (T1-5, T1-6, T1-7, T1-9, T2-3, T2-6, T3-7) are prose-only.** T1-7 (silent truncation of a sealed bundle) is the worst-class failure and has only an untested throw as its safety.
4. **T1-1 is already broken** — fix or correct the comment, and pin the intended claim with a structural test.

---

# Part (b) — open backlog questions (evidence, not proposals)

## #23 — is `preservation_status` exempt from the export-lock / finalized seals?
**Finding: it is display/list-only — no gate reads it.** A grep for `preservation_status` outside tests/comments shows only:
- `db.ts:125` — INSERT (written at capture, derived from status via the capture-contract work).
- `db.ts:672` — a list-query SELECT column list (read for display).
No finalize gate, no edit-lock predicate (`month-lock.ts`, `loadSealedExportMonths`), no export-lock reads it to make a decision. The column is written but nothing acts on it.
**Implication for the backfill:** because nothing reads it for a seal decision, a blanket `UPDATE receipt_records SET preservation_status = derive(status)` would most likely NOT trip the export-lock / finalized-reconciliation guards (those key on `status`, `finalized_at`, `finalization_hash`, not `preservation_status`). So the #23 open question leans toward "yes, exempt" — but the architect should confirm the exact seal predicates (`month-lock.ts`) don't reference it before a backfill ships. (Not binding; read-only finding.)

## #5 — are the 2 dangling `receipt_files` rows still there, and does the purge cascade?
**Both RESOLVED.**
- **Zero dangling rows today.** `SELECT … FROM receipt_files rf LEFT JOIN receipt_records rr ON rf.object_id = rr.id WHERE rf.object_type='receipt' AND rr.id IS NULL` → **0 rows** (494 `receipt_files` rows scanned). The two rows AGENTS.md #5 named (`37df0d98…`, `45dfd7e5…`) are gone.
- **`hardDeleteReceipt` cascades.** `db.ts:261-278` runs a `db.batch([...])` that includes `DELETE FROM receipt_files WHERE object_type='receipt' AND object_id=?` (`:272`) before the `receipt_records` delete. So the canonical hard-delete path (the manifest-LOUD path from PR #63) no longer orphans `receipt_files`. Soft-deletes (`softDeleteReceipt`) keep the row (no dangler — the JOIN still resolves).
**Residual #5 follow-up unchanged:** the iOS client must still SURFACE the 500 (parked).

## #2 — `listReceiptSummaries` cost (is `extraction_json` dominating?)
**Not at current scale — the refactor is premature.**
- Active receipts: **115** (`deleted_at IS NULL`).
- `extraction_json`: **avg 814 bytes, max 4829 bytes.** Total if loaded wholesale ≈ **94 KB**.
- So even if `listReceiptSummaries` SELECTs `extraction_json` for every row, it is ~94 KB — trivial, and it does not dominate the payload. (I could not confirm from a quick grep whether the function's query selects it — the SQL may be built dynamically — but the bound holds either way: 115 rows × <5 KB is negligible.)
**Recommendation:** #2 (month-scoped, column-projected queries; drop global `LIMIT 200/1000`) is a sensible design for scale, but there is no current cost problem to fix. Defer until receipt count grows by ~10–50×. Re-prioritise accordingly.

## 2026-05 — why is there an open draft when 2026-06 is sealed+delivered?
**It is an empty abandoned shell — no content, harmless, contradicts backlog #7.**
- The single 2026-05 row (`6be9b4fe…`): `status='draft'`, `created_at=2026-05-17`, `bundle_built_at=NULL`, `operator_message_updated_at=NULL`, `finalized_at=NULL`.
- `receipt_export_items` for 2026-05: **0 rows.** Nothing is staged in it.
- So "is anything in it not in a later month?" — **nothing is in it at all.** It is a bare draft record opened 2026-05-17 and abandoned.
- **Contradiction with backlog #7** (which says "2026-05 already finalized; archived manifest in R2"): D1 has no finalized 2026-05 export and no 2026-05 `amex_reconciliations` row. Either the R2 archive manifest predates a D1 re-migration/reset, or #7's claim was about a different artifact. The draft is harmless (empty) and safe to delete, but **this is read-only — no action taken.** Worth a human glance to confirm the R2 archive for 2026-05 is or isn't expected before any cleanup.

---

## Verification
Personally re-read/confirmed: T1-1 (the import graph), and all four Part (b) findings (D1 queries + the `hardDeleteReceipt` batch + the `preservation_status` grep). Part (a) T1-2…T3 are agent-reported with precise file:line — the architect should spot-check before acting. No code or data was modified.
