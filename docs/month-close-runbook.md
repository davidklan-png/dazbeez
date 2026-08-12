# Month-close runbook — receipts export

The operator's procedure for sealing a monthly AMEX statement export, as it
actually works today. Accurate to shipped behavior. The single enforcement
authority is `validateMonthReadyForExport` (the finalize gate); the export
screen's blocker tile mirrors it via shared predicates.

## TL;DR — the click path

1. **Reconcile** — `/receipts/reconcile?month=YYYY-MM`: match AMEX statement lines to captured receipts, categorize every line, resolve missing-receipt reasons.
2. **Review orphans & cash** — `/receipts/review`: mark captured receipts reviewed; classify any `payment_path=UNKNOWN` receipts as AMEX/CASH/DIGITAL.
3. **Sign off reconciliation** — `/receipts/reconcile` → finalize reconciliation (seals the statement match).
4. **Pre-finalize review** — the pipeline's primary action takes you to `/receipts/export/YYYY-MM/review`: summary, side-by-side reconciliation, additional charges (cash/digital), business trips, and the gate verdict at the top. (Building a draft is an **optional preview** on the export page — "Build draft" / "Rebuild draft" — not a prerequisite; the one-shot finalize builds + seals in a single step.)
5. **Finalize** — bottom of the review page: type the month label, click Finalize. One-shot — it builds, gates, and seals the same bundle in one irreversible action.
6. **Send** — `/receipts/export/YYYY-MM/send`: review the composed email, click Send. This is what closes the month for reporting (sealing ≠ closing).

A shared month-close pipeline (Reconcile → Draft → Review → Finalize → Send →
Closed) and a single primary action render on the export page, the review page,
and the send page, so the map stays consistent as you advance. Finalize is
operator-only — no automated path calls `finalize=true`.

## The statement month vs transaction dates

An AMEX statement labeled `YYYY-MM` covers a **~6-week transaction window that
lags the label** — e.g. the 2026-06 statement contains lines dated Apr 10 – May 7.

- **AMEX lines** ship in their `statement_month` (a June-statement line dated in April is correct).
- **CASH/DIGITAL receipts** ship by **calendar-month membership** (ADR 0008): each receipt has a stored `export_statement_month` equal to the **calendar month** of its `transaction_date` (June 1–30 → `2026-06`). A cash receipt dated June 11 ships in the **June** export, alongside the June AMEX statement — whose own lines span the *prior* billing cycle. That cycle/calendar asymmetry is intentional and operator-confirmed.

The export bundle is still `buildExportBundle(month)`; it selects CASH/DIGITAL by `export_statement_month = month`. The **Additional charges** section header shows the month and receipt count (e.g. "June 2026 · 11 receipts"). UNKNOWN-path receipts are excluded and block finalize.

