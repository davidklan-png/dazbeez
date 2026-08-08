ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Phase A — accountant pack: naming standardisation + attendee removal

Full rationale: `docs/2026-06-pack-approved-delta.md`. Read it before starting.
This prompt is Phase A only (pack contents). Phase B (automated delivery) is a
separate task — **do not build any send/email behaviour here.**

**Commit the architect-authored doc changes as your FIRST action**, before any
branch setup: `docs/2026-06-pack-approved-delta.md`, `prompts/WORKER-PROMPT-*.md`,
and `accountant-encoding-probe/`. Then branch with
`git checkout -b feature/pack-naming-attendees origin/main`.

---

## Background in one paragraph

The accountant approved a June 2026 pack that David had hand-modified. We diffed it
against packager output and David has since ruled on every delta. Two things changed:
the pack's file/folder naming is standardised on ASCII date prefixes, and the attendee
roster is removed from the delivery at the accountant's written request
(「接待、会議の出席者一覧表は貴社で保管されていれば問題ないので弊所に共有しなくても
大丈夫です」, 永野税理士事務所 大久保, 2026-08-07).

---

## Change 1 — ZIP naming

`lib/receipts/proofs.ts`

`ROOT_PREFIX` (line 278) becomes `{yyyymm}_Dazbeez_Monthly_Expense_Report/`, e.g.
`202606_Dazbeez_Monthly_Expense_Report/`.

Folder constants (lines 279–284):

| Current | New |
|---|---|
| `AMEX明細分/` | `{yyyymmdd}_AMEXカード利用領収書/` |
| `現金分/` | `{yyyymm}_現金払い領収書/` |
| `デジタル分/` | `{yyyymm}_デジタル払い領収書/` |

`{yyyymmdd}` is the **AMEX statement payment due date**, not the statement month —
`amex_reconciliations.payment_due_date` (parsed at `validation.ts:285`, column at
`0005_amex_extended.sql:25`). `{yyyymm}` is the statement month with the hyphen
stripped (`2026-06` → `202606`).

`folderFor()` currently takes only a payment path; it now needs the month and the
payment date. Thread them through rather than reaching for globals.

**`payment_due_date` is nullable.** If it is null or unparseable when building a pack,
**throw and block the export** with a clear message. Do NOT substitute a fallback date
— a pack named after the wrong date is worse than a pack that refuses to build.

Embedded index files (lines 369–380):

| Current | New |
|---|---|
| `AMEX{month}_Reconciliation.csv` | `{yyyymmdd}_AMEXカード利用明細.csv` |
| `CASH{month}_Reconciliation.csv` | `{yyyymm}_現金払いリスト.csv` |
| `DIGITAL{month}_Reconciliation.csv` | `{yyyymm}_デジタル払いリスト.csv` |
| `集計.csv` | `{yyyymm}_集計.csv` |
| `参加者一覧.csv` | **removed** (Change 2) |
| `お知らせ.txt` | `{yyyymm}_ご連絡事項.txt` |

`lib/receipts/export.ts` — `resolveBundleDownload` (lines 521–590): **all** standalone
download filenames adopt the same prefix scheme, not just the zip. These are
operator-facing, but D11 standardises filename dates everywhere.

| Current | New |
|---|---|
| `export-{month}-proofs.zip` | `{yyyymm}_Dazbeez_Monthly_Expense_Report.zip` |
| `export-{month}-receipts.csv` | `{yyyymm}_receipts.csv` |
| `export-{month}-manifest.csv` | `{yyyymm}_manifest.csv` |
| `export-{month}-summary.csv` | `{yyyymm}_集計.csv` |
| `export-{month}-attendees.csv` | `{yyyymm}_参加者一覧.csv` |
| `export-{month}-readme.txt` | `{yyyymm}_readme.txt` |
| `AMEX{month}_Reconciliation.csv` | `{yyyymmdd}_AMEXカード利用明細.csv` |
| `CASH{month}_Reconciliation.csv` | `{yyyymm}_現金払いリスト.csv` |
| `DIGITAL{month}_Reconciliation.csv` | `{yyyymm}_デジタル払いリスト.csv` |

Drafts keep the existing `DRAFT-` prefix
(`DRAFT-202606_Dazbeez_Monthly_Expense_Report.zip`).

