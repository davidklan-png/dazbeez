ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Business trips Phase A — schema + backend (ADR 0010)

Read `docs/adr/0010-business-trips-first-class.md` first; it is the
authority. This phase is backend-only: migration, db functions, detection
refactor, CRUD/membership APIs, status sync, tests. NO UI changes (the
trips screen and the settings form field are Phase B).

## 0. Live investigation FIRST (read-only, include output in report)

Suspected defect: detection runs per import and `createBusinessTripReports`
mints new trip UUIDs each run → duplicate candidate trips on re-import.

- `SELECT cardholder_name, start_date, end_date, COUNT(*) c FROM business_trip_reports GROUP BY cardholder_name, start_date, end_date HAVING c > 1;`
- `SELECT status, COUNT(*) FROM business_trip_reports GROUP BY status;`
- Also read the SELECT feeding `realLines` in
  `app/api/receipts/amex/import/route.ts` (~line 264) and report whether
  it returns ALL month lines or only newly inserted ones.

If duplicates exist, list them; do NOT delete anything — the architect
will decide cleanup with the operator.

## 1. Migration `db/receipts/0023_business_trip_receipts.sql`

The `business_trip_report_receipts` table + index exactly as specified in
ADR 0010 D2, plus:

```sql
CREATE INDEX IF NOT EXISTS idx_business_trip_receipts
  ON business_trip_report_receipts(business_trip_report_id);
```

No other schema changes (trip_name/purpose columns already exist; the
homebase setting lives in the key/value `receipt_settings` table and
needs no DDL). Apply to live D1 per the standard workflow.

## 2. Homebase configuration (`lib/receipts/settings.ts`, `lib/receipts/validation.ts`)

- `ComplianceSettings` gains `homebase_signals: string[]`. Storage: JSON
  array string under key `homebase_signals` in `receipt_settings`.
  `parseComplianceSettings`: JSON.parse with fallback to the default on
  missing/corrupt. `updateComplianceSettings` currently stringifies via
  `String(value)` — array values must be JSON.stringify'd; extend the
  boolean special-case into a small serializer.
- Default = the current `TOKYO_SIGNALS` array verbatim (move it to
  `COMPLIANCE_DEFAULTS.homebase_signals`; behavior unchanged until the
  operator edits settings).
- `validation.ts`: `isOutsideTokyo(merchant)` →
  `isOutsideHomebase(merchant, homebaseSignals: string[])`; rename
  `OUTSIDE_TOKYO_SIGNALS` → `REGION_SIGNALS` (unchanged contents, still
  module-level). Update all callers (blockers.ts isIcCardTopUpCandidate
  does NOT use it — verify with grep; the known callers are detection and
  any tests).

## 3. Detection refactor (`lib/receipts/validation.ts`)

`detectBusinessTripCandidates(lines, homebaseSignals, windowDays = 7)`
where `TripableAmexLine` gains `expenseCategoryCode: string | null`.
New clustering rule (ADR 0010 D3 category boost):

- ANCHORS: lines with a location signal outside homebase (as today).
- BOOST: lines where `isBusinessTripEligible(expenseCategoryCode)`
  (lib/receipts/categories.ts — already exists, currently unused) and no
  homebase signal in the merchant join a cluster when within `windowDays`
  of an anchor. They never form a cluster alone — ≥1 anchor required,
  and the ≥2-lines threshold still applies to the whole cluster.
- Cluster date range still derives from ALL member lines.

Import route: extend the `realLines` mapping to carry the category code
and pass `(await getComplianceSettings()).homebase_signals`.

## 4. Detection dedupe (`lib/receipts/db.ts` + import route)

Before `createBusinessTripReports` creates a trip for a candidate, check
for an existing trip with the same `cardholder_name` whose
[start_date, end_date] OVERLAPS the candidate's range and whose status is
'candidate' or 'confirmed'. If found: link the candidate's lineIds to
that trip (INSERT OR IGNORE into business_trip_report_lines, set
`business_trip_id`; set line status 'candidate' only for lines not
already 'confirmed'/'excluded'), and extend the trip's start/end to the
union of the ranges ONLY when status='candidate' (never silently widen a
confirmed trip — report a `widened_skipped` count instead). If not
found: create as today. Extract the overlap decision into a pure helper
for tests.

