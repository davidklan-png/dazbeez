# June 2026 closing pack — approved vs. packager output

**Status:** proposal for David's approval. **No code has been changed.**

**Source of truth:** `合同会社Dazbeez領収書等2026-06_Windows対応版.zip`
(Drive `1YkdMSxorrwCqu5ht78Og1AKeltUPCQc0`, modified 2026-08-07), extracted to
`external/`. The extraction mangled the Japanese names on the Mac; all names below
were recovered by reversing the mangling (CP932 bytes read as MacRoman) and every
recovery was round-trip verified, so these are the exact bytes the accountant approved.

**Baseline:** `lib/receipts/proofs.ts` (`assembleProofsZip`),
`lib/receipts/reconciliation-files.ts`, `lib/receipts/export.ts`
(`resolveBundleDownload`), `app/api/receipts/export/month/route.ts`.

---

## Summary

| # | Change | Class | Risk |
|---|--------|-------|------|
| 1 | ZIP entry names are CP932, UTF-8 flag off | **Architectural** | High |
| 2 | Root folder renamed | Naming | Low |
| 3 | AMEX folder + CSV named by **payment date** | **Architectural** | Medium |
| 4 | CASH folder + CSV named by **month** | Naming | Low |
| 5 | 集計 / 参加者一覧 gain a month suffix | Naming | Low |
| 6 | お知らせ.txt renamed | Naming | Low |
| 7 | お知らせ.txt body now contradicts the pack | **Correctness** | Medium |
| 8 | IC-advisory block deleted from the notice | **Policy** | Medium |
| 9 | DIGITAL naming undefined (June had zero rows) | **Open gap** | Medium |
| 10 | Delivered ZIP filename | Naming | Low |

Confirmed **unchanged** — do not touch: numbering authority, CSV columns,
evidence-filename pattern, category labels, content encoding. See "Non-changes".

---

## 1. ZIP entry names are CP932 with the UTF-8 flag off

This is the decision that matters. Everything else is text.

```
CURRENT   fflate zipSync() → entry names UTF-8, general-purpose bit 11 SET
          proofs.ts:382   return zipSync(files, { level: 0 });

APPROVED  entry names CP932 (Shift-JIS), UTF-8 flag NOT set
          Evidence: 合同会社Dazbeez領収書等2026-06.encode('cp932').decode('mac_roman')
          reproduces the on-disk mangled name byte-for-byte.
```

**Why it matters beyond this pack.** Our current output is correct by spec and
opens fine in modern Windows Explorer. The accountant's chain evidently needs the
legacy encoding — hence the `_Windows対応版` suffix on the file David sent.

This partially **supersedes the reasoning behind the ￥ fix** shipped 2026-07-24
(`0d477f9`, `f144989`). That fix chose full-width ￥ (U+FFE5) because half-width ¥
(U+00A5) is absent from CP932 and would map to byte `0x5C`, which Windows reads as
a path separator. If we encode entry names to CP932 **ourselves**, we control that
conversion instead of hoping the accountant's tool does it safely — and any
character we cannot encode fails loudly at pack time rather than corrupting a
delivery. Keep the full-width ￥ regardless; it is now enforced rather than assumed.

**Cost.** `fflate` has no CP932 encoder and neither does the Workers runtime
(`TextEncoder` is UTF-8-only; `TextDecoder` can *read* Shift-JIS but not write it).
This needs an encoding table shipped in the Worker bundle, plus a pack-time guard
that rejects any name containing a character outside CP932.

**Decision required.** Three options, in my order of preference:

- **A. Emit CP932 entry names natively.** Matches what was approved. Costs a
  dependency and a hard "unencodable character" failure path — which is a feature:
  it surfaces at seal time, not at the accountant's desk.
- **B. Keep UTF-8, ship a CP932 conversion as a separate download.** Two artifacts
  to keep in sync forever. I'd avoid it.
- **C. Keep UTF-8 and treat the re-encode as a manual operator step.** Status quo.
  Every future delivery needs David to redo by hand what he did for June, and the
  sealed-manifest SHA no longer describes the file the accountant receives.

C is what happened this month, and it's the reason this review exists.

---

## 2. Root folder renamed

```
CURRENT   領収書等証憑_2026-06/
          proofs.ts:278   const ROOT_PREFIX = (month) => `領収書等証憑_${month}/`;

APPROVED  合同会社Dazbeez領収書等2026-06/
```

Adds the company name; drops 証憑; keeps the **ISO** month (`2026-06`), unlike every
other renamed artifact which uses `2026年6月`. Flagged in §11 as possibly accidental.

