ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Attendee directory: company + title in the monthly export bundle

## Why

Business manager review comment on the first monthly settlement: every
attendee on a meeting (会議費) / entertainment (接待交際費) row must show
company and title. The pattern to replicate is the one from the original
manual documentation: each row carries attendee ID codes, and a separate
attendee list maps ID → name, company, title.

`lib/receipts/attendee-directory.ts` already holds exactly this data
(66 entries: id, name, company, title) but it is a hardcoded TS array used
only as a datalist in the review form, and neither company/title nor IDs
reach the export.

## Locked design decisions (do not revisit)

1. **Directory moves to D1** (`attendee_directory` table in RECEIPTS_DB),
   seeded from the existing TS array with ids 1–66 preserved. `name` is
   UNIQUE; `company` and `title` are NOT NULL. Registering a new attendee
   becomes a data operation, not a code deploy.
2. **Resolution is by exact name match** against the directory — no FK
   columns on `receipt_attendees` / `amex_line_attendees` in this PR, no
   fuzzy matching. Attendee identity = directory name. (A rename before a
   month is sealed will trip the finalize gate visibly; that is intended.)
3. **Receipts CSV gains an `AttendeeIds` column** immediately after the
   existing `Attendees` column: resolved directory ids joined `"; "` in the
   same order as the names; an unresolvable name emits `?` in its position
   so the two columns stay aligned.
4. **New 7th bundle artifact: attendees CSV** (`参加者一覧`), columns
   `AttendeeId,Name,Company,Title`, containing ONLY directory entries
   referenced by this bundle's rows, sorted by id. It follows the summary
   CSV's precedent exactly: derived R2 key (no new column on
   `receipt_exports`), BOM+CRLF applied in the route, SHA-256 in the
   README, byte-identical copy embedded in the proofs ZIP next to 目次.csv.
5. **Finalize gate extension**: on any row where `requiresAttendees(...)`
   is true, every attendee name (receipt-level AND line-level) must resolve
   to a directory entry. Unresolved name → blocker. Directory rows already
   enforce company/title NOT NULL, so resolution alone proves completeness.
6. **Draft builds do not block** — same doctrine as today: the gate runs
   only on finalize; drafts render `?` ids so the operator can see gaps.

## Implementation

### 1. Migration `db/receipts/0022_attendee_directory.sql`

