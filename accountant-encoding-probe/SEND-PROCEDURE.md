# Encoding probe kit — send procedure

**Goal:** get the accountant's zip-extraction and Excel configuration pinned down
in one round trip, with the attached bytes provably identical to what was generated.

## What's in this folder

| File | Purpose |
|---|---|
| `probe-1-utf8-flagged.zip` | UTF-8 entry names, UTF-8 flag **set** — what our packager emits today |
| `probe-2-cp932-noflag.zip` | CP932 entry names, flag **clear** — what the approved June pack is |
| `probe-3-utf8-noflag.zip` | UTF-8 entry names, flag **clear** — the common broken middle case |
| `content-utf8-bom.csv` | CSV content probe, UTF-8 with BOM (what we ship) |
| `content-cp932.csv` | CSV content probe, Shift-JIS |
| `EMAIL-DRAFT-ja.txt` | Japanese email body — copy into Gmail |
| `CHECKSUMS.txt` | SHA-256 of all five attachments |

**Attach five files:** the three zips and the two CSVs. Do **not** attach
`EMAIL-DRAFT-ja.txt`, `CHECKSUMS.txt`, or this file.

## Why three zips instead of one

Each isolates one variable, and the three answers are mutually exclusive — whichever
combination he reports tells us his extractor's assumption without him needing to
know anything technical:

- **1 correct, 2 garbled** → his tool honours the UTF-8 flag. Modern Explorer, 7-Zip.
  We change nothing; June's manual re-encode was unnecessary.
- **2 correct, 1 garbled** → his tool assumes CP932 regardless. Lhaplus and older
  Japanese utilities do this. We must emit CP932.
- **2 and 3 correct, 1 garbled** → his tool ignores the flag and assumes CP932.
  Same conclusion as above, but confirms the flag is the irrelevant part.
- **All three correct** → he's normalising somewhere downstream and this was never
  our problem. Keep UTF-8.

The ASCII `00`–`06` prefixes are the trick that makes this answerable: they survive
any encoding, so he can report "01 correct, 03 garbled" even when the Japanese is
unreadable on his screen.

## The question that matters most

`probe-2` contains **no file 03**. That isn't an oversight — **㉑ and every circled
number above ⑳ are absent from CP932 entirely.** Verified: U+3251–325F (㉑–㉟) and
U+32B1–32BF (㊱–㊿) all fail to encode; only ①–⑳ (U+2460–2473) survive.

June's 旅費交通費 already reached ⑭. Seven more receipts in that category in one
month and we produce a filename that cannot exist in CP932. So if he answers
"probe-2 is the correct one", we are also committing to an ASCII fallback above ⑳ —
which is why the email asks him to choose between `(21)` and `㉑` explicitly rather
than leaving it for us to discover during a close.

`circledNumber()` in `reconciliation-files.ts:52` currently falls back to `(n)` only
above **50**. If CP932 wins, that threshold moves to **20**.

## Sending without altering the bytes

The files were generated in a Linux sandbox and written straight to this folder.
No Finder, no Compress, no archive utility touched them.

1. **Verify first.** In Terminal:

   ```
   cd ~/projects/work/dazbeez/accountant-encoding-probe && shasum -a 256 *.zip *.csv
   ```

   Compare against `CHECKSUMS.txt`. All five must match.

2. **Attach via Gmail's paperclip → file picker.** Not drag-and-drop.
   Dragging a *file* is byte-safe, but dragging a *folder* makes the browser or
   Finder zip it on the fly — with macOS's zipper, which is the exact tool that
   produces mojibake and `__MACOSX` entries. The file picker removes that risk
   entirely.

3. **Do not double-click the zips to preview them.** Extracting is read-only and
   harmless, but it litters the folder with mangled directories and invites
   re-compressing the wrong thing. If you want to look, ask me and I'll read them
   in place.

4. **Do not rename the attachments.** The names are pure ASCII specifically so that
   APFS Unicode normalisation has nothing to act on. Any Japanese in an outer
   filename could arrive NFD-decomposed and confuse the very thing we're testing.

5. **Re-verify after sending** (optional, cheap): forward the sent mail to yourself,
   download the attachments, and re-run `shasum`. If those five hashes still match,
   the transport is proven clean and we never have to wonder again.

## When the reply comes back

Three answers unblock the packager work:

1. Which probe rendered correctly → decides §1 of `docs/2026-06-pack-approved-delta.md`
2. `(21)` or `㉑` → decides the `circledNumber()` fallback threshold
3. Which CSV opened correctly in Excel → confirms or overturns UTF-8 BOM for contents

His environment details (Windows version, extraction tool, Excel version) are worth
recording in the repo regardless — that configuration is now a load-bearing input to
a monthly deliverable, and right now it lives only in his head.