`合同会社Dazbeez` should come from a settings value, not a string literal — the
packager currently has no concept of the filing entity, and hardcoding it puts a
company name in library code.

---

## 3. AMEX folder + CSV named by statement payment date

```
CURRENT   AMEX明細分/                              proofs.ts:279
          AMEX2026-06_Reconciliation.csv           proofs.ts:373, export.ts:573

APPROVED  AMEXカード利用領収書2026年6月4日支払い分/
          AMEXカード利用明細2026年6月4日支払い分.csv
```

`2026年6月4日` is the statement's **payment due date**, not the statement month.
It is already parsed and persisted — `validation.ts:285` reads `お支払日`, stored as
`amex_reconciliations.payment_due_date` (`0005_amex_extended.sql:25`). No new data
capture needed.

**But the column is nullable.** A statement imported without a parseable `お支払日`
would produce a hole in a filename. The packager needs a defined behaviour: I'd
make it a **blocker at finalize** rather than a fallback string, since a pack named
after the wrong date is worse than a pack that refuses to build.

Note this naming is genuinely well-chosen: AMEX is named by payment date, cash by
calendar month, which is exactly the split-lock membership model from ADR 0004. The
filenames now state the model out loud.

---

## 4. CASH folder + CSV named by month

```
CURRENT   現金分/                                  proofs.ts:283
          CASH2026-06_Reconciliation.csv           proofs.ts:376, export.ts:579

APPROVED  現金払い領収書2026年6月分/
          現金払いリスト2026年6月分.csv
```

Pattern across both paths: the **folder** says 領収書, the **CSV** says 明細 (AMEX,
a passthrough of the card statement) or リスト (cash, our own list). Worth preserving
deliberately — it tells the accountant which file is theirs and which is ours.

---

## 5. 集計 / 参加者一覧 gain a month suffix

```
CURRENT   集計.csv          参加者一覧.csv          proofs.ts:369-370
APPROVED  集計2026年6月分.csv   参加者一覧2026年6月分.csv
```

Sensible: these get detached from the ZIP and filed, and the bare names collide
across months in a single folder.

---

## 6. お知らせ.txt renamed

```
CURRENT   お知らせ.txt                             proofs.ts:371
APPROVED  新システムに関するご連絡.txt
```

---

## 7. お知らせ.txt body now contradicts the pack it ships in

The **body text is byte-identical** to `buildTransitionNotice` output — it was not
edited when the filenames were. Four false statements now ship with the pack, plus
one that was already wrong:

| Notice says | Reality in the approved pack |
|---|---|
| `AMEX＜年月＞_Reconciliation.csv` | file is `AMEXカード利用明細2026年6月4日支払い分.csv` |
| 現金・デジタル決済分は `CASH／DIGITAL` の照合CSV | file is `現金払いリスト2026年6月分.csv`; no DIGITAL file |
| `参加者一覧.csv` をご参照ください | file is `参加者一覧2026年6月分.csv` |
| 全ファイルの SHA-256 を**マニフェスト**に記録 | **no manifest is in the ZIP** |
| lists 4 appended columns | the CSV has **5** — 事業目的 missing from the list |

The last two are pre-existing bugs the rename merely exposed:

- **The manifest claim is unbacked.** `buildManifestCsv` uploads the manifest to R2
  as a standalone artifact; `assembleProofsZip` never adds it to the ZIP. An
  accountant who only opens the ZIP — the exact reader 集計.csv and 参加者一覧.csv
  were embedded for — cannot verify anything. Either embed the manifest or drop the
  sentence. **I recommend embedding it**: it's small, it's the integrity story, and
  it's the one claim in this notice that's about trust.
- **事業目的 was added to the CSVs in PR #139 but never added to the notice's column
  list.** Straight omission.

Proposed replacement for the first bullet (`proofs.ts:118-120`):

```
・カード明細の照合表（AMEXカード利用明細2026年6月4日支払い分.csv）は、カード会社の
  明細CSVをそのまま再現し、右側に「科目＆No.」「事業目的」「会議-出席者ID」「人数」
  「領収書ファイル名」の列を追記したものです。現金決済分は 現金払いリスト2026年6月分.csv
  に分けて同封しています。
```

**Design point:** these filenames must stop being retyped in prose. The notice
builder should be handed the same name objects the ZIP assembler uses, so a rename
can never again desync the notice from the pack. That is the actual fix; the wording
above is just this month's output of it.

---

## 8. IC-advisory block deleted from the notice

