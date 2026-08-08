ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Business trips Phase B — trips screen, strip delegation, homebase field (ADR 0010)

Authority: `docs/adr/0010-business-trips-first-class.md` (committed,
857810d). Phase A backend is live (merge f639f19). This phase is the UI
plus ONE small backend addition (the picker endpoint). Follow the
existing receipts UI conventions (server page loads via db functions →
client screen component; Btn/Pill/Card/Field components; bee theme).

## 1. Picker endpoint (backend addition)

`GET /api/receipts/trips/[id]/candidates?window=45&q=<search>&all=false`
(requireReceiptsActor). Returns charges attachable to the trip:

- AMEX lines and receipts whose transaction_date falls within
  [trip.start_date − window, trip.end_date + window] (cross-month by
  construction), EXCLUDING current members of THIS trip.
- Lines already owned by a different trip are INCLUDED but flagged
  (`ownedByTripId`) so the UI can show why attach will 409.
- `q` filters merchant (LIKE, case-insensitive); `all=true` drops the
  date window (the "show all" escape in ADR D2).
- Response rows carry: kind ('line'|'receipt'), id, transactionDate,
  merchant, amountMinor, currency, month (statement_month for lines /
  export_statement_month or calendar month for receipts), status
  (line match_status / receipt status), ownedByTripId (lines only).
- db function `listTripAttachCandidates` in lib/receipts/db.ts; keep the
  window/date arithmetic in a pure helper in lib/receipts/business-trips.ts
  with unit tests (month-boundary spans, window edges, exclusion of
  members).

## 2. Trips list page — `/receipts/trips`

- Nav: add `{ href: "/receipts/trips", label: "Trips" }` to `NAV` in
  components/receipts/receipt-shell.tsx, between Reconcile and Export.
- Server page loads `listBusinessTripsWithCounts`; client screen renders
  tabs (Candidates / Confirmed / All — rejected only under All), cards
  per ADR: name (fallback "(unnamed trip)"), start–end dates, primary
  location, cardholder, member counts (N lines · M receipts), status
  Pill (candidate=amber, confirmed=green, rejected=gray, exported=blue).
- "Register trip" form (inline card or top section, not a modal): start
  date + end date (required, native date inputs), name, purpose,
  location (optional). POSTs /api/receipts/trips; on success navigate to
  the new trip's detail page. Surface 400 validation errors inline.

## 3. Trip detail page — `/receipts/trips/[id]`

- Server page loads `getBusinessTripWithMembers`; 404 page if absent.
- Header: editable fields (name, dates, purpose, location) with a Save
  button → PATCH; status Pill; Confirm / Reject buttons per status
  (candidate shows both; confirmed shows Reject; rejected shows
  Confirm; exported shows neither + a "sealed in export" note). Reject
  asks for confirmation (member lines become 'excluded' — say so in the
  confirm text).
- Members table: lines and receipts mixed, sorted by transactionDate;
  columns date / merchant / amount / month / kind / status; a "sealed"
  gray Pill on receipts whose status is exported|archived (attachable
  and detachable — membership is an overlay, ADR D2 — the pill is
  informational only). Per-row Detach button → DELETE members.
- "Add charges" section: fetches the candidates endpoint; search box
  (q), window indicator ("±45 days around trip dates"), "Show all"
  toggle; checkbox multi-select; Attach button → POST members. Rows
  flagged ownedByTripId render disabled with a link to the owning trip
  (the 409 explanation, pre-empted in UI). After attach/detach, refresh
  members + candidates.

## 4. Reconcile strip delegation

In components/receipts/reconcile/reconcile-screen.tsx, the amber
business-trip strip (line.business_trip_status === "candidate"):

- If `line.business_trip_id` is set: strip shows the trip's date range +
  a link to `/receipts/trips/<id>`, and Confirm/Exclude become
  "Confirm trip" / "Reject trip" calling PATCH
  /api/receipts/trips/[id] { status } — confirming/rejecting the WHOLE
  trip (Phase A status sync updates all member lines). Fetch the trip
  summary lazily (single GET per strip render is fine at this scale).
- If `business_trip_id` is NULL (legacy/edge): keep today's per-line
  PATCH behavior unchanged.

## 5. Homebase settings field

components/receipts/ComplianceSettingsForm.tsx: add a field for
`homebase_signals` — textarea, one signal per line, mapped to/from the
array; helper text "Merchant name fragments that indicate homebase
(charges here never anchor a business trip)". Remove the Phase A
type-only `Exclude<>` workaround on LABELS now that the field exists.
Settings PATCH path already serializes arrays (Phase A).

## 6. Tests

- Pure: picker window/date helper (boundaries, cross-month, member
  exclusion, all=true).
- Existing suites must stay green; update any snapshot-ish assertions
  the nav addition touches.
- UI logic that can be extracted pure (e.g. candidate-row disable
  reason, tab filtering) follows the repo's pure-extraction pattern —
  do not add jsdom/Testing Library.

## 7. Verification

`npm test`, `npm run build:cf`, `npm run cf:dev` boots clean. The
authenticated UI flows are Clerk-gated locally as usual — after your
report the operator will validate on prod by registering the real June
trip (Ekinet / hotel / Odawara receipts, which are sealed — the picker
and attach must handle them per ADR D2). Commit → PR → merge → deploy →
smoke test, same flow as Phase A (no architect-file first-commit needed
this time unless the tree shows one).

## Out of scope

- Export artifact, candidate-trip export warning, runbook update
  (Phase C). No gate changes. No detection changes.

## Report back

PR/SHA/deploy results, test counts, cf:dev result, screenshots optional,
and any ambiguity you stopped on — especially anything about the picker
response shape you had to adjust.