**Question to report on, do not decide:** there is a separate `readme.txt` artifact
distinct from the in-ZIP notice. Report what it contains and whether it now duplicates
`{yyyymm}_ご連絡事項.txt`. Do not delete it in this task.

**Do not change** the R2 object key `{exportId}-proofs.zip`
(`app/api/receipts/export/month/route.ts:500`) — that is the sealed artifact identity
and must not carry human-facing naming.

### Evidence filenames are NOT changed

`buildEvidenceAssignments` (`reconciliation-files.ts:85`) keeps emitting
`会議費Jun2026③小田原みなと食堂￥6,490.jpg` exactly as today: no date prefix, Japanese
retained, full-width ￥, `Jun2026` token, per-科目 circled numbering. The 科目＆No label
is the accountant's join key and appears verbatim in the CSVs' 領収書ファイル名 column.
**If you find yourself prefixing an evidence file, stop — you have misread the scope.**

### ZIP entry-name encoding is NOT changed

Keep `fflate`'s UTF-8 names with the UTF-8 general-purpose bit set (`zipSync`,
line 382). A CP932 alternative was assessed and rejected. Do not add an encoding
dependency.

---

## Change 2 — remove the attendee roster from the delivery

Rule: **generate and retain, do not deliver.**

| File | Action |
|---|---|
| `proofs.ts:370` | remove `参加者一覧.csv` from the ZIP |
| `proofs.ts:303-312` | drop the `attendeesCsv` parameter from `assembleProofsZip` |
| `proofs.ts:125` | remove the attendee bullet from お知らせ (Change 3) |
| `reconciliation-files.ts:112-118` | remove `会議-出席者ID` from `AMEX_RECONCILIATION_APPEND_HEADERS`; **keep `人数`** |
| `reconciliation-files.ts:268-278` | remove `会議-出席者ID` from `PAYMENT_PATH_CSV_HEADERS`; **keep `人数`** |
| `reconciliation-files.ts:245` | `attendeeIdCells` → return count only |
| `reconciliation-files.ts:296,311` | stop emitting the ids cell; keep the count cell |
| `export.ts:299-310,501,548` | **KEEP UNCHANGED** — the standalone 参加者一覧 artifact is still generated, stored and listed in the operator bundle |

`人数` stays because the participant count feeds the per-head 交際費 test; the names
are what the firm does not need.

**DO NOT TOUCH**, and report back if you believe you need to:

- the finalize gate that blocks unresolved attendee names
- `lib/receipts/attendee-directory.ts` and `resolveAttendeeNames`
- `categoryRequiresAttendees` / the attendee-requirement gate
- the `receipt_attendees` schema

Retention now matters **more**, not less — 「貴社で保管されていれば」 makes the
accountant's waiver conditional on us continuing to hold these records, and we are now
the only copy. An export-layer change must not erode an internal control.

Note `csvQuoteAlways` was used on the ids cell to defeat Excel date-coercion of
`"2 3 4"`. With ids gone that specific guard is no longer needed there — but leave
`csvQuoteAlways` itself in place; other call sites may rely on it.

---

## Change 3 — お知らせ becomes ご連絡事項 (purpose change, not just a rename)

`buildTransitionNotice` (`proofs.ts:113-173`). This file stops being a one-time
transition notice and becomes a **standing monthly communications channel** between
Dazbeez business admin and the accountant. Rename the function accordingly
(`buildPackNotice` or similar) and restructure to:

```
【今月のご連絡】      ← operator free text — Phase B. In Phase A, accept an
                        optional `operatorMessage` parameter and OMIT the whole
                        section when it is empty. Do not build any UI for it.
【この資料について】  ← standing explanation of how to read the pack
【今月の内容】        ← counts (unchanged)
【領収書なしの明細】  ← unchanged
```

**Retire the transition framing.** Drop the heading
「【お知りいただきたい変更点（従来の手作業納品との違い）】」 and the bullet contrasting
against 別紙PDF. Both describe a migration that will shortly be ancient history. What
belongs under 【この資料について】 is the durable "how to read this pack" content:
the 照合表 explanation, the 科目＆No convention, per-file paper receipts, image
re-compression, and PDF originals.

Required edits to the surviving bullets:

1. **First bullet** — replace retired filenames and correct the column list (it says
   four columns; there are five, and 事業目的 was never added when PR #139 introduced
   it). New text:

   ```
   ・カード明細の照合表（20260604_AMEXカード利用明細.csv）は、カード会社の明細CSVを
     そのまま再現し、右側に「科目＆No.」「事業目的」「人数」「領収書ファイル名」の列を
     追記したものです。現金決済分は 202606_現金払いリスト.csv に分けて同封しています。
   ```

   The filenames must be **interpolated from the same values that name the ZIP
   entries**, never retyped as literals — see "Design requirement" below.

2. **Remove the attendee bullet entirely** (line 125) — do not reword it.

3. **Remove the SHA-256 manifest bullet** (line 131). The ZIP has never contained a
   manifest; the claim is unbacked. The manifest is still generated and stored
   internally — this only removes the promise to the accountant.

4. **Remove the IC-card advisory block** (lines 153–163) and the now-unused
   `icAdvisories` plumbing in `deriveTransitionNoticeInput` (lines 228–243). The
   事業目的 column states 交通系ICカードチャージ per-row, where the accountant works.
   `isIcCardTopUpCandidate` and `computeIcCardTopUpWarnings` stay — they still drive
   the operator-facing warning.

5. **Remove the 改訂情報 block** (lines 164–169). Policy confirmed by David
   2026-08-07: every delivery reads as a fresh first delivery, no revision info in the
   notice or the email. Remove `exportRevision` / `supersedesExportId` /
   `correctionReason` from `TransitionNoticeInput` if nothing else consumes them —
   check `notify.ts` before deleting.

Keep (moved under 【この資料について】): the 照合表 bullet, the 丸数字 bullet, the
paper-receipts bullet, and both re-compression bullets. Keep 【今月の内容】 counts and
【領収書なしの明細】 unchanged.

---

## Change 4 — pre-send anomaly suite

Build `lib/receipts/pack-preflight.ts`: a pure function taking the assembled pack
(entry names + bytes + the parsed CSVs + notice text) and returning an itemised
pass/fail report. **No UI in this phase** — expose it as a function with full unit
coverage; Phase B wires it into the pre-send confirmation screen and blocks send on
failure.

This is what makes automated delivery safe. Today David inspects packs by hand; once
finalize sends automatically, an anomaly is discovered by the accountant instead.

Checks — each must fail loudly, naming the offending value:

**Naming integrity**
- container names (zip filename, root folder) are pure ASCII
- every filename mentioned in the notice text exists as an actual ZIP entry
- `payment_due_date` present and parseable

**Referential integrity**
- every `領収書ファイル名` cell across all three CSVs resolves to a ZIP entry
- every evidence file in the ZIP is referenced by ≥1 CSV row
- no duplicate evidence filenames within a folder
- per-科目 circled sequence is contiguous from ① with no gaps

**Arithmetic**
- 集計 per-category counts/totals reconcile against CSV rows
- 集計 payment-path totals reconcile against the AMEX statement total
- 明細行数 / 証憑ファイル数 in the notice match the actual pack

**Encoding + transport**
- every entry name round-trips UTF-8 encode/decode unchanged
- every entry name is NFC-normalised (Mac-origin merchant strings can arrive NFD)
- no entry name contains `\ / : * ? " < > |` or a character outside the printable BMP
- **half-width `¥` (U+00A5) appears in no filename** — regression guard on `0d477f9`
- total pack size below a configured ceiling (constant for now; Phase B reads settings)

**Content policy**
- notice has no 改訂情報, no manifest sentence, no attendee reference
- no CSV has a `会議-出席者ID` column

Write a deliberately-broken fixture per check so each failure path is proven, not
just the happy path.

### Design requirement — single naming authority

§7 of the delta doc exists because the ZIP assembler, the notice builder and the
download resolver each retype filenames independently, so a rename desynced them.
**Fix that structurally in this task**: introduce one module that owns every
human-facing name for a month (e.g. `lib/receipts/pack-naming.ts`) exposing the zip
name, root folder, the three receipt folders and the five index filenames, derived
from `month` + `paymentDueDate`. `assembleProofsZip`, `buildTransitionNotice` and
`resolveBundleDownload` all consume it. A future rename must be impossible to apply
in one place and miss another.

---

## Change 5 — remove legacy code (explicit requirement)

**No superseded code path may survive this change.** Renames that leave the old path
callable are how a system ends up with two naming authorities — the exact defect §7
documents. For each candidate below: verify whether it still has a live caller,
**delete it if dead**, and **report it if still referenced** with the referencing site.

Do not delete anything merely because this prompt lists it — verify first.