Membership is sticky: assigned once (at capture, when a date is first set) and never re-derived. (ADR 0006's window rule, AMEX-import sweep, drift detection, and "awaiting statement" bucket are retired by ADR 0008 — a dated receipt is always immediately assignable to its calendar month.) Undated cash/digital receipts are **unassignable** — see below.

## Blockers — what each means and where to fix it

The export screen's tile and the review page's gate verdict share the same
rule definitions. If the tile shows a blocker, the gate will enforce it.

| Blocker | Meaning | Deep link / fix |
|---|---|---|
| Uncategorized AMEX lines | A line has no category (and no matched receipt carrying one). | `/receipts/reconcile` — categorize the line. |
| Receipts with unknown payment path | A captured receipt is `payment_path=UNKNOWN` (excluded from the bundle). | `/receipts/review?payment_path=UNKNOWN` — classify AMEX/CASH/DIGITAL. |
| Unreviewed receipts | A receipt is `status=needs_review` (not pending extraction). | `/receipts/review?status=needs_review` — mark reviewed. |
| Receipts pending processing | Captured but extraction still queued (no field key yet). | Drain the Mac MLX consumer queue — not a review action. |
| Entertainment/meeting lines need attendees | A confirmed entertainment/meeting line has no attendees recorded. | `/receipts/reconcile` — link a receipt with attendees. |
| Lines marked "missing receipt" without a reason | `receipt_status=missing_receipt` (or no-receipt-required) with no reason. | `/receipts/reconcile` — add a brief reason. |
| No finalized reconciliation | Reconciliation not signed off for the month. | `/receipts/reconcile` → finalize reconciliation first. |
| CASH/DIGITAL receipt missing field | A non-AMEX receipt in the bundle is missing date/merchant/amount/category. | `/receipts/review/<id>` — complete the fields. |
| Compliance blocker / warning | Open compliance-engine checks on the month's receipts. | Resolve in the compliance UI; warnings only block if `export_block_on_warnings=true`. |
| Cross-month match | A receipt is matched to AMEX lines in two different statement months. | Disambiguate the match in reconcile so the receipt belongs to one statement. |
| Business-trip candidate | A line is flagged as a trip candidate, unresolved. | `/receipts/reconcile` — confirm or dismiss the trip cluster. |
| Possible duplicate cash/digital receipts (warning) | 2+ CASH/DIGITAL receipts share merchant + amount + transaction_date. | `/receipts/review/<id>` — confirm distinct (non-blocking, no auto-dedup). |
| Possible IC-card top-ups (warning) | A CASH/DIGITAL travel-transportation receipt for a round ¥1k/2k/3k/5k/10k sum at a top-up venue (convenience store / station). | `/receipts/review/<id>` — confirm business usage (non-blocking; see IC cards below). |

## Rebuild vs finalize

- **Rebuild draft** (export screen) is an OPTIONAL PREVIEW, not a prerequisite
  for finalize. It is safe to repeat: regenerates the CSV + manifest + summary +
  README + **proofs ZIP** in R2, replaces `receipt_export_items`, advances "Last
  draft built" (`bundle_built_at`), and writes an `export.generated` audit entry.
  It does NOT change receipts/lines, so it cannot change blocker counts. Use it
  to preview the pack before sealing; the one-shot finalize does its own build.

Once finalized, the five artifacts download from the export page (no wrangler
needed): Receipts CSV, Manifest, Summary, README, and 領収書ZIP (proofs) — via
`GET /api/receipts/export/<month>/download?file=<name>`.
- **Finalize** (review page) is one-shot and irreversible: it builds, stages,
  gates, and seals the SAME bundle in a single request (`POST
  /api/receipts/export/month` with `finalize:true`), sets the export to
  `finalized`, locks the receipts to read-only, marks the AMEX statement
  reconciled, stamps `exported_month` on shipped receipts, and writes
  `export.finalized` + per-receipt `receipt.exported` audit entries. The old
  seal-only finalize (`POST /api/receipts/export/[month]`) is retired — it
  returns 410 and seals nothing; only `?correction=true` on that route still
  works (to create a revision).

The "finalize 400s — rebuild first" trap is gone: the one-shot path always
builds fresh, so there is no separate Rebuild step to forget.

## Membership states & override (ADR 0008)

**Unassignable** — cash/digital receipts with no `transaction_date`. These can never be assigned to a calendar month and are invisible to every membership query. Needs-attention on the export page; deep-link to the receipt and set a date. (This is the only NULL state left — ADR 0006's separate "awaiting statement" bucket is retired: under the calendar rule every dated receipt is immediately assignable.)

**Late-receipt roll-forward** — a receipt whose calendar month's export already shipped (and has no open draft revision) is rolled forward to the next **open** month when its date is set (audited `receipt.export_statement_month_rolled_forward`). "Open" = the export is not finalized (two-lock model: the **export** seal, not the reconciliation seal).

**Discretionary override** — on a receipt's edit view (CASH/DIGITAL only), the "Statement month" control reassigns `export_statement_month` to a different **open** month. Blocked for sealed months (the export already shipped — use the revision flow). A confirm dialog states the consequence; audited as `receipt.export_statement_month_overridden`.

## IC cards (Suica / PASMO / ICOCA top-ups)

The export screen and review page raise a non-blocking **"Possible IC-card
top-ups"** warning when a CASH/DIGITAL receipt categorized as
`travel_transportation` is a round sum (¥1,000 / ¥2,000 / ¥3,000 / ¥5,000 /
¥10,000) charged at a top-up venue (セブン-イレブン, ローソン, ファミリーマート,
NewDays, or a station). All three signals — round sum, venue, and travel
category — must match on the same receipt; that conjunction is what keeps the
false-positive rate low (a real ¥1,900 EMot rail fare, or a non-round ¥10,450
store charge, won't trip it).

An IC-card top-up is a **prepayment, not a travel expense at the moment of
charge**. Responsible practice — pick whichever fits the card's use:

- **Expense as you go** — keep the card's 利用履歴 (usage history) and claim the
  actual trip fares as `travel_transportation` as the balance is consumed. The
  top-up charge itself is then a cash movement, not a deductible travel cost.
- **Business-dedicated card** — if the card is used only for business travel,
  note that on the receipt (business_purpose); the top-up can be expensed
  directly.

The warning is **advisory and does not gate finalize**. Surface the 利用履歴 or
the business-only note, and let accounting decide — **final treatment is the
accountant's call**.

## Sealing 2026-06 (current state)

After ADR 0008, 2026-06's export is **32 AMEX lines + 11 June-dated cash/digital receipts** (the calendar rule puts a June-dated cash receipt in June, alongside the June statement). The June review page's Additional Charges section lists those 11, including a **4× セブン-イレブン 東中野末広橋店 ¥10,000 on 2026-06-11** cluster. That same cluster raises two advisory warnings (both non-blocking): the **duplicate** warning (confirm the four are distinct charges, not double-captured) and, because each is a round ¥10,000 travel_transportation charge at a convenience store, the **IC-card top-up** warning (confirm business usage per §IC cards). Reconciliation is sealed; gates pass otherwise. Click path: export screen → Rebuild draft → "Review & finalize" → confirm the 11 additional charges + acknowledge both warnings → type "june 2026" → Finalize.

## Starting 2026-07

2026-07 is the open month: 20 statement lines + 1 July-dated cash/digital receipt
(calendar rule). Run the reconcile → review → rebuild → review-page → finalize
flow above. Reconcile the 20 lines (categorize, match receipts, resolve
missing-receipt reasons) and sign off the reconciliation before finalizing.

## Notification email (finalize → accountant)

Finalizing a month sends the accountant a Japanese email (month label, revision,
row/receipt counts, per-category totals, the full transition notice, and the
download link) via the **Resend** REST API (`POST api.resend.com/emails`) — the
same transport as the contact form. **Email failure never fails finalize**: if
the send is rejected, finalize still returns 200, the failure surfaces as a
warning in the response, and an `export.notification_failed` audit entry is
written (`export.notification_sent` on success).

**Recipient resolution** (`resolveNotificationRecipient`): the
`notification_recipient` set in **Settings → Compliance** wins; if empty, the
`ACCOUNTANT_EMAIL` var is the fallback; if both are unset the send returns
`{ok:false}` and finalize records the failure. The compliance form shows the
resolved address and its source ("settings" vs "fallback") so you can see what
finalize will actually use.

### Ops prerequisites (one-time)

Resend rejects sends until the domain + key + recipient are configured:

1. **Verify `dazbeez.com` in Resend** (Resend dashboard → Domains → Add). Resend
   publishes the SPF/DKIM/DMARC DNS records on the zone; wait for the domain to
   reach **Verified** before sending.
2. **`RESEND_API_KEY`** set as a wrangler secret — `npx wrangler secret put
   RESEND_API_KEY`. This key is **shared with the contact form** (CRM email
   sender, `lib/crm-email-sender.ts`); one secret serves both paths.
3. **`NOTIFY_FROM_ADDRESS` var** (in `wrangler.jsonc`) = a sender on the verified
   domain (`receipts@dazbeez.com`) — the `from` address. Unverified senders are
   rejected by Resend.
4. **`ACCOUNTANT_EMAIL` var** (in `wrangler.jsonc`) = the fallback recipient
   when nothing is set in Settings. For the first rollout it's the business
   manager (`admin@dazbeez.com`); swap in the accountant's address later.
5. **Set the recipient** in **Settings → Compliance → 通知先**, or leave it blank
   to use the `ACCOUNTANT_EMAIL` fallback.
6. **テスト送信** to confirm the channel end-to-end: Settings → Compliance →
   テスト送信, or `POST /api/receipts/notify/test[?month=YYYY-MM]`. It composes
   + sends a 【テスト送信】-prefixed email to the effective recipient without
   finalizing — it picks the latest finalized month automatically, or targets a
   specific one via `?month=`. Requires Clerk auth.

If the key / from / recipient are unset, every finalize records
`export.notification_failed` with the rejection reason. The bundle still seals;
resend manually after fixing the config (there is no auto-retry — re-finalize is
impossible without a revision, so treat the warning as "the email didn't go out,
send it by hand").

## Proofs bundle (証憑ZIP)

The 5th sealed artifact — `exports/<month>/<exportId>-proofs.zip` — bundles one
proof per shipped receipt so the accountant receives every証憑 from the sealed
bundle alone (no more hand-assembly or wrangler).

- **`No` join column**: the receipts CSV's first column is a 1-based row number.
  Each proof file is named `No<NN>_<勘定科目>_<店舗>_¥<金額>.<ext>` (e.g.
  `No03_研究開発費_OpenAI_¥108,341.pdf`) — the accountant matches a statement
  line to its proof via `No`. Multi-file receipts get `-2`, `-3` suffixes.
- **Folders** (Japanese): `領収書等証憓_<month>/AMEX明細分/` (receipts matched to
  AMEX lines) and `…/追加経費_現金デジタル分/` (CASH/DIGITAL receipts). Plus
  `目次.csv` (full index: No, ファイル名, 取引日, 店舗, 金額, 勘定科目,
  statement_line_id, receipt_id, original_sha256, 出典) and `お知らせ.txt`
  (transition notice: what changed vs the manual delivery).
- **Source (`出典`)**: the ZIP prefers the `proof_copy` derivative (recompressed,
  ≤1600px JPEG q75 — generated at ingest by the Mac consumer) and falls back to
  the original if absent. `出典=原本` marks a fallback. PDFs pass through
  unchanged. Every file's SHA-256 is in the manifest.

### Gate (no proof → no seal)

`validateMonthReadyForExport` gate 7 blocks finalize when a shipped receipt has
**no `receipt_files` row at all** (no original, no proof_copy) — it cannot appear
in the ZIP. (A missing `proof_copy` alone is not a blocker; the fallback covers
it.) At rebuild, if a file row exists but its R2 object is gone, the rebuild
**fails loudly** with the receipt id — re-run the proof backfill (below) or
re-ingest before sealing.

## June 2026 revision-2 (format transition)

June 2026 sealed at revision 1 **without** the proofs ZIP / `No` column /
notice. To deliver the full accountant bundle for June, create a **revision-2
draft** that supersedes revision 1, rebuild it with the new format, then
finalize. Revision 1 stays byte-identical (sealed-data preservation — verified
by `tests/receipts/export-revision-flow.test.ts`).

**Do not run this against production from code.** Operator steps:

1. Ensure every June receipt has a `proof_copy` (see §Backfilling proof copies),
   so the ZIP isn't all-fallback.
2. Create the revision-2 draft (supersedes revision 1):
   ```bash
   # On the Mac, with the operator's auth (Clerk session cookie):
   curl -X POST 'https://dazbeez.com/api/receipts/export/2026-06?correction=true' \
     -H 'Content-Type: application/json' \
     -H 'Cookie: <clerk session>' \
     -d '{"correctionReason":"様式移行: 証憑ZIP・No列・お知らせ追加 (format transition: proofs bundle added)"}'
   # → 201 { ok, exportId, revision: 2, supersedesExportId, month }
   ```
3. Export screen (`/receipts/export?month=2026-06`) → **Rebuild draft** (builds
   the receipts CSV with the `No` column + the proofs ZIP + the notice into the
   revision-2 draft).
4. **Review & finalize** (`/receipts/export/2026-06/review`) → confirm the
   bundle, type "june 2026", Finalize. This also sends the notification email
   (§Notification email) carrying revision-2 context.

Finalize is operator-only — no automated path calls it.

## Backfilling proof copies (production)

Receipts captured before the PR 1 ingest path shipped have no `proof_copy`. The
Mac-side `backfill_proof_copies.py` generates + posts them. **Operator-only,
read-only dry-run first**:

```bash
cd scripts/receipts-consumer
# REQUIRED first: the backfill fails fast (exit 2) unless the consumer .env is
# sourced — it posts via RECEIPTS_EXTRACT_URL / RECEIPTS_PROCESSOR_KEY.
set -a; source .env; set +a
# 1. Dry-run against LIVE D1 (read-only SELECT — no writes):
.venv/bin/python3 backfill_proof_copies.py --remote --dry-run
#   → prints id / merchant / original_r2_key for receipts lacking a proof_copy.

# 2. Apply (writes: fetch original → recompress → POST /api/receipts/<id>/proof):
.venv/bin/python3 backfill_proof_copies.py --remote --write

# Re-generate existing ones (e.g. after a quality change): add --force.
# Narrow to one receipt: --id <uuid>.
```

**Derivative parameters** (`scripts/receipts-consumer/consumer.py`):
`PROOF_MAX_DIM = 1280` (longest side, never upscaled) and
`PROOF_JPEG_QUALITY = 70`; PDFs pass through unchanged. Tuning either only
affects proofs generated AFTER the change — existing `proof_copy` rows keep
their old bytes until you regenerate with `--force` (overwrites all via the
upsert).

Idempotent + resumable: by default it selects only receipts WITHOUT a
`proof_copy`, so re-running after a partial `--write` picks up the rest. For a
seeded local demo (no production access), use `--local` against `cf:dev` (see
`scripts/receipts-consumer/fixtures/seed-local.sql`).

## Deleting a sealed export (test-seal cleanup)

Sealing locks edits. Deletion is the one hole in that guarantee, and the only
sanctioned way through it is `scripts/delete-sealed-export.ts`. The refusal
logic lives in the pure, unit-tested `lib/receipts/export-deletion.ts`; the
script is the thin I/O wrapper (D1 + R2 via wrangler) and is **dry-run by
default**. Until this script existed, sealed-export deletion had no code-review
surface — 2026-06 revs 1 & 2 were removed out-of-band on 2026-07-22 and recorded
with non-union audit actions. That path is closed: use this script.

```
npx tsx scripts/delete-sealed-export.ts \
  --export-id <uuid> --month <YYYY-MM> --reason "<legal-hold exception>"
# dry-run prints the R2 objects + D1 deletes it WOULD do.
# add  --write --confirm-delete <same-id>  to actually delete.
```

**Legitimate uses** — rare, operator-authorized:
- Removing a **test seal** created against production before close (the
  2026-07-22 case: smoke-test drafts sealed to verify a flow, then cleaned up).
- Removing a **superseded never-delivered draft/revision** when a newer revision
  is the one that shipped and the old one would confuse history.

**Never legitimate (the script refuses outright):**
- Anything **delivered** — if the export has any `export_deliveries` row in
  state `sent`, the script refuses. A delivered month's seal is not deletable by
  this tool at all; that is a different conversation with a different
  authorization.
- Without an explicit **legal-hold exception** string (`--reason`). `legal_hold`
  defaults to 1, so deleting a sealed export is always a retention exception —
  the operator must state why, in their own words; it is recorded verbatim in the
  `export.deleted` audit entry.
- Without naming the exact **export id AND month** — no wildcards, no "all
  drafts."

`receipt_export_items` cascade with the parent (0017 FK); `export_deliveries`
rows are deleted explicitly (no FK). The script asserts exactly one
`receipt_exports` row changed before writing the audit, so a partial delete
cannot go unrecorded. The R2 objects removed (3 sealed keys stored on the row +
7 derived) are listed in the dry-run and recorded in the audit's
`removedR2Objects`.

**Deliveries:** the tool refuses if any delivery row is in a state where the pack
**may have reached the accountant** — `sent` (delivered), `pending` (in flight),
or `ambiguous` (false-negative — may have been accepted). This is the same
doctrine that requires explicit confirmation before *sending* a second pack
(#171), and it applies more forcefully to *deleting*: if the pack may have
landed, deleting destroys the only record of what the accountant was sent. Only
a definitively `failed` delivery (never accepted ⇒ nothing delivered) permits
deletion. The refusal message distinguishes `sent` ("already delivered") from
`pending`/`ambiguous` ("may have been delivered") so you are never told a pack
was delivered when the evidence is uncertain. This is decided, not a judgment
call for each deletion.