```
CURRENT   【ICカードチャージの可能性がある取引（参考・確定ではありません）】
          ・2026-06-02 セブン-イレブン東中野末広橋店 ¥10,000 — 交通系ICカードの…
          (+3 more)                                proofs.ts:153-163

APPROVED  section absent — three stray blank lines remain where it was cut
```

Not an empty section. I verified the four ¥10,000 セブン-イレブン cash receipts
satisfy `isIcCardTopUpCandidate` (`blockers.ts:125` — CASH + travel_transportation +
round top-up amount + top-up venue), so the generator **would** have emitted this
block. It was removed by hand.

The reason is visible in the pack: those rows now carry
`交通系ICカードチャージ(Klan)` in the 事業目的 column. The advisory became redundant —
the CSV states it per-row, where the accountant is actually working.

**Decision required.** Delete the block, or keep it only when the matching row has
no 事業目的? I lean **delete**: an advisory in a notice nobody re-reads is weaker
than a value in the column, and duplicated statements drift. But this is a
tax-treatment communication, so it's your call, not mine. The three blank lines are
a hand-edit artifact either way — remove them.

---

## 9. DIGITAL naming is undefined — open gap

June had **zero** digital rows (`集計`: `デジタル,0,0`), so the approved pack contains
no DIGITAL folder and no DIGITAL CSV. The accountant has never seen one.

This is **already correct behaviour, not a change** — `proofs.ts:378` skips an absent
DIGITAL CSV, and a folder with no entries is never created. Do **not** read June's
absence as "remove DIGITAL support."

But we cannot ship §3–4 without inventing names the accountant hasn't approved.
Extrapolating the cash pattern:

```
PROPOSED (UNCONFIRMED)   デジタル払い領収書2026年6月分/
                         デジタル払いリスト2026年6月分.csv
```

**Recommendation:** send these two names to the accountant for confirmation now,
with June as the example, rather than discovering the objection in the first month
that has digital rows — which will be a month we're trying to close.

---

## 10. Delivered ZIP filename

```
CURRENT   export-2026-06-proofs.zip                export.ts:563
          (R2 object: <exportId>-proofs.zip        route.ts:500)

APPROVED  合同会社Dazbeez領収書等2026-06_Windows対応版.zip
```

`_Windows対応版` is David's manual marker for the hand-re-encoded copy. If change #1
lands, every pack is Windows-safe by construction and the suffix should **not** be
generated — it would imply a variant that doesn't exist.

```
PROPOSED  合同会社Dazbeez領収書等2026-06.zip     ← but see §13 before committing
```

**§13 argues for an ASCII outer filename instead** (e.g. `Dazbeez-receipts-2026-06.zip`).
The ZIP filename is transient — what the accountant actually files is the folder
*inside* it, `合同会社Dazbeez領収書等2026-06/`, which keeps its Japanese name either
way. A Japanese outer filename buys almost nothing and exposes us to an encoding
layer we do not control.

Keep the internal R2 key (`<exportId>-proofs.zip`) as-is — it's the immutable sealed
artifact identity and must not carry human-facing naming.

---

## 11. Month format inconsistency — needs a ruling

The root folder uses ISO `2026-06`; every other renamed artifact uses `2026年6月`.

```
合同会社Dazbeez領収書等2026-06/        ← ISO
  AMEXカード利用明細2026年6月4日支払い分.csv   ← Japanese
  現金払いリスト2026年6月分.csv                ← Japanese
  集計2026年6月分.csv                          ← Japanese
```

Deliberate (ISO sorts correctly when months sit side by side in a folder) or an
oversight? Ask before encoding it. Whatever we choose becomes the sort order of the
accountant's archive for years, and changing it later re-sorts their filing.

---

## 12. Attendee list must be REMOVED from the delivery (2026-08-07)

Written instruction from 永野税理士事務所 (大久保) on 2026-08-07, in the same mail
that approved the June pack:

> 接待、会議の出席者一覧表は貴社で保管されていれば問題ないので弊所に共有しなくても
> 大丈夫です。

The attendee roster does not need to be shared with the firm, provided Dazbeez
retains it. This arrived after the delta above was written and supersedes part of it.

**This is the highest-value privacy change available to us**, and it outranks any
transport encryption: `参加者一覧2026年6月分.csv` is the only artifact in the pack
carrying third-party personal data — 15 named individuals with employer and job title
across Manulife, BMW, AIG, Cognizant, Orix and others. Not sending it removes that
exposure outright; encrypting it only moves the exposure.

**Cascade — the ID columns become meaningless without the roster.** Both
reconciliation CSVs carry `会議-出席者ID` (`1; 2; 27; 29`), which is decodable only
via 参加者一覧.csv. Dropping the roster and keeping the IDs ships noise.