```sql
CREATE TABLE IF NOT EXISTS attendee_directory (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Seed all 66 rows from `RECEIPT_ATTENDEE_DIRECTORY` in
`lib/receipts/attendee-directory.ts`, preserving ids exactly. Use a fixed
ISO timestamp literal for created_at/updated_at. Run against live D1 with
wrangler per the existing migration workflow.

### 2. `lib/receipts/attendee-directory.ts` (client-safe, pure)

- Keep `ReceiptAttendeeDirectoryEntry`.
- Rename the array to `ATTENDEE_DIRECTORY_SEED` (it remains the seed
  reference and test fixture; runtime reads D1). Update the one importer
  (`components/receipts/review/form-pane.tsx` — see step 5).
- Add a pure resolver used by CSV builder, gate, and tests:

```ts
export function resolveAttendeeNames(
  names: string[],
  directory: ReceiptAttendeeDirectoryEntry[],
): { entries: (ReceiptAttendeeDirectoryEntry | null)[]; unresolved: string[] }
```

  `entries[i]` corresponds to `names[i]` (null = unresolved). Match on
  exact string equality after `.trim()`.

### 3. `lib/receipts/db.ts`

- `listAttendeeDirectory(): Promise<ReceiptAttendeeDirectoryEntry[]>` —
  `SELECT id, name, company, title FROM attendee_directory ORDER BY id`.
- `createAttendeeDirectoryEntry(input: { name; company; title }, actor)` —
  INSERT (omit id; SQLite assigns rowid > 66), trim inputs, reject empty
  strings, write a `createAuditEntry` with action
  `"attendee_directory.created"`. Return the new entry.

### 4. API route `app/api/receipts/attendee-directory/route.ts`

- `GET` → `{ entries: [...] }`, auth via `requireReceiptsActor` like the
  other receipts routes.
- `POST` `{ name, company, title }` → 400 on missing/empty fields, 409 on
  UNIQUE violation (surface "already registered"), else 200 with the entry.

### 5. Review UI registration flow

- `components/receipts/review/form-pane.tsx`: drop the static import;
  fetch `GET /api/receipts/attendee-directory` (client-side, on mount) and
  pass entries to `AttendeeEditor` as today via the `directory` prop.
- `components/receipts/attendee-editor.tsx`: keep the free-text +
  datalist input. When a non-empty typed name has no exact directory
  match, render beneath that row: Company input, Title input, and a
  "Register attendee" button that POSTs to the API, then adds the new
  entry to the local directory list. Show the resolved
  `company — title` as small helper text under rows whose name matches,
  so the operator can see resolution state at a glance. Keep the existing
  bee-theme styling conventions.

### 6. Bundle assembly `lib/receipts/month-closing.ts`

- `ExportBundle` gains `attendeeDirectory: ReceiptAttendeeDirectoryEntry[]`;
  `buildExportBundle` loads it via `listAttendeeDirectory()` (single load
  point — route and validator both consume the bundle).
- `ExportBundle` also gains `amexAttendees: Record<string, string[]>`
  (move the `listAmexLineAttendeeNamesByMonth(month)` call from
  `validateMonthReadyForExport` into `buildExportBundle`; the validator
  input keeps working from the bundle field). Rationale: the CSV must now
  also see line-level attendees (see step 7) and the bundle is the single
  row-assembly authority (audit A4).

### 7. Receipts CSV `lib/receipts/export.ts`

- `buildMonthlyExportCsv` signature gains the directory and line
  attendees: `(rows, attendeeMap, attendeeDirectory, amexAttendees)`.
- Attendee-name resolution per row becomes: receipt attendees from
  `attendeeMap` (as today), and for `amex_line` rows with NO receipt
  attendees, fall back to `amexAttendees[row.lineId]` — this closes the
  existing gap where line-level attendees satisfy the gate but vanish
  from the CSV. The `Attendees` column shows the same names it shows
  today plus that fallback.
- New header `"AttendeeIds"` inserted directly after `"Attendees"`;
  value from `resolveAttendeeNames` per decision 3 (`"; "`-joined, `?`
  for unresolved), `csvQuoteAlways`.
- New builder:

```ts
export function buildAttendeesExportCsv(
  referencedNames: string[],
  directory: ReceiptAttendeeDirectoryEntry[],
): string
```

  Header `AttendeeId,Name,Company,Title`; rows = unique resolved entries
  referenced by the bundle, sorted by id; `csvEscape` every cell (names
  contain commas in Japanese punctuation contexts). Callers pass the
  union of all attendee names across rows.
- New key builder `buildAttendeesKey(month, exportId)` →
  `exports/${month}/${exportId}-attendees.csv`.
- `EXPORT_DOWNLOAD_FILES`: add `"attendees"`; `resolveExportDownload`
  gains the case (derived key like `summary`, filename
  `export-<month>-attendees.csv`, csv content type).
- `buildExportReadme`: add optional `attendeesSha256`, printed as
  `Attendees CSV SHA-256:` after the summary line, plus one sentence in
  the "Files included" section: the attendees CSV maps the AttendeeIds
  column to name/company/title (mirror the existing proofs-ZIP sentence
  style, EN only like its neighbors).

### 8. Finalize gate

- `validateMonthReadyForExportCore` receipt loop: after the existing
  `requires attendees` check, when attendees ARE present, run
  `resolveAttendeeNames`; each unresolved name pushes
  `Receipt <label>: attendee "<name>" is not registered in the attendee
  directory (company/title required)`.
- `validateAmexLinesForSignoff` gains a 5th parameter
  `attendeeDirectory: ReceiptAttendeeDirectoryEntry[]` and applies the
  same check to the union of linked-receipt attendees and direct line
  attendees on rows where `requiresAttendees(resolvedCategory)`. Update
  both call sites (`month-closing.ts`, `app/api/receipts/reconcile/finalize/route.ts` —
  the finalize route loads the directory via `listAttendeeDirectory()`).

### 9. Export route `app/api/receipts/export/month/route.ts`

- Pass the new args into `buildMonthlyExportCsv`.
- Build the attendees CSV (pure → `bomPrefixedCrlf` → `hashCsvContent`),
  upload to `buildAttendeesKey(month, exportId)` with csv content type +
  `retentionMetadata()`, mirroring the summary block.
- `assembleProofsZip` in `lib/receipts/proofs.ts` gains a 5th parameter
  `attendeesCsv: string` embedded at the ZIP root as `参加者一覧.csv`
  (next to 集計.csv — same shipped bytes as the standalone artifact).
- README call gets `attendeesSha256`; JSON response gains `attendeesKey`
  and `attendeesSha256`.
- The 目次.csv 出席者 column and proof filename logic are unchanged.

### 10. Export page `app/(receipt-system)/receipts/export/page.tsx`

Add `{ file: "attendees", label: "参加者一覧" }` to
`BUNDLE_DOWNLOAD_LINKS` (no gating — same treatment as summary; old
sealed revisions simply 404 from R2 like pre-summary bundles do).

### 11. Tests (`npm test` — tsx --test)

- New `tests/receipts/attendee-directory.test.ts`: resolver (exact match,
  trim, unresolved, positional alignment) and `buildAttendeesExportCsv`
  (referenced-only, id sort, dedupe, escaping).
- `tests/receipts/export.test.ts`: AttendeeIds column position + `?`
  behavior; line-attendee fallback row; README lines; download resolution
  for `"attendees"`.
- `tests/receipts/month-closing.test.ts`: unresolved-attendee blocker on a
  CASH/DIGITAL receipt; resolved names pass.
- `tests/receipts/reconciliation-signoff.test.ts`: new parameter — update
  existing calls; add unresolved line-attendee blocker case.
- `tests/receipts/proofs.test.ts` / `bundle-download.test.ts`: new
  assembleProofsZip param; `attendees` file resolution.

## Verification (Mac, live bindings)

1. `npm test` and `npm run build:cf` pass.
2. Apply migration 0022 to live D1; confirm
   `SELECT COUNT(*) FROM attendee_directory` = 66.
3. Data audit — run and INCLUDE THE OUTPUT in your report (do not fix
   mismatches yourself):
   `SELECT DISTINCT attendee_name FROM receipt_attendees WHERE TRIM(attendee_name) NOT IN (SELECT name FROM attendee_directory);`
   and the same for `amex_line_attendees.attendee_name`.
4. `npm run cf:dev`: rebuild the draft for the settled month; confirm the
   receipts CSV shows AttendeeIds, the attendees CSV downloads, and the
   proofs ZIP contains 参加者一覧.csv with matching bytes.
5. Register a throwaway directory entry via the review UI, confirm it
   persists and resolves, then delete it from D1.

## Out of scope — do not do

- No FK columns on `receipt_attendees` / `amex_line_attendees`.
- No write path for `amex_line_attendees` (read-only fallback stays).
- No re-finalize of the settled month — the operator triggers the
  revision after reviewing your report (correction reason: "Add attendee
  company/title per business manager review").
- No edit/delete UI for directory entries.

## Report back

What changed (files + migration), test results, build:cf result, the
step-3 mismatch query output, cf:dev observations, and anything ambiguous
you stopped on.