**Naming**
- `AMEX_FOLDER` / `CASH_FOLDER` / `DIGITAL_FOLDER` literals (`proofs.ts:279-284`)
- the old `ROOT_PREFIX` form
- `buildProofFilename` + `ProofFilenameParts` (`proofs.ts:58-78`) and the entire
  `else` branch at `proofs.ts:338-360`. This is the legacy `No{NN}_` naming, reachable
  only when `entry.filename` is absent. If every entry now carries a pre-assigned
  evidence name, the branch and both symbols are dead — **check the route before
  concluding**, and if it is dead, remove the optional `filename?` marker on
  `ProofZipEntry` too so the name becomes required.
- old `AMEX{month}_Reconciliation.csv`-style literals in `export.ts`

**Attendees**
- the id-resolution half of `attendeeIdCells` (`reconciliation-files.ts:245-259`)
- the `resolveAttendeeNames` import in `reconciliation-files.ts` if nothing else uses it
- the `attendeesCsv` parameter and every call site passing it
- `csvQuoteAlways` **at the removed sites only** — leave the function itself; other
  callers may rely on it

**Notice**
- `icAdvisories` on `TransitionNoticeInput` and the IC loop in
  `deriveTransitionNoticeInput` (`proofs.ts:228-243`)
- the `isIcCardTopUpCandidate` import in `proofs.ts` — **keep the function in
  `blockers.ts`**, it still drives the operator warning
- `exportRevision` / `supersedesExportId` / `correctionReason` on the notice input —
  **check `notify.ts` before removing**, the finalize email may still consume them
- the old `buildTransitionNotice` export name

**Explicitly NOT legacy — do not remove**
- `statementMonthToken` and `circledNumber` — evidence names keep the `Jun2026③`
  convention; these are load-bearing
- the finalize gate, attendee directory, `categoryRequiresAttendees`
- `buildAttendeesExportCsv` and the operator bundle entry (D9: retain, don't deliver)
- the manifest builder (O1 removes only the *sentence*, not the manifest)

Finish with a repo-wide grep for the old literals (`AMEX明細分`, `現金分`,
`デジタル分`, `お知らせ.txt`, `参加者一覧.csv`, `_Reconciliation.csv`,
`export-${month}`) and report every remaining hit with its file and line.

---

## Tests

`npm test` (tsx --test — **not vitest**). Add coverage for:

- `pack-naming`: correct zip/root/folder/index names for a given month + payment date;
  throws on null/unparseable payment date
- evidence filenames **unchanged** — assert the exact June strings, including
  `会議費Jun2026③小田原みなと食堂￥6,490.jpg`, as a regression guard against scope creep
- ZIP contains no `参加者一覧`; CSV headers contain `人数` and not `会議-出席者ID`
- notice contains no attendee bullet, no manifest sentence, no IC block, no 改訂情報
- notice's interpolated filenames equal the actual ZIP entry names (the desync guard)
- notice omits 【今月のご連絡】 entirely when `operatorMessage` is empty
- `assembleProofsZip` still sets the UTF-8 flag on non-ASCII entry names
- `pack-preflight`: one passing case plus **one deliberately-broken fixture per check**

Existing receipts tests must stay green (577 at last count); update fixtures that
assert old names.

## Verification

1. `npx tsc --noEmit` clean, `npm test` green
2. `npm run cf:dev` against live bindings — generate a **draft** export for 2026-06
3. Download the draft ZIP and report the **complete file tree** plus the full text of
   the three CSVs and the notice
4. `npm run build:cf` must pass
5. **Do not deploy and do not finalize or re-deliver 2026-06** — it is sealed and
   approved. Draft generation only.

## Report back

Report facts, not reassurance. The architect verifies independently and will read the
diff — a claim that does not survive inspection costs more than an admitted gap.

- The 2026-06 draft file tree, **verbatim**, plus the full text of the three CSVs and
  `202606_ご連絡事項.txt`
- **Change 5 results as a table**: every candidate symbol → deleted / still referenced
  (with the referencing site) / not found
- The repo-wide grep output for the old literals, in full — including zero hits
- What `readme.txt` contains and whether it duplicates ご連絡事項
- Any place where `payment_due_date` was missing or surprised you
- Whether the legacy `No{NN}_` branch was reachable, and how you determined it
- Test count before/after, and the list of fixtures you had to update
- Anything you had to decide that this prompt did not cover