```
CURRENT   参加者一覧.csv embedded in ZIP        proofs.ts:370
          会議-出席者ID + 人数 columns          reconciliation-files.ts:114,272
          standalone attendees artifact         export.ts:550

PROPOSED  roster: removed from delivery, retained in system
          会議-出席者ID: removed from both CSVs
          人数: KEPT
```

**Keep 人数.** The participant count is not decoration — it feeds the per-head test
that determines 交際費 treatment. The names are what the firm doesn't need; the count
is arguably the one attendee field they do. Confirm the split with 大久保 rather than
assuming it — this is a tax-treatment question, not an engineering one.

**Do NOT relax the internal gate.** The finalize gate blocking unresolved attendee
names, the attendee directory, and `categoryRequiresAttendees` all stay exactly as
they are. Japanese law requires the company to keep participant records for 交際費;
「貴社で保管されていれば」 is conditional on us continuing to hold them properly. This
is an **export-layer change only**. An export change must not be allowed to erode an
internal control — if anything, retention now matters more, because we are the only
copy.

**Also update お知らせ.txt** — it currently instructs the reader to consult
参加者一覧.csv for ID resolution (§7). That bullet should be removed entirely rather
than reworded.

---

## 13. Transport: two encoding layers, only one of which we control

The firm runs **safeAttach** (Orangesoft) at `nagano-tax.sa.crosshead.jp` — confirmed
from the portal screenshot, 2026-08-07. It strips attachments on receipt, serves them
from a login-gated download page, and sends the password separately (添付ファイル分離).
It is **on their side, mandatory, and already in the production path** — the approved
June pack travelled through it.

### The two layers

```
LAYER 1   safeAttach 一括ダウンロード bundle   ← encodes OUR zip's FILENAME
          (created by their appliance)            we do not control this
LAYER 2   our pack zip's entry names          ← encodes the RECEIPT filenames
          (created by our packager)               §1 is about this layer only
```

Mojibake from layer-1 bulk download is a **documented, generic failure across the
whole product category** — HENNGE, WingArc, LRM and Livestyle all publish KB articles
describing exactly it. The standard vendor remedy is identical everywhere: use a
UTF-8-capable extractor, or set the extractor's filename encoding to MS932 (=CP932).

This matters because it means **§1 may have been misdiagnosed as our problem.** The
`_Windows対応版` conversion was David's own preemptive fix, not something the
accountant requested — his approval mail says only 「頂いた資料で問題ございません」,
which is exactly what you'd expect after receiving an already-converted file. We
still do not know whether he *needs* CP932 or merely never had cause to complain.
The probe is what settles it.

### Mitigation: make layer 1 unable to hurt us

**Give the delivered pack an ASCII filename** (§10). If safeAttach bundles our zip
into an outer archive, an ASCII entry name cannot mojibake at layer 1 regardless of
what the appliance does. Japanese naming stays *inside* the zip, where our encoding
decision governs. This cleanly separates the two layers and costs nothing — the
folder the accountant files is the one inside.

The probe kit already has this property by accident of design (ASCII filenames were
chosen to dodge APFS normalisation), so **probe results will be clean even if the
portal bundles them.** No re-issue needed.

### Do NOT add a sending-side tool

- ZIP暗号化 / PPAP-style tools work by **re-zipping the attachment**, rewriting
  exactly the entry-name bytes this whole exercise exists to control. Adding one
  would break the fix.
- Their side already applies the control on receipt. A second appliance adds a third
  encoding layer and no additional protection.
- The FSA angle is **inside-baseball from David's insurance employer's security team
  — a suggestion, not a mandate, and not directed at Dazbeez.** Dazbeez is an
  AI/automation/data consultancy, outside FSA supervisory scope.
- **The real privacy win is §12, not encryption.** The only third-party PII in the
  pack is the attendee roster, and the accountant has just said to stop sending it.
  Data minimisation beats transport encryption: an artifact never sent cannot leak,
  whatever the channel does.

### Integrity signal

File sizes are quoted in the probe email as a human-checkable check — a tax
accountant will not run SHA-256, but he can read a number off a download screen. A
mismatch means the chain altered the file.

---

## 14. The 破損 incident — what actually prompted the CP932 pack

Recovered 2026-08-07. This reorders the causal chain the rest of this document
assumed.

**Sequence:**

