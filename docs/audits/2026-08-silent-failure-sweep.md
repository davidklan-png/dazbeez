# 2026-08 Silent-failure sweep — receipts module

**Scope:** `lib/receipts/`, `app/api/receipts/`, `scripts/receipts-consumer/`. Read-only.
**Method:** three parallel sweeps, one per failure class (each traced from a real
incident), then the highest-signal findings verified by re-reading the code.
**Policy:** this is an audit, not a fix list. A fix without the architect's read
is how a sweep turns into a regression (see AGENTS.md #12). Every finding below
is "report, do not fix" unless the architect picks it up.

The two worst bugs of the last cycle were the same shape twice, and both hid for
months: a value that was correct in its module and silently wrong where it
crossed a boundary — the AMEX `header.indexOf("金額")` → `row[-1]` → `?? 0`
amount (PR #168), and the `body.operatorMessage ?? stored` message loss (PR #169,
fixed via `resolveOperatorMessageForRebuild`). This sweep hunts the residual
instances of three classes of that shape.

---

## Class (a) — silent-zero / silent-fallback lookups  (the AMEX shape)

A lookup whose **miss is coerced to a default** rather than raised as a named
error. The canonical bar (NOT a finding): `amountColumnIndex`
(`pack-preflight.ts:215-227`) — semantic match, exactly-one-or-named-failure; its
docstring (L194-208) explicitly names the `indexOf → row[-1] → ?? 0` anti-pattern.

### A-M1 — MEDIUM (verified) — `header.indexOf("科目＆No.")` one column from its own fix
`lib/receipts/pack-preflight.ts:623`

```ts
const headerIdx = reconHeaderIndex(rows);          // L620  .includes("科目＆No.") — substring
if (headerIdx === -1) continue;
const header = rows[headerIdx]!;
const kamokuIdx = header.indexOf("科目＆No.");      // L623  EXACT match → -1 on any cell variance
const col = amountColumnIndex(header);             // L624  the FIXED sibling, fails loudly
...
for (const row of reconChargeRows(rows)) {
  const label = row[kamokuIdx] ?? "";              // L638  row[-1] → undefined → ""
  const m = label.match(/^(.*?)[A-Z][a-z]{2}\d{4}/);
  const cat = m ? m[1]! : label;
  if (!cat) continue;                              // L643  every charge row silently dropped
```

**Why it bites:** `reconHeaderIndex` finds the header by *substring*
(`includes`), so a header cell like `" 科目＆No."` or `"科目＆No"` is accepted —
but the very next line's exact `indexOf` then returns `-1`, every charge row's
label reads `""`, `if (!cat) continue` drops them all, and `reconByCat` is empty
for that CSV. The `summary-category-reconciles` check then either reports false
mismatches (`交通費: 集計 3件/32000 vs CSV 0件/0`) or — if every recon CSV loses
the header — **passes vacuously having summed zero rows**. A confident
"pack reconciles" built on nothing.

**The structural lesson (why this is high-signal even though latent today):**
this line sits ~40 lines from `amountColumnIndex`, the canonical fix, in the same
function. The amount column got the semantic treatment; the category-label column
one lookup to the left kept the fragile positional `indexOf`. This is the
AGENTS.md #12 "fix-applied-path-by-path" shape recurring *inside the same
function* as the fix. Currently latent (the system writes the exact header
today), but it is exactly the assumption that broke the amount column.

**Fix shape (for the architect):** mirror `amountColumnIndex` — a semantic
`kamokuColumnIndex(header)` that returns `{ok:false}` on a miss and fails the
check naming the CSV + actual header, instead of `?? ""` + `continue`.

### A-M2 — MEDIUM (verified) — regex-suffix miss falls back to the whole label, then drops
`lib/receipts/pack-preflight.ts:641-643`

Downstream of A-M1 but an independent miss path. A no-receipt line whose
`科目＆No.` cell is a bare category (no `MonYYYY` suffix —
`reconciliation-files.ts:128` writes bare categories for no-receipt lines) makes
the `/^(.*?)[A-Z][a-z]{2}\d{4}/` match return `null`; `cat` falls back to the
*entire* label, which never matches a 集計 entry → same false-mismatch output.
The sibling `parseEvidenceCategorySeq` (L142-150) handles this identical regex
correctly (`tokenMatch` null → return null → caller `if (!parsed) continue`);
this path does not.

### A-L1 — LOW — `parseInt(row[1] ?? "0", 10)` masks a missing 集計 cell
`lib/receipts/pack-preflight.ts:307-308` and `605-606` (duplicated verbatim — the
same consolidation debt AGENTS.md #6 flags). A short 集計 row silently reads
`0件 / ¥0`, false-mismatching against the recon total. Preflight verification
layer only; sealed bytes untouched.

### A-L2 — LOW — `split("-").map(Number) as [number, number]` with no length check
`app/api/receipts/alerts/dismiss/route.ts:23`. `alertKey` is validated non-empty
but not as `YYYY-MM`; a future alert key format → `month` is `undefined` → `NaN`
→ `expiresAt` persists as `"Invalid D"` (first 10 chars of an Invalid Date ISO).
Alert-snooze expiry only; the `as [number,number]` cast actively suppresses the
type check.

### A-L3 / A-L4 — LOW
- `lib/receipts/reconciliation-files.ts:297` — `assignment?.label ?? row.expenseCategoryJa ?? ""` can ship a blank 科目＆No. cell (mitigated: export route throws if a proof-bearing receipt lacks an assignment).
- `lib/receipts/reconciliation-signoff.ts:52` — `receiptMap.get(matched_receipt_id)` unchecked; a delete-after-list race leaves a half-blank manifest row (internal audit trail; the finalize gate would surface a missing receipt separately).

---

## Class (b) — writes that don't verify they wrote  (the operator-message shape)

A D1 write (INSERT/UPDATE/DELETE) whose caller does **not** inspect
`result.meta.changes` and act on a zero-row result. The canonical bar (NOT a
finding): `updateExportOperatorMessage` (`db.ts:3137`, asserts one row via
`assertExactlyOneRowWritten`), `finalizeExport` (`db.ts:3199`, checks
`changes===0` → throws), `finalizeReconciliation` (`db.ts:3704`),
`assignMembershipForReceipt` (`membership.ts:196`), `completePairing`
(`mobile-pairing.ts:142`), `duplicate-merge.ts:535`.

### B-F1 — HIGH (agent-reported) — device revoke returns `{ ok: true }` on a zero-row UPDATE
`lib/receipts/trusted-devices.ts:414` (`revokeMobileDevice`) and `:427`
(`revokeMobileDeviceById`). WHERE includes `revoked_at IS NULL`; both callers
(`app/api/receipts/devices/[id]/revoke/route.ts`, `app/api/mobile/auth/revoke/route.ts`)
`await` then unconditionally return `{ ok: true }`. If the WHERE matches zero
rows (already revoked, stale id, historical browser-platform row, concurrent
revoke), the operator sees "revoked" but a still-live token continues to
authorize mobile receipt creation until it expires. Security-relevant silent
no-op. **Fix shape:** assert one row written (or surface 409) like
`updateExportOperatorMessage`.

### B-F2 — HIGH (verified) — the extraction-failed badge write can no-op silently
`app/api/receipts/[id]/extraction-failed/route.ts:147`

```ts
// L138-140 comment: "If a parallel request already advanced this receipt,
//                     the UPDATE is a no-op and we surface that to the caller as 409."
await reconcileExtractionState(id, "failed");          // L141  idempotent — no-ops silently
await db.prepare(
  `UPDATE receipt_records SET extraction_json = ?, updated_at = ?
    WHERE id = ? AND extraction_state = 'failed'`,     // L152  no-ops if state isn't 'failed'
).bind(...).run();                                      //       — no changes check
...
return NextResponse.json({ ok: true, extractionState: "failed", ... });  // L168 NOT 409
```

**Why it bites:** the route's own comment promises a 409 on the parallel-advance
no-op, but `reconcileExtractionState` is silently idempotent (no throw), so when
a parallel `/extract` or review PATCH advanced the receipt, the state never
becomes `'failed'`, the `extraction_json` UPDATE matches zero rows, and the
`{ failed: true, reason, model }` payload the review UI's red pill reads is
**never persisted** — yet the route returns `ok:true`. This is exactly the
"stuck receipt with no signal" symptom backlog #9's DLQ work was meant to kill:
the consumer ACKs the poison pill, but the failure badge never renders. The
comment's promised visibility is not delivered.

**Fix shape:** assert exactly one row on the `extraction_json` UPDATE (or have
`reconcileExtractionState` surface the no-op so the route can 409, as its
comment already claims).

### B-F3 — MEDIUM (verified) — `recordExportBundle` does not verify the `WHERE status='draft'` guard
`lib/receipts/db.ts:3070` (`UPDATE receipt_exports SET ... operator_message=? WHERE id=? AND status='draft'`).
On the **rebuild** path (`finalize:false`) there is no `meta.changes` check; if
the draft was sealed/superseded between the route's status check and this write,
0 rows update, yet R2 objects (archive/manifest/proofs) were already written, an
`export.generated` audit claims a rebuild, and the staged bundle columns keep
pointing at the old build — a later finalize could seal stale content. The
finalize path is self-protecting (its own UPDATE at `db.ts:3187` is verified);
the rebuild path is not. **This is the same shape as the canonical
`updateExportOperatorMessage` incident** — `WHERE status='draft'`, operator
content, no rows-affected check.

### B-F4 — MEDIUM (agent-reported) — `updateAmexLineCategory` unverified
`lib/receipts/db.ts:1921` (`UPDATE amex_statement_lines SET ... WHERE id=?`). A
stale line id (statement re-imported; `markPreviousArtifactsReplaced` + upsert
can change line identity for rows without `amex_reference`) → the operator's
category decision silently doesn't persist, the audit says it did, the next
reconcile/export shows the old/null category — and category is what the finalize
gate and the accountant CSV read.

### B-F5 — MEDIUM (agent-reported) — duplicate-purge status-log UPDATEs unverified
`lib/receipts/duplicate-purge.ts:779, 794, 847, 861, 867`. A zero-row match
leaves `duplicate_purge_log.status` stuck at `d1_pending` while R2 objects were
already deleted (the R2 delete runs first) — storage/log drift invisible, the
same shape as backlog #5.

### B-F6 — MEDIUM (agent-reported) — `unfinalizeReconciliation` writes an "amended" audit without verifying
`lib/receipts/db.ts:3744` (`UPDATE ... WHERE id=?`, no status guard, no
`meta.changes` check) then writes `amex.reconciliation_amended` claiming
`{ unfinalized: true }`. A concurrent delete between the SELECT guard (L3735) and
the UPDATE → 0 rows, yet the audit claims the month was reopened. Low probability
but the audit forgery is the defect. Contrast `finalizeReconciliation` (L3704),
which verifies.

### B-F7 — MEDIUM/LOW (agent-reported) — `updateReceiptRecord` PATCH UPDATE unverified
`lib/receipts/db.ts:404` — the hot-path writer for every operator edit
(including the discretionary `export_statement_month` override). Preceded by a
fetch+404, so a genuine zero-row match is a narrow delete race, but it writes
sealed-state-adjacent columns and the audit/success lie if it no-ops.

### B-F8 — LOW (agent-reported) — processor-key recovery routes UPDATE without verifying
`app/api/receipts/[id]/enqueue/route.ts:106`, `app/api/receipts/[id]/render/route.ts:125`. A no-op after the queue job was sent leaves the receipt at `extraction_state='captured'` (the #19/#20 "never-enqueued" surface) or `needs_render=1` (the #22 render-leg-invisible surface).

### B-F9 — LOW (agent-reported) — AMEX artifact status/replace UPDATEs unverified
`lib/receipts/db.ts:1844, 1857`. Import-path bookkeeping; the zero-row case for
`markPreviousArtifactsReplaced` is benign by design.

### Intentionally idempotent / fire-and-forget (NOT findings)
`reconcileExtractionState`, `verifyBearerDevice` last-seen throttle,
`completePairing` race-loser revoke, `checkPairingCode` bearer clear, bulk
upserts/deletes — zero-row results are the designed behavior.

---

## Class (c) — `??` where the empty string is meaningful  (the message-loss shape)

**Zero defects survived verification.** The codebase absorbed the
`resolveOperatorMessageForRebuild` lesson and applied it systemically. Every
operator-string field that crosses a request boundary is handled with
presence-aware logic, not a bare `??`:

- **Operator message** — all three write paths (rebuild, message PATCH, one-shot
  finalize) distinguish omitted / null / string.
- **Receipt PATCH free-text** (merchant, businessPurpose, counterpartyName,
  taxRate) — `normalizeOptionalText` (undefined / null / trimmed string) +
  `compactUndefinedReceiptUpdate` + per-field `!== undefined` DB guards.
- **Settings free-text** (signature, recipients, reply-to) — `!== undefined`
  gates; empty string is a deliberate clear.
- **AMEX line receiptMissingReason, business-trip fields, inbox reject reason,
  unfinalize reason, purge confirmation** — all presence-checked.

This is itself the finding: **class (c) is closed.** The one historical instance
was fixed and the fix pattern propagated to every operator-string field. The
`??` chains that remain are all over numeric/boolean/internal-computed values,
which are correctly out of scope.

---

## Cross-reference to AGENTS.md backlog #12 ("Error-surfacing hardening pass")

#12 was declared CLOSED, but its theme — "every failure path must surface or die
visibly" — is a standing policy, and two findings here are paths that **shipped
after #12 closed and did not inherit its discipline** (the documented
"fix-applied-path-by-path" recurrence #12 and #22 already warn about):

- **A-M1** — `kamokuIdx` ships in `pack-preflight.ts` beside its own fix
  (`amountColumnIndex`). The lesson was applied to the amount column, not the one
  next to it.
- **B-F2** — the `extraction-failed` route ships in the #9 poison-pill/DLQ work
  (which #12 closed). Its comment promises 409 visibility the code does not
  deliver — the failure badge that #9(a) was meant to surface can silently
  no-op.

Other cross-refs: **B-F3** is the literal recurrence of the
`updateExportOperatorMessage` incident (the canonical #12 A2 fix) on the rebuild
path. **B-F5** is the #5 receipt_files/storage-drift shape on the purge log.
**B-F8** touches the #19/#20/#22 pipeline-health surfaces (all NOT DISPATCHED).

## Recommended order if the architect picks these up
1. **B-F2** — directly defeats shipped #9 visibility; the route's own comment is
   already wrong about its behavior.
2. **A-M1** — the same bug as the canonical incident, one column from its fix;
   latent today, exactly the assumption that broke last time.
3. **B-F1** — security-relevant silent revoke no-op.
4. **B-F3** — operator content on the rebuild path; same shape as the fixed
   canonical incident.

## Verified vs agent-reported
Personally re-read and confirmed: A-M1, A-M2, B-F2, B-F3 (and the canonical bars).
Agent-reported with precise file:line, not separately re-verified: B-F1, B-F4,
B-F5, B-F6, B-F7, B-F8, B-F9, A-L1–A-L4. The architect should spot-check any
finding before acting.

---

# Appendix (added 2026-08-12, architect follow-up §5) — deep-dive on the top two

## A-M1 deep-dive — latent by construction; cannot misfire on a real header today

The wrong output described in A-M1 (`kamokuIdx = -1` → every charge row dropped →
`reconByCat` empty → the `summary-category-reconciles` check reports false
`0件/0` mismatches or passes vacuously) is **not reachable on any header the
system actually generates.** The 照合CSV builders emit the column header as the
exact literal `"科目＆No."` (reconciliation-files.ts:119 and :264 — full-width
`＆`, trailing `.`), which is byte-identical to the `header.indexOf("科目＆No.")`
operand. The preflight reads these CSVs back out of the sealed ZIP (system-built,
not passthrough bank data), so the cell the `indexOf` scans is always the cell the
builder wrote. `reconHeaderIndex` (`.includes`, substring) and `kamokuIdx`
(`indexOf`, exact) therefore agree on every real header.

**Break condition:** the bug fires the day the header literal drifts between the
builder and the `indexOf` — a rename to `科目＆No` (no period), `科目＆№`, a
localized variant, or a BOM/whitespace prefix. That is exactly the assumption
that broke the amount column (`金額` → `利用金額`) one lookup over, which is why
this is still worth fixing despite being latent.

**Sharpened recommendation:** mirror `amountColumnIndex` — a semantic
`kamokuColumnIndex(header)` returning `{ok:false}` on a miss + failing the check
naming the CSV and its actual header, instead of `?? ""` + `continue`.
**Urgency LOW** (defensive — closes the recurrence the amount-column fix left
standing, not an active misfire). Downgraded from the original A-M1 framing,
which read as if it could fire today.

## B-F2 deep-dive — the operator badge is CORRECT in all races; the real defect is the comment + the response field

Traced `reconcileExtractionState` (extraction-queue-db.ts:92) + the route end to
end. `reconcileExtractionState` flips `WHERE id=? AND extraction_state IN
(captured, queued, processing)` → `failed`; the badge UPDATE is `WHERE id=? AND
extraction_state='failed'`. Per receipt state on entry:

| Entry state | reconcile flip | badge UPDATE | operator sees |
|---|---|---|---|
| captured/queued/processing (normal poison pill) | → failed | matches, writes badge | red failure pill ✓ |
| already `processed` (parallel `/extract` won) | no-op | no-op (state is `processed`) | normal receipt ✓ (it isn't failed) |
| already `failed` (duplicate POST) | no-op | matches, overwrites badge | red failure pill ✓ |

**The review-page badge never lies** — in every race the badge write's
`WHERE state='failed'` is consistent with `reconcileExtractionState`'s effect, so
the no-op cases are exactly the cases where the receipt isn't actually failed.
**The original B-F2 framing ("the red failure pill never renders … exactly the
stuck-receipt-no-signal symptom") is inaccurate and should be corrected** — that
symptom is not produced by this path.

**The real defects (lower severity than first reported):**
1. **The comment lies.** extraction-failed/route.ts:138-140 says *"If a parallel
   request already advanced this receipt, the UPDATE is a no-op and we surface
   that to the caller as 409."* The code surfaces no 409 for that case (the 409
   earlier in the route is the finalized-reconciliation lock, a different
   condition) — it returns `ok:true`. A maintainer trusting the comment believes
   a guard exists that doesn't.
2. **The 200 response misreports state.** It returns `{ ok:true,
   extractionState: "failed", failedAt }` UNCONDITIONALLY — including when a
   parallel `/extract` left the receipt `processed`. So the HTTP response tells
   the Mac consumer `extractionState:"failed"` for a receipt that is actually
   `processed`. The consumer logs/acts on a failure that didn't happen (to that
   final state). The badge (read from D1) is correct; the response field (read
   by the consumer) is the thing that lies.
3. The write is unverified (a 0-row badge UPDATE is not detected), but as traced
   that 0-row case is benign.

**Fix shape (when the architect picks it up):** have the route re-read the
receipt's `extraction_state` after `reconcileExtractionState` and return the
*actual* state in the response (and a 409 only if the receipt is sealed/locked);
correct or delete the misleading comment. LOW–MEDIUM severity (consumer-facing
misinformation, not an operator-facing wrong badge).
