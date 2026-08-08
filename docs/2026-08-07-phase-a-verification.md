# Phase A — independent architect verification

Verified against commit `5e06f5d` by reading the diff and running the suite in a
sandbox, **not** from the worker's report. Protocol: `2026-06-pack-approved-delta.md` §17.

**Verdict: accept the implementation, with 3 gaps to close and 2 decisions needed.**
Nothing found that would corrupt a delivered pack today. The quality is high — the
preflight suite in particular is better than specified.

---

## Confirmed good (checked, not taken on trust)

| Claim | How verified |
|---|---|
| Evidence filenames unchanged | `git diff` on `reconciliation-files.ts` shows **zero** touched lines matching `buildEvidenceAssignments` / `statementMonthToken` / `circledNumber` / label / filename construction |
| June strings guarded | `会議費Jun2026③小田原みなと食堂￥6,490.jpg` asserted literally in `proofs.test.ts:250,288,338` and throughout `pack-preflight.test.ts` |
| Old literals gone | repo-wide grep: `AMEX明細分`, `現金分`, `デジタル分`, `お知らせ.txt`, `buildTransitionNotice`, `icAdvisories` → **0 hits** in `lib/`, `app/`, `components/` |
| `会議-出席者ID` removed | remaining hits are comments plus the preflight check that *forbids* it |
| Notice correct | `buildPackNotice` interpolates from `names`; no attendee / manifest / IC / 改訂情報 block; `operatorMessage` omitted when empty; O5 structure present |
| Preflight is real | 17 checks; **every** broken fixture asserts `passed === false` **and** that the whole report fails; plus a "keys unique and cover the spec" test |
| Tests pass | ran `npx tsx --test` on the three new/changed suites in a Linux sandbox — 48/48 pass |
| Single naming authority | `pack-naming.ts` consumed by `assembleProofsZip`, `buildPackNotice` and the proofs download path |

The §7 desync guard is implemented as a real test (`proofs.test.ts:47`) comparing
notice-mentioned filenames against actual ZIP entries. That was the point of the
exercise and it landed.

---

## Gap 1 — Change 5 was not performed and not reported

The prompt required a legacy sweep with a per-symbol table and full grep output.
Neither appears in the report. Verified directly instead:

**`buildProofFilename`, `ProofFilenameParts`, and the entire `else` branch
(`proofs.ts:309-331`) survive, and `ProofZipEntry.filename` is still optional
(`proofs.ts:253`).**

### Reachability — traced, not assumed

```
proofsEntries  ← every bundle.rows row with a receiptId + chosen file
evidenceUnits  ← amex_line rows ∪ receipt rows WHERE paymentPath ∈ {CASH, DIGITAL}
```

The sets coincide **only because** `listReceiptsByExportStatementMonth`
(`membership.ts:83`) defaults its `paymentPaths` parameter to `["CASH","DIGITAL"]`,
and `month-closing.ts:115` calls it without a second argument. UNKNOWN is separately
excluded and gated at finalize (gate 2). So **the branch is unreachable today** — the
worker's implicit assumption holds.

But it is unreachable by coincidence of a default parameter three files away, and
**ADR 0013 explicitly plans a third `ExportRow.rowType` of `"bank_line"`.** Bank-debit
rows would land in `bundle.rows` and therefore in `proofsEntries`, but they are not
`amex_line` and not CASH/DIGITAL receipt rows, so they would be **absent from
`evidenceUnits`** → `assignment` undefined → the legacy branch fires → `No07_…`
filenames appear in a delivered pack alongside 科目＆No names, in the AMEX folder.

That is precisely the second-naming-authority defect §7 documents, re-armed for a
change already on the roadmap.

**Action:** delete `buildProofFilename`, `ProofFilenameParts` and the `else` branch;
make `ProofZipEntry.filename` **required**. Then a future `bank_line` row fails to
compile instead of silently mis-naming a delivered file.

---

## Gap 2 — standalone download filenames not renamed

`export.ts:578,584,590` still emit `AMEX2026-06_Reconciliation.csv`,
`CASH…`, `DIGITAL…`. The worker flagged this as open question #3 and took the narrow
reading, though the prompt carried an explicit nine-row rename table.

Consequence: the file the operator downloads is named differently from the identical
bytes inside the ZIP. Same content, two names — a smaller instance of the drift this
whole task exists to remove.