1. System generates the June pack (UTF-8 entry names, flag set)
2. Murakami hand-edits files in the pack on her Mac
3. She re-zips with Finder Compress
4. 大久保 replies: 「ZIPファイルが破損していたため確認できませんでした。
   ZIPファイルに圧縮せずにお送りいただけませんでしょうか。」
5. David hand-builds the CP932 `Windows対応版` in response
6. 大久保 approves it: 「頂いた資料で問題ございません」

**The accountant never requested CP932. He requested no ZIP.** The CP932 format was
an operator workaround for a complaint that was not about encoding; it passed, so it
was never revisited. §1 of this document treats the approved pack's format as a
requirement — it is better read as an untested guess that happened not to fail.

### Root-cause candidates for 破損

1. **Half-width ¥ (U+00A5) → byte `0x5C`** — the mechanism documented in
   `proofs.ts:40-49`: no CP932 mapping, degrades to the Windows path separator,
   "corrupting or aborting extraction." This produces a *corruption* report rather
   than mojibake, which matches the wording exactly. **Fixed `0d477f9`, 2026-07-24** —
   the same day the approved pack was built. Most likely cause, and already closed
   for system-generated output.
2. **Finder Compress artifacts** — `__MACOSX/`, AppleDouble `._` entries, NFD-decomposed
   names. Some Japanese extractors reject rather than tolerate these.
3. **Lhaplus-class extractor on UTF-8-flagged entries** — fails hard instead of
   garbling.

The probe distinguishes these. Note (1) and (3) point in opposite directions: if (1),
the current packager is already correct and needs no CP932 change at all.

### Process rule — independent of any probe result

**No hand-editing of a generated pack, and no re-zipping on a Mac.** Beyond the
corruption risk, hand-editing silently voids the sealed manifest: every SHA-256 in it
describes bytes that no longer exist, while お知らせ.txt continues to tell the
accountant he can verify integrity with it (§7). A hand-touched pack is not the
artifact the system sealed and must not be presented as one.