## 5. Trip CRUD + membership (db functions + routes)

Types (`lib/receipts/types.ts`): `AuditAction` gains
`"business_trip.created" | "business_trip.updated" | "business_trip.confirmed" | "business_trip.rejected" | "business_trip.members_changed"`.

Routes (all `requireReceiptsActor`, audit entry per mutation):

- `GET /api/receipts/trips` — all trips with member counts (lines +
  receipts, two LEFT JOIN counts).
- `POST /api/receipts/trips` — `{ tripName?, startDate, endDate,
  purpose?, primaryLocation?, cardholderName? }`. Validate YYYY-MM-DD
  and startDate <= endDate (400 otherwise). Operator-created trips are
  born `status='confirmed'` (explicit intent; detection-created stay
  'candidate'). cardholderName defaults to NULL — schema requires NOT
  NULL, so default it to the string 'OPERATOR' only if live schema
  rejects NULL; check the CREATE TABLE first and report which branch you
  took.
- `GET /api/receipts/trips/[id]` — trip + members: linked lines (id,
  transaction_date, merchant, amount_minor, statement_month,
  business_trip_status) and linked receipts (id, transaction_date,
  merchant, amount_minor, status, payment_path).
- `PATCH /api/receipts/trips/[id]` — field edits (tripName, startDate,
  endDate, purpose, primaryLocation; same date validation) and/or
  `status: "confirmed" | "rejected"` transitions per ADR D4. Reject a
  transition from 'exported' (409).
- `POST /api/receipts/trips/[id]/members` —
  `{ lineIds?: string[], receiptIds?: string[] }` attach.
  Lines: set `business_trip_id = tripId`; line status = 'confirmed' if
  the trip is confirmed, else 'candidate'. A line already belonging to a
  DIFFERENT trip → 409 listing the conflict (operator detaches there
  first; no silent moves). Receipts: INSERT OR IGNORE into the new link
  table — receipt rows are NEVER written (ADR D2; sealed receipts are
  legal members by construction).
- `DELETE /api/receipts/trips/[id]/members` — same body, detach.
  Lines: `business_trip_id = NULL`, status 'excluded'. Receipts: delete
  the link row.

Status sync (ADR D4) — extract into a pure, tested helper that returns
the line updates to apply: confirm trip → member lines 'confirmed';
reject trip → member lines 'excluded' + `business_trip_id = NULL`
(receipt links survive both).

## 6. Tests

Pure-module coverage per repo convention (no D1 mocks):

- detection: homebase-config parity (default signals reproduce current
  behavior on the existing fixtures), category-boost inclusion (Ekinet
  style: eligible category, no region string, within window of an
  anchor), boost-never-alone, window edges.
- dedupe overlap helper: overlap true/false, union-widening only for
  candidate status.
- status-sync helper: confirm/reject line-update outputs.
- settings: homebase_signals JSON round-trip + corrupt-value fallback.
- trips route validation: date format, start>end, exported-transition
  409, cross-trip line-attach 409 (validation extracted pure, like
  amex-line-patch.ts).

## 7. Verification

`npm test`, `npm run build:cf`, apply migration 0023 (confirm table +
index exist), `npm run cf:dev` boots clean. Live API e2e is Clerk-gated
as usual — exercise the SQL contracts directly (create/attach/detach/
confirm against live D1 with throwaway rows, then delete them; report
the statements you ran).

## Out of scope — do not do

- No UI (trips screen, nav, settings form field, reconcile-strip
  delegation = Phase B). No export artifact or gate changes (Phase C).
- No cleanup of live duplicate trips (step 0 findings go to the
  architect).
- The finalize gate and export CSV are untouched this phase.

## Report back

Step 0 findings verbatim, migration result, which cardholder-NULL branch
step 5 took, test/build results, live SQL-contract outputs, and any
ambiguity you stopped on.
