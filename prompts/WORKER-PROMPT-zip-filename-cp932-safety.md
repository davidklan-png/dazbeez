ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session, no live D1/R2 bindings) designed the following change and
needs it implemented, verified, and reported back — not redesigned. If you hit
a design decision this prompt doesn't cover, stop and report back instead of
improvising.

# CP932-safe proof filenames: half-width ¥ (U+00A5) → full-width ￥ (U+FFE5)

## Context

Field failure 2026-07-24: the tax accountant (Japanese Windows) could not open
the June package zip, and filenames showed as mojibake. Root-cause analysis
found three contributing factors; two were operator-side (macOS Finder re-zip
without the zip UTF-8 flag; Mac NFD renames). The third is OURS and latent in
every future export:

`formatYenAmount` (lib/receipts/proofs.ts:39) prefixes every proof filename
with **half-width ¥ (U+00A5)**. That code point **does not exist in CP932**
(Shift-JIS as used by Japanese Windows). When any tool in the accountant's
chain converts the name to CP932, U+00A5 either fails outright or maps to
byte `0x5C` — which Windows treats as a **path separator** — corrupting or
aborting extraction. Full-width **￥ (U+FFE5)** IS in CP932 and is the correct
character for Japanese-facing filenames.

Note the doctrine here: file **content** stays as-is (UTF-8 CSVs/txt with ¥ in
prose are fine — content bytes are never charset-converted by zip tools). Only
**filename-producing** code changes. The filename producers are exactly:
`formatYenAmount` + `sanitizeZipNameSegment` (lib/receipts/proofs.ts), consumed
by `buildProofFilename` (same file) and `buildEvidenceAssignments`
(lib/receipts/reconciliation-files.ts:99). Do NOT touch ¥ in UI components,
お知らせ notice text, notify.ts, format.ts, or docs prose.

Because evidence filenames are computed at export/rebuild time (not persisted
independently in D1), no data migration is needed: the next export or revision
rebuild picks up the new names, and the ZIP entries and the 照合CSV
領収書ファイル名 column both derive from the same function, so they cannot
drift. The hand-fixed June "Windows対応版" package David sent already uses ￥,
so this change converges the system with what the accountant has.

## Part 1 — formatYenAmount

In `lib/receipts/proofs.ts`, change the JPY branch of `formatYenAmount` to emit
`￥` (U+FFE5) instead of `¥` (U+00A5):

```ts
return `￥${amountMinor < 0 ? "-" : ""}${grouped}`;
```

Update the function's JSDoc to say full-width ￥ and WHY (CP932 has no U+00A5;
U+00A5 → 0x5C = Windows path separator). Update the naming-contract examples in
the file-header comments of both proofs.ts (line ~13) and
reconciliation-files.ts (line ~12, ~76) so the documented contract matches the
emitted names.

## Part 2 — NFC-normalize name segments

In `sanitizeZipNameSegment`, normalize before cleaning:

```ts
const cleaned = s.normalize("NFC").replace(ZIP_FORBIDDEN_RE, "").trim();
```

Rationale: merchant strings can arrive NFD (Mac-originated inputs); NFD kana in
zip entry names extract as decomposed on Windows and break string-matching
against the NFC 照合CSV column. One-line hardening, same function, in scope.

## Part 3 — Tests

1. Update existing expectations from ¥ to ￥ in `tests/receipts/proofs.test.ts`
   (lines ~37-40, 76, 91, 227-228) and
   `tests/receipts/reconciliation-files.test.ts` (lines ~59, 86, 113, 132).
   Lines that assert notice/prose text (e.g. proofs.test.ts:148, 151) keep
   half-width ¥ — that's content, not a filename.
2. Add a regression test (proofs.test.ts): assemble a small zip via
   `assembleProofsZip` and assert **no entry name contains U+00A5** and every
   entry name equals its own `.normalize("NFC")`.
3. Add a `sanitizeZipNameSegment` case: an NFD input (e.g. `"セブン"` built as
   `"セブン"`) comes out NFC (`"セブン"`).

## Verification (report results, don't skip)

1. `npm test` — full suite green. (If you see mass esbuild failures after a
   fresh install on the Mac, run
   `npm install --no-save @esbuild/darwin-arm64` — known environment quirk,
   not your change.)
2. `grep -rn $'¥' lib/receipts/proofs.ts lib/receipts/reconciliation-files.ts`
   — remaining hits must be comments/prose only, none in filename-producing
   template literals.
3. Report: files changed, test counts before/after, and paste the new
   regression test's assertion lines.

Commit on the current working branch; do not push.
