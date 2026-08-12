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

---

## §3 (added 2026-08-12, architect follow-up) — Missing 2026-06 revisions: deliberate test-seal cleanup, not data loss

**Verdict: the missing rows WERE deleted — deliberately, operator-authorized, as
pre-close production-test-seal cleanup. Not a bug, not data loss, and not an
audit-trail gap (the removal is audited).** `createExportRevision` computes
`(prior.export_revision ?? 1) + 1`, so a surviving rev 3 mathematically implied
revs 1 and 2 existed; the audit log shows they did, and why they're gone.

### Evidence

1. **No app code deletes `receipt_exports`.** The only `DELETE` near the table
   is `DELETE FROM receipt_export_items WHERE export_id = ?` (db.ts:2955, inside
   `replaceExportItems` — clears items before re-insert, not a row delete). No
   migration deletes/renumbers `receipt_exports` rows (migration 0017 defines a
   child→parent `ON DELETE CASCADE` FK, but nothing in app code triggers it).
   So the deletion was an **out-of-band operator action**, not a code path.
2. **The audit log records the full 2026-06 history** (`object_type='export'`):
   - 2026-07-12 `export.created` `bfa94a26` (rev 1) → 2026-07-14 `export.finalized`.
   - 2026-07-15 `export.revision_created` `fc9b786d` (rev 2, "tranche1") → 2026-07-17 `export.finalized`.
   - 2026-07-18 `export.revision_created` `fb8cf556` (rev 3, *"Smoke test 7.4
     (review-queue lock release) — draft will be deleted, no data changes"*) — a
     smoke-test draft, deleted same day.
   - 2026-07-18 `export.revision_created` `4e5afb3e` (rev 3, *"Draft 2 submit for
     review"*) — the real rev 3 (the smoke test had been deleted, so the max
     revision fell back to 2 ⇒ this is rev 3 again, consistently).
   - **2026-07-22 cleanup (batch `8a4671fb-6e43-4328-aae7-e6432f976ce8`):**
     `export.test_seal_removed` for `bfa94a26` AND `fc9b786d` — *"operator-
     authorized removal of pre-close production-test seal"*, with
     `retention_legalhold_exception: "limited to this test artifact"` and
     `preserved_draft_id: 4e5afb3e`. Plus `export.draft_supersession_cleared`
     for `4e5afb3e` — *"logical predecessor (rev2) removed as operator-authorized
     pre-close test artifact; active accountant-review draft (rev3) preserved."*
   - 2026-08-11 `export.finalized` `4e5afb3e` (rev 3) → `revision_created`
     `c88c1097` (rev 4, "Rebuild for email message") → `finalized`.
3. **Other months are NOT affected.** 2026-05 = rev 1; 2026-07 = rev 1
   (contiguous). 2026-06 is unique because it is the only month that carried
   pre-close production-test seals.
4. **No orphaned R2.** Probed `exports/2026-06/{rev1id}-proofs.zip` and
   `{rev2id}-proofs.zip` (and the smoke-test draft) in `dazbeez-receipts-archive`:
   all three are **absent**. The cleanup removed both the D1 rows AND their
   staged R2 objects — the only staged 2026-06 objects are the real rev 3 +
   rev 4, exactly as measured in the original Item 0 R2 sweep.

### Process finding (for the architect — not a code defect)
The cleanup was a one-off out-of-band operation:
- It used **non-standard audit actions** (`export.test_seal_removed`,
  `export.draft_supersession_cleared`) that are **not in the `AuditAction`
  union** and have **no committed code** (grep of lib/app/scripts is empty) — it
  was a run-once script / direct D1 on 2026-07-22.
- It deleted rows with `legal_hold` set (createExport inserts `legal_hold=1`),
  under a recorded `retention_legalhold_exception` — a serious action on a
  10-year-tax-record table that should remain rare and tightly controlled.
- There is **no standard `export.deleted` audit action**; the trail relies on
  the one-off `test_seal_removed`. If another such cleanup happens, it should
  use a consistent, typed action promoted into `AuditAction`, and ideally be a
  committed, logged runbook rather than an ad-hoc script. (The smoke-test draft
  `fb8cf556` was deleted with no removal audit at all — lower-stakes as an
  unfinalized draft, but worth noting.)

**Bottom line:** the 2026-06 revision gap is benign and fully explained. No
action needed on the data. The only takeaway is the process note above: sealed-
export deletion is currently an out-of-band, legal-hold-exception,
untyped-audit operation with no committed code — a documented runbook + a typed
`export.deleted`/`export.test_seal_removed` action would make the next one safer
and more discoverable.

---

## Verification
Personally re-read/confirmed: T1-1 (the import graph), and all four Part (b) findings (D1 queries + the `hardDeleteReceipt` batch + the `preservation_status` grep). Part (a) T1-2…T3 are agent-reported with precise file:line — the architect should spot-check before acting. No code or data was modified.

---

## §5 priority 3 (added 2026-08-12) — a Tier-1 invariant promoted from agent-reported to VERIFIED

Continuing the ranking, deepest blast radius first. This entry verifies the
worst-class one (T1-7 in the list above) so the architect can act on it without
re-checking.

### T1-7 (VERIFIED) — exhaustive reads throw-at-cap, but the throw is untested

`listAllReceiptsInMonth` (db.ts:616) and `listAmexReceiptsForReconcile`
(db.ts:685) are the exhaustive reads that feed the **sealed export bundle** and
the **reconcile view**. Both page internally and **throw** at a hard cap
(default 10000 and 5000 respectively) rather than silently truncate — and their
own comments name the failure mode ("silent truncation … would be an audit
failure", "a truncated reconcile view would hide receipts").

**Verified:** the throw is real in both (`if (out.length >= hardCap) throw new
Error(...)` at db.ts:~649 and ~718/~735). **But `grep` of `tests/` for either
function name returns nothing — no test exercises either, so no test asserts the
throw.** The safety is a single untested conditional.

**Blast radius — the worst class.** Removing the `if (out.length >= hardCap)
throw` check would fail no test, and a month with >10000 receipts would then
**silently omit receipts from the sealed export bundle** — a receipt the
accountant never sees, permanent and undetected on a 10-year tax record. (The
reconcile cap hiding receipts is serious but recoverable on the next reconcile;
the export-bundle cap is the sealed-pack completeness failure.)

**Recommended test (report, not fix):** a unit test that constructs the function
at a tiny `hardCap` (e.g. `opts.hardCap = 2`) over ≥3 rows and asserts it
throws. Both functions are D1-coupled (no fake-DB harness today), so this likely
needs the same injected-DB treatment the agent noted for `buildExportBundle`
(T1-2) — the two cheapest highest-leverage test harnesses to add.

### Other Tier-1 candidates still agent-reported (not re-verified this pass)
T1-2 (`buildExportBundle` "appears once, never twice" — no test at all),
T1-5 (`delivery_state` same-batch write), T1-6 ("failed send never touches the
seal"), T1-9 (`finalizeExport` refuses to run twice). All are the same shape
(documented invariant, prose-only safety) and would fall to the same
injected-DB / structural-assertion test technique.

---

## §6 priority 4 (added 2026-08-12) — remaining Tier-1 invariants promoted agent-reported → VERIFIED

Continuing the ranking, deepest blast radius first (a silent failure that makes
a **sealed or delivered month** wrong). All five below were re-read in source;
each is documented in a comment/JSDoc, **true in the code today**, and
**untested** (zero `grep` hits in `tests/`). Report, not fix — the architect
picks which to pin. The same injected-DB / structural-assertion technique that
landed T1-7 applies to all of them.

### Correction first: T1-7 is now TESTED

§5 promoted T1-7 to VERIFIED but still called it untested. It is no longer:
`tests/receipts/exhaustive-read-throw-at-cap.test.ts` (PR #177, merged) pins the
throw-at-cap for both `listAllReceiptsInMonth` and `listAmexReceiptsForReconcile`
via the `opts.db` / `opts.hardCap` injection seam, with cases for the
mid-window throw and the post-union-with-undated throw. T1-7 is closed.

### Ranked — deepest sealed/delivered blast radius first

| # | ID | Verdict (VERIFIED) | Blast radius if it silently broke |
|---|----|--------------------|-----------------------------------|
| 1 | **T1-6** | "A failed send never touches the seal" — `markDeliverySent`/`markDeliveryFailed`/`markDeliveryAmbiguous` (`db.ts:3386-3462`) each run one `db.batch([...])` whose two statements touch only `export_deliveries.state` + `receipt_exports.delivery_state`, never a sealed column. Section comment at `db.ts:3277-3280`; per-fn JSDoc at `:3413`, `:3442`. **Untested** (delivery-state.test.ts tests only the pure derivation). | Worst of the five: a future edit that re-stamps `finalization_hash`/`archive_sha256` on a send would silently mutate the sealed bundle's identity on a *delivery failure* — downloaded pack ≠ audited hash, permanent on the 10-year record. |
| 2 | **T1-9** | `finalizeExport` refuses to run twice — `UPDATE … WHERE id=? AND status='draft'` then `if (changes===0) throw` (`db.ts:3191-3207`). **Untested** (no runtime call to `finalizeExport`; export-revision-flow.test.ts is D1-integration-gated and asserts byte-identity, not the throw). | Dropping the `status='draft'` predicate → re-finalize re-writes `finalization_hash`/`finalized_at` on a sealed row + re-runs receipt promotion. Sealed immutability broken; two `export.finalized` events on one row. Narrower than T1-6 (the route guards re-entry), but the receipt-promotion UPDATE has its own `status IN (...)` guard limiting blast. |
| 3 | **T1-2** | `buildExportBundle` "a matched receipt appears once, never twice" — dedup via `matchedReceiptMap` filter (`month-closing.ts:106-118`) + `seenReceiptIds` Set (`:140, 179-182`). Documented at `:50-52`. **Untested** (no test imports `buildExportBundle`). | A receipt both matched to a month-M AMEX line AND in month-M's `listReceiptsByExportStatementMonth` set → two rows → double-counted amount in the sealed CSV/ZIP + two `receipt_export_items`. **Correction to the audit's framing**: under ADR 0008 the overlap is *not* "AMEX-and-CASH/DIGITAL" (a matched receipt is `payment_path='AMEX'`) — it is "an AMEX receipt whose calendar month equals the statement month," i.e. the **normal** case. The dedup is load-bearing on every sealed pack, not an edge. |
| 4 | **T1-10** | Cross-month sealed-claim guard *inside* `updateAmexReconciliation` (`db.ts:1479-1508`) — a `SELECT … JOIN amex_reconciliations WHERE status='finalized' … AND statement_month != ?` that throws if the receipt is already confirmed in a *different finalized* month. Defense-in-depth below `rejectIfFinalized` (`:1452`), which only checks the target line's month. **Untested** — `updateAmexReconciliation` has zero test refs; `cross-month-claims.test.ts` tests only the pure page helper. | Removing the in-function SELECT → a receipt claimed by finalized month A could be re-linked from open month B, and `updateAmexReconciliation` would mutate its merchant/date/status → finalized-month immutability for A. Two further layers (`rejectIfFinalized` + the export gate's `cross_month` blocker) make a silent break less likely than T1-6/T1-9. |
| 5 | **T1-5** | `delivery_state` written in the SAME `db.batch([...])` as the attempt row — all four wrappers (`createDelivery:3301-3334`, `markDeliverySent:3386-3408`, `markDeliveryFailed:3415-3434`, `markDeliveryAmbiguous:3443-3462`) are single `db.batch` arrays. Documented at `db.ts:3277-3280`. **Untested** (no test asserts the two writes are one batch). | Lowest of the five. The audit's "re-send a delivered month" framing overstates it: the pill reads `delivery_state` directly, but `decideSendAction`/`findRevisionSendBlocker` (heavily tested) key off the **attempt rows**, not the pill — so a stale pill is a confusing label, not an automatic re-send. Real but recoverable. |

### Cross-cutting

T1-6, T1-9, T1-10, and the T1-5 batch claim are all in D1-coupled `db.ts`
functions with **no fake-DB harness** — the same blocker §5 noted for T1-2/T1-7.
The `opts.db` injection seam (proven by `softDeleteReceipt`, `unfinalizeReconciliation`,
and now the T1-7 test) is the established convention. Adding it to the delivery
wrappers, `finalizeExport`, and `updateAmexReconciliation` would unlock T1-5,
T1-6, T1-9, and T1-10 with one harness each — the cheapest highest-leverage next
batch of test adds after T1-7.

No agent claim was materially wrong on these five (the only imprecision was
T1-2's trigger framing under ADR 0008, corrected above). All five documented
invariants are **true in the code today** and **all five are untested**.

**Verification:** personally re-read each cited line; confirmed zero `tests/`
coverage via grep. No code or data was modified.