If Murakami needs to correct something, the correction goes back through the system
and the month is re-exported — that is what the unfinalize path (PR #139) exists for.
See [[mac-zip-for-japanese-windows]].

### Open: delivery format

Still undecided, and it dominates §1. If unzipped delivery is acceptable, there is no
zip entry-name layer at all — no CP932 decision, no ㉑ cliff (§9 of SEND-PROCEDURE),
no re-zip exposure. The cost is ~37 loose files per month and the loss of the
AMEX/現金 folder split, which the 照合CSVs already encode redundantly.

The probe email now asks this directly as その4, flagged as the most important
question. Structure design deferred until he answers.

---

## 15. Delivery model — decided 2026-08-07

### Confirmed

| Decision | Value |
|---|---|
| No hand-editing of generated packs | Corrections go back through the system + re-export |
| Happy path | Review all expenses in draft → review/edit/approve email subject+body → **Finalize** → send |
| Recipients | To: accountant, Cc: business manager (registered addresses) |
| ZIP filename | `yyyymm_Dazbeez_Monthly_Expense_Report.zip` (e.g. `202606_…`) |
| ZIP entry names | UTF-8, UTF-8 flag **set** — i.e. **keep current `fflate` behaviour** |
| Pack preview | Contents must be viewable before finalize; not opened locally |
| Attendees | **Names removed** from delivery; **人数 kept** |

**§1 is therefore resolved as "no change".** Choosing UTF-8+flag means the packager's
existing output is already correct and no CP932 encoder is needed. Two consequences
worth stating:

- **The ㉑ cliff disappears.** Circled numbers above ⑳ are unrepresentable in CP932
  but fine in UTF-8. `circledNumber()` needs no change; its `(n)` fallback stays at 50.
- **This is contingent on the probe.** UTF-8+flag is near-universal but **not
  ubiquitous** — Windows 10 1803+/11 Explorer and 7-Zip honour the flag; **Lhaplus,
  still common in Japanese accounting offices, does not.** 大久保 has already failed
  to open one ZIP. Do not ship automated sending before his probe answer lands.

### Decisions registered 2026-08-07

**D1 — DECIDED: Finalize triggers send, after an explicit confirmation step.**
Constraint that must hold: send fires strictly **after** the seal commits, never
inside the sealing transaction.

**D2 — DECIDED: send failure IS finalize failure.** Reverses the hard rule at
`notify.ts:11-14`.

*Architectural translation — this must NOT be implemented as a rollback.* R2 archival
writes, D1 state, and a third-party email API cannot participate in one transaction,
and a sent email cannot be recalled. Implement as a **state machine** instead:

```
draft → sealed → delivered
              ↘ sealed_undelivered  (retryable; month is NOT closed)
```

The sealed artifact is immutable and stays; only the *month-closed* flag waits on
delivery. This gives the intended business semantics — the month is not closed until
the accountant has it — without an impossible distributed rollback, and it preserves
ADR 0009 immutability. A failed send leaves a visible, retryable state rather than
destroying a valid seal.

*Required:* an **idempotency key** on the Resend call. A network timeout on the
response is ambiguous — the mail may have been accepted. Without a key, retry sends
twice.

**D3 — DECIDED: attach the ZIP.** Capacity revisited if limits approach; choice then
between a paid tier and a download function. *Required now:* a hard pre-send size
check that **fails loudly** rather than truncating or silently degrading. June is
6 MB / 33 receipts; base64 inflates ~33%; Resend caps near 40 MB.

**D4 — DECIDED: numbers do not change; body is an operator message channel.** The
business manager uses it to draw attention to pack details or pass messages to the
tax accountant. See open item **O3** — the auto-generated summary block still needs a
ruling.

**D5 — DECIDED: yes.** Persist approved subject, body, recipients, timestamp,
exportId and ZIP SHA-256 on the export record.

**D6 — DECIDED: double-send guard, keyed on `yyyymm`.** See **O4** — a legitimate
corrected re-delivery must be able to pass the guard.

**D7 — DECIDED:** on editing the recipient setting, show the user a message stating
that this address receives the pack automatically on finalize and that the field is
audited.

**D8 — DECIDED: yes** — preview renders the sealed/draft artifact itself, not a
re-derivation.

**D9 — DECIDED: yes** — generate and retain 参加者一覧, do not deliver it.

**D10 — DECIDED: same name inside and outside.**

```
202606_Dazbeez_Monthly_Expense_Report.zip
└── 202606_Dazbeez_Monthly_Expense_Report/
```

Supersedes §2 and the accountant-approved `合同会社Dazbeez領収書等2026-06/`. Note this
removes the encoding risk from the *root* but not from evidence filenames inside, which
remain Japanese — **the probe is still required.**

**D11 — DECIDED: standardize all filename dates to a `yyyymm_` / `yyyymmdd_` prefix.**
Scope: **containers and index files only.** Evidence filenames are unchanged.

**D12 — DECIDED: index files keep Japanese names with an ASCII date prefix.**

**D13 — DECIDED: drop the IC-card advisory block** from お知らせ (resolves §8).

**D14 — DECIDED: email body = summary regenerated at send + separate editable
message area.** Approval screen shows the final assembled text.

### Final naming scheme (supersedes §2–§6, §10)

```
202606_Dazbeez_Monthly_Expense_Report.zip
└── 202606_Dazbeez_Monthly_Expense_Report/
    ├── 20260604_AMEXカード利用明細.csv          ← payment_due_date (yyyymmdd)
    ├── 202606_現金払いリスト.csv
    ├── 202606_デジタル払いリスト.csv            ← only when non-empty (§9 UNCONFIRMED)
    ├── 202606_集計.csv
    ├── 202606_ご連絡事項.txt                    ← corrected 2026-08-07 per O5
    ├── 20260604_AMEXカード利用領収書/
    │     会議費Jun2026③小田原みなと食堂￥6,490.jpg    ← UNCHANGED
    ├── 202606_現金払い領収書/
    │     交際費Jun2026④こぶちさわ￥6,967.jpg          ← UNCHANGED
    └── 202606_デジタル払い領収書/               ← only when non-empty
```

`参加者一覧` is absent (D9). The date moves to the prefix, so the trailing
`〜支払い分` / `〜分` suffixes are dropped as redundant.

**Why evidence filenames stay Japanese and unprefixed:** the 科目＆No label is the
accountant's join key, appears verbatim in the CSVs' 領収書ファイル名 column, matches
his manual-close convention, and he approved it. Prefixing it would desync the label
from the column unless both moved together, for no gain.

### O1–O6 resolved 2026-08-07

**O1 — RESOLVED: delete the SHA-256 sentence** from the notice; keep generating and
storing the manifest internally.

**O2 — RESOLVED: policy verified, remove the 改訂情報 block** (`proofs.ts:164-169`).
Every delivery reads as a fresh first delivery. No revision info in the notice or the
email.

**O3 — RESOLVED: explicit operator override with confirmation** on the `yyyymm`
double-send guard. Phase B.

**O4 — RESOLVED: DIGITAL names confirmed.** `{yyyymm}_デジタル払いリスト.csv` /
`{yyyymm}_デジタル払い領収書/`, emitted only when non-empty.

**O5 — RESOLVED: お知らせ becomes `{yyyymm}_ご連絡事項.txt`** — a standing
communications channel between business admin and the accountant, not a one-time
transition notice.

This changes the file's *purpose*, not just its name. Proposed structure:

```
【今月のご連絡】      ← operator free text (Phase B; omitted when empty)
【この資料について】  ← standing explanation: 科目＆No convention, per-file
                        receipts, image re-compression, PDF originals
【今月の内容】        ← counts
【領収書なしの明細】  ← unchanged
```

Retire the transition framing 「従来の手作業納品との違い」 and the bullet contrasting
against 別紙PDF — both describe a migration that will soon be ancient history. The
durable content is *how to read this pack*, which is worth restating every month.

**Consequence — see O7.**

**O6 — RESOLVED: build a pre-send anomaly suite** (see §16). Replaces "run the probe
and hope" with a machine check that runs on every pack.

### O7 — NEW: two operator message channels now exist

D14 gives the business manager an editable message area in the **email body**. O5
gives 【今月のご連絡】 in the **pack**. If both are authored separately they will drift
— the same failure mode as §7.

Note the asymmetry that makes both necessary: safeAttach **strips the attachment** and
serves it from a portal, so the email body is what the accountant is guaranteed to
read, while ご連絡事項.txt is what gets **filed with the records**. Neither can be
dropped.

**O7 — DECIDED 2026-08-07: one message, two surfaces.** The operator writes once at
approval time; the same text is injected into both the email body and 【今月のご連絡】.
Single source, no second authoring surface. Phase B.

---

## 17. Verification protocol for the Phase A worker report

David's instruction 2026-08-07: on completion, check all assumptions and confirm no
legacy code remains. The architect verifies **independently** — the worker's report is
an input, never the evidence.

**Assumptions in the Phase A prompt that must be re-checked against the diff**, since
each was asserted from a sandbox read and could be wrong:

1. `payment_due_date` is populated for 2026-06 (asserted from schema, never observed
   live). If null, the pack cannot be named — confirm the blocker fired or the value
   existed.
2. The legacy `No{NN}_` branch (`proofs.ts:338-360`) is unreachable. Asserted from
   reading, not proven. If it is still reachable, a second naming authority survives
   and §7's defect is intact.
3. `statementMonthToken` / `circledNumber` survive untouched — evidence filenames must
   be **byte-identical** to the approved June pack. This is the highest-risk
   regression in the task: it is the accountant's join key, and a "consistency" tidy-up
   would silently break it.
4. Removing 会議-出席者ID does not disturb 人数, the finalize gate, or the directory.
5. `notify.ts` does not depend on the revision fields removed from the notice input.

**Independent checks to run on the returned draft**, not read from the report:

- Diff the regenerated 2026-06 evidence filenames against the approved pack in
  `external/` — must match exactly, after NFC normalisation on both sides
- Confirm every filename in ご連絡事項 exists as a ZIP entry (the §7 desync guard,
  verified against real bytes rather than trusting `pack-preflight`'s own test)
- Confirm `pack-preflight`'s broken fixtures actually fail — a check that cannot fail
  is not a check
- Grep the diff for reintroduced half-width `¥` and for any `参加者一覧` /
  `会議-出席者ID` survivor
- Confirm the deleted symbols are gone from the tree, not merely unexported

**Standing rule:** never accept "all tests pass" as evidence that legacy paths were
removed. Passing tests prove the surviving path works; they say nothing about a dead
path still being callable.

---

## 16. Pre-send anomaly suite (O6)

A machine check that must pass before a pack can be sent. This is the standing
replacement for manual inspection — and it is what makes automated delivery safe,
because a failure is now discovered by the accountant rather than by David.

Checks, each failing **loudly** with the offending value:

**Naming integrity**
- container names (zip, root folder) are pure ASCII
- every filename referenced in the notice exists as an actual ZIP entry — the §7
  desync guard, run against real bytes
- `payment_due_date` present and parseable

**Referential integrity**
- every `領収書ファイル名` cell in all three CSVs resolves to a ZIP entry
- every evidence file in the ZIP is referenced by at least one CSV row
- no duplicate evidence filenames within a folder
- 科目＆No sequence per category is contiguous from ① with no gaps

**Arithmetic**
- 集計 per-category counts and totals reconcile against the CSV rows
- 集計 payment-path totals reconcile against the AMEX statement total
- 明細行数 / 証憑ファイル数 in the notice match the actual pack

**Encoding + transport**
- every entry name round-trips through UTF-8 encode/decode unchanged
- every entry name is NFC-normalised (Mac-origin merchant strings can arrive NFD)
- no entry name contains a character outside the printable BMP, or any of
  `\ / : * ? " < > |`
- half-width `¥` (U+00A5) appears in **no** filename — regression guard on `0d477f9`
- total attachment size below the configured ceiling (D3)

**Content policy**
- notice contains no 改訂情報 block (O2), no manifest sentence (O1), no attendee
  reference (D9)
- no CSV contains a `会議-出席者ID` column (D9)

Report as a single pass/fail with an itemised list, surfaced in the pre-send
confirmation screen (D1). A failing check blocks send.

### Attendee removal — exact touch points

```
proofs.ts:370            remove 参加者一覧.csv from the ZIP
proofs.ts:125            remove the attendee bullet from お知らせ (§7)
proofs.ts:303-312        drop the attendeesCsv parameter
reconciliation-files.ts:114   drop 会議-出席者ID from AMEX append headers (keep 人数)
reconciliation-files.ts:272   drop 会議-出席者ID from payment-path headers (keep 人数)
reconciliation-files.ts:245   attendeeIdCells → count only
export.ts:501,548        KEEP (operator/retention artifact, not delivered)
```

**Do not touch** the finalize gate, the attendee directory, or
`categoryRequiresAttendees`. Retention now matters *more*, not less — we become the
only copy. An export change must not erode an internal control.

---

## Non-changes — verified identical, do not "fix"

Stating these explicitly so nobody reads a diff and starts improving things.

- **Numbering authority.** Per-科目 circled sequence, AMEX statement order first,
  then CASH. Verified continuing **across folders**: 交際費 ①②③(AMEX) → ④(cash);
  消耗品費 ①②③ → ④⑤; 旅費交通費 ①–⑩ → ⑪–⑭. The single-authority design in
  `buildEvidenceAssignments` survived the accountant's review intact. This is the
  one thing that must not move.
- **Shared-receipt rule.** HUB 東京オペラシティ (¥2,864 + ¥4,185) and both ENEOS
  pairs each show two statement lines pointing at one evidence file named for the
  receipt total (￥7,049 / ￥22,770 / ￥3,545). Exactly as designed.
- **Evidence filename pattern.** `{科目}{Jun2026}{①}{店舗}{￥金額}.{ext}`, no
  separators, full-width ￥, comma-grouped. Unchanged.
- **CSV columns.** AMEX appended block (5 cols incl. 事業目的) and the 9 lean
  CASH columns match `AMEX_RECONCILIATION_APPEND_HEADERS` and
  `PAYMENT_PATH_CSV_HEADERS` exactly.
- **`領収書なし：{reason}`** cells and bare-category 科目＆No. for no-receipt lines.
- **Attendee IDs** `"; "`-joined, quoted (`1; 2; 27; 29`) — the Excel date-coercion
  guard held.
- **Category labels.** 交際費 and 旅費交通費 already match `categories.ts:34,36`.
  The March manual pack used 接待交際費 / 交通費; the system moved on and the
  accountant accepted it. **Not a delta.**
- **Content encoding.** All CSVs UTF-8 **with BOM**, CRLF. Notice UTF-8 **without**
  BOM, CRLF. Matches current output. Note this is independent of change #1 — entry
  *names* are metadata, file *contents* are bytes zip tools never transcode.
- **ASCII hyphens** in `鶏ジロ-`, `スポ-ツエントリ-` are genuine U+002D in the source
  merchant data (byte-verified, not mangled `ー`). Upstream data, not a packager
  concern.

---

## Recommended sequencing

1. **Answer the three open questions first** — CP932 (§1), IC advisory (§8), month
   format (§11). Everything else is mechanical once these are settled.
2. **Get DIGITAL names confirmed** by the accountant (§9) before any code moves.
3. **Then implement as one worker task**, in this order:
   a. Extract a single naming module — one place that owns every human-facing name,
      consumed by the ZIP assembler, the notice builder, and the download resolver.
      §7 exists because those three retype names independently.
   b. Apply the renames (§2–6, §10) through that module.
   c. Fix the notice (§7) by feeding it name objects, not literals.
   d. CP932 encoding + unencodable-character blocker (§1).
   e. Payment-date-null blocker (§3).
4. **Regenerate June and diff against the approved pack byte-for-byte.** That is the
   acceptance test — the packager should reproduce what the accountant signed off,
   modulo the intentional `_Windows対応版` suffix drop.

Re-delivering June is not required (it's approved and sealed) but regenerating it in
a draft to run the diff is the only honest verification.