The worker's stated obstacle is real: `resolveBundleDownload` would need
`paymentDueDate` threaded into a read-only path. That is a genuine cost, not an
excuse. **Decision needed — see D15.**

---

## Gap 3 — `readme.txt` question unanswered

The prompt asked what the separate `readme.txt` artifact contains and whether it now
duplicates ご連絡事項. Not addressed. Still open.

---

## Unverified assumption — `payment_due_date`

§17 assumption 1 remains **UNVERIFIED**. The report cites
`amex_statement_artifacts.payment_due_date` and "the fixture statement's お支払日",
but `cf:dev` never ran, so this is a fixture reading, not a live D1 observation. My
prompt named `amex_reconciliations` — the table discrepancy is itself unresolved.

Not alarming (both may exist; the value is almost certainly `2026-06-04`), but it must
be confirmed against live D1 before Phase B, since the pack now **throws** without it.

---

## New risk the worker surfaced — accept the finding, reject the scope

Honest and correct: because `buildPackNames` throws on a null payment date, **a month
with no AMEX statement can no longer be exported at all** — the throw fires before any
R2 write.

This is worse than the worker framed it. It doesn't only affect hypothetical cash-only
months: it blocks **draft** generation for any month whose AMEX statement has not been
imported yet. Drafts exist precisely so expenses can be reviewed before the statement
lands. As implemented, the review workflow is gated on the statement arriving.

**Fix:** require `payment_due_date` only when the pack actually contains AMEX
content. No AMEX rows → no AMEX folder, no AMEX CSV, no date needed. Keep the hard
throw when AMEX rows exist and the date is missing — that case must still fail loudly.

---

## Minor — DIGITAL CSV is never mentioned in the notice

`buildPackNotice` names only the AMEX and CASH CSVs
(「現金決済分は … に分けて同封しています」). In a month with digital rows, the DIGITAL
CSV ships unmentioned.

The §7 desync guard doesn't catch this: it verifies that every filename *mentioned*
exists, not that every file *shipped* is mentioned. Worth adding the inverse check for
index files (not evidence files, which are indexed by the CSVs).

---

## Accepted without change

- **Branched from `origin/master`** — my prompt said `origin/main`; the worker was
  right, this repo uses `master`.
- **`composeFinalizeNoticeData` is now async** and fetches `payment_due_date`. Adds a
  DB read to notice composition; the safety argument (an export can only exist if the
  bundle already built) holds. Note it now sits on the Phase B send path when the
  email summary is regenerated at send time (D14).
- **`entries` typed as an array, not a `Record`** — correct call. A `Record` collapses
  duplicate paths, making the duplicate-detection check untestable.
- **Stale git locks removed** — consistent with the known shared-mount issue.
- **Notice bullet trimmed** — matches the retire-transition-framing goal.

## My error, corrected

The delta doc §15 tree said `202606_新システムに関するご連絡.txt` while the prompt said
`202606_ご連絡事項.txt`. The worker followed the prompt, which is correct per O5. Doc
corrected at `5e06f5d`+ — the inconsistency was mine.

---

## Decisions needed

**D15 — rename the standalone reconciliation CSV downloads?** Yes would mean threading
`paymentDueDate` into `resolveBundleDownload`; no leaves operator-facing labels
permanently out of step with pack contents. *Recommend yes* — one naming authority was
the point, and a read-only path fetching one extra column is a small price.

**D16 — `readme.txt`: retain, retire, or fold into ご連絡事項?** Blocked on the
worker's answer about its contents.

---

# Closeout verification (2026-08-07, second pass)

Verified against the uncommitted working tree on `feature/pack-naming-attendees`.

## Confirmed fixed

- **Gap 1 closed.** `buildProofFilename` and `ProofFilenameParts` are gone from
  `proofs.ts`; `ProofZipEntry.filename` is now `filename: string` (required). The
  future `bank_line` trap is now a compile error.
- **Throw-scoping done.** `buildPackNames(month, paymentDueDate, hasAmex = true)` —
  default `true` is the correct safe default (a caller who forgets still gets the
  loud failure). Notice omits the AMEX 照合CSV mention on AMEX-less packs, which also
  avoids a phantom-file desync.
- **D15 done.** Standalone reconciliation downloads now derive from `buildPackNames`.
- **`payment_due_date` resolved from live D1** — it lives on
  `amex_statement_artifacts` (my prompt's `amex_reconciliations` was wrong);
  2026-06 = `2026-06-04`, full series consistent. §17 assumption 1 now VERIFIED.
- **`readme.txt` answered** — integrity/audit layer (export id, SHA-256 of every
  artifact, disclaimer) vs. ご連絡事項's human monthly notice. Complementary; retain
  both. Closes D16.

## The June diff — performed, contrary to the report

The worker reported this as impossible: *"external/ is multi-step mojibake, not an NFC
difference… no CJK codecs to brute-force the chain."*

The mangling **diagnosis was right** (`会議費` → `âÔãcîÔ`, reproduced exactly). The
**conclusion was wrong**: the chain is a lossless byte reinterpretation and reverses
with `s.encode('mac_roman').decode('cp932')`. Python 3 with cp932 is present on the
machine; only Node's `Buffer` lacks the codec. The method is documented at the top of
`2026-06-pack-approved-delta.md`.

**Correction to the report:** external/'s folder names are **not** `AMEX明細分`,
`現金分`, `お知らせ.txt`. Recovered and round-trip verified, they are
`AMEXカード利用領収書2026年6月4日支払い分/`, `現金払い領収書2026年6月分/`,
`新システムに関するご連絡.txt`. The names quoted in the report belong to the **stale
R2 draft**, not the approved pack — the two artifacts were conflated.

**Result of the diff** (units rebuilt from the approved pack's own CSVs in documented
order — AMEX statement order then CASH, multi-line receipts grouped by 科目＆No and
summed — then run through the live `buildEvidenceAssignments`):

```
approved pack files: 33   regenerated: 33
EXACT MATCHES: 33
*** IDENTICAL — every evidence filename reproduced ***
```

Including every case that could have broken: the shared-receipt totals
(HUB ￥7,049 from 2,864+4,185; ENEOS ￥22,770 and ￥3,545), cross-folder numbering
continuity (交際費 ①②③→④, 旅費交通費 ①–⑩→⑪–⑭), sanitised merchants
(`HUB 東京オペラシティ店` → `HUB東京オペラシティ店`), and full-width ￥ throughout.

**This is the acceptance test from §17, and it passes.** The evidence-naming contract
with the accountant is preserved.

## Outstanding — blocks Phase A closure

**B1 — `build:cf` fails.** `String.fromCodePoint(12365822)` inside Tailwind 4.2.2
under Node v25.8.1 (the value exceeds the 0x10FFFF ceiling, so it throws). The
worker's methodology is sound — a pristine `5e06f5d` worktree fails identically, so
it is environmental. But AGENTS.md requires `build:cf` to pass before shipping, so
Phase A cannot close.

The real defect is that **the repo pins no Node version**. Fix by adding `engines`
+ `.nvmrc` on Node 22 LTS, so this cannot recur silently on another machine.

**B2 — stray file. RESOLVED** — `verify-tmp.ts` deleted and confirmed gone.

**B3 — notice/CSV desync, both directions. RESOLVED and verified.**
`buildPackNotice` now emits one conditional bullet per present 照合CSV;
`derivePackNoticeInput` derives `hasAmex` / `hasCash` / `hasDigital` from the bundle
rows using **the same predicates that gate CSV emission** in the export route
(`amex_line` / `receipt`+CASH / `receipt`+DIGITAL), so the notice names exactly what
ships. A new preflight check `notice-mentions-shipped-reconciliation-csvs` (18 total)
backstops the inverse direction.

The layering is right: derivation is best-effort, preflight is the authority, and the
two failure directions are now covered by separate checks — a mentioned-but-absent
file fails the original guard, a shipped-but-unmentioned file fails the new one.
Re-ran the five affected suites independently: **77/77 pass.**

## New finding — 2026-06 is an open draft, not a sealed export

Live D1 shows 2026-06 as **draft rev 3**, and the staged R2 draft predates this work:
old naming, 参加者一覧.csv still embedded, **half-width ¥ (U+00A5)** — i.e. it carries
the exact byte that caused the original 破損. My earlier "sealed and approved"
framing was wrong; the approval attaches to the hand-built `external/` pack, which
the system has never produced.

Two consequences:

1. **That draft is a live trap.** If it is ever downloaded and sent, it reproduces the
   original failure. It should be rebuilt or blocked from being served.
2. **Decision D17 — does June get re-exported at all?** Re-exporting produces a pack
   whose filenames differ from the one the accountant has already approved and filed.
   Weigh that against the pending June work (Part 4 edits, the ¥60 delete /
   export-lock trap). *Options:* (a) leave June as the historical manual delivery,
   neutralise the stale draft, make July the first system-delivered month; or
   (b) rebuild and re-deliver June under the new scheme, accepting that the accountant
   files two differently-named copies of the same month.

**D17 — DECIDED 2026-08-07: June will be re-exported.** Additional cash receipts
surfaced; they will be added to the month and the draft recreated. This resolves the
stale-draft trap (it gets rebuilt) but introduces three consequences.

### C1 — 科目＆No numbering will SHIFT, not just extend

This is the non-obvious one. Cash rows are ordered `ORDER BY transaction_date ASC`
(`membership.ts:95`), and `buildEvidenceAssignments` numbers per-科目 in that order
*after* the AMEX block. A new cash receipt dated mid-month therefore **inserts into
the sequence and renumbers everything after it in its category**.

June's current cash tail:

```
06-02 セブン-イレブン東中野末広橋店   旅費交通費⑪
06-11 セブン-イレブン東中野末広橋店   旅費交通費⑫
06-22 セブン-イレブン渋谷本町3丁目店  旅費交通費⑬
06-27 セブン-イレブン東中野末広橋店   旅費交通費⑭
06-29 こぶちさわ                      交際費④
06-04 LAWSON100 / DAISO               消耗品費④⑤
```

Add one cash 旅費交通費 dated 2026-06-15 and 渋谷本町 moves ⑬→⑭, 06-27 moves ⑭→⑮.
The accountant has **already filed** `旅費交通費Jun2026⑬セブン-イレブン渋谷本町3丁目店￥10,000.jpg`.
Same receipt, new pack, different join key.

AMEX numbering is unaffected (AMEX is numbered first, by `raw_csv_line_number`, and no
AMEX rows change). Only categories gaining a cash receipt renumber, and only from the
insertion point.

**Handling: full replacement, never a merge.** The re-delivery must instruct him to
discard the earlier pack entirely. Reconciling two packs that disagree about which
receipt is ⑬ is far worse than a clean swap.

### C2 — the copy policy needs its exception, via the operator message

O2 bans system-generated 改訂情報 blocks; every delivery reads as a fresh first
delivery. That was written when re-delivery was hypothetical. It now collides with a
real case: a second June pack, different filenames, different numbering, for a month
already approved and filed.

The ban is on the *automatic* block, not on the business manager communicating. The
supersession note belongs in the **operator message** (D14 / O5) — "this replaces the
June pack sent on <date>; please discard the earlier one." Consistent with both
decisions, no policy change needed.

Note the operator-message plumbing is **Phase B**. For this June re-delivery the note
goes in the hand-written email, as it does today.

### C3 — totals change, which is an accounting event, not a file swap

New receipts move the 集計 figures. If June has already been booked, this is a
correction to a booked period. The re-delivery message should say the totals changed,
not merely that the files were renamed.

### Sequencing constraint

**Add the receipts now; do NOT recreate the draft until Phase A is merged.**
Regenerating against current `main` reproduces the stale-draft defects — old naming,
参加者一覧 embedded, half-width ¥ — i.e. the exact bytes behind the original 破損.

Also confirm the new receipts actually land in June: `export_statement_month` assigns
from `transaction_date` under the ADR 0008 calendar rule, so anything dated outside
June lands elsewhere and undated receipts fall to the unassigned-residue surface.
June is currently a draft, so it is **not** in `loadSealedExportMonths` and new
CASH/DIGITAL membership is permitted — verified at `membership.ts:44`.

## Before Phase A can be called done

1. Delete the legacy naming branch; make `filename` required (Gap 1)
2. Scope the payment-date throw to AMEX-bearing packs (new risk)
3. Live-verify `payment_due_date` for 2026-06 and the actual table name
4. Run `build:cf` and generate the 2026-06 draft; diff evidence filenames against the
   approved pack in `external/` after NFC normalisation on both sides
5. Answer the `readme.txt` question
