# ADR 0010 — Business trips as first-class, operator-managed entities

Status: PROPOSED (operator review pending)
Date: 2026-07-17
Author: Architect session
Supersedes: nothing (extends the import-time detection shipped in 0005_amex_extended)

## Context

Business trips today are an import-time side effect, not a managed object:

- `detectBusinessTripCandidates` (lib/receipts/validation.ts) clusters a
  cardholder's outside-Tokyo AMEX lines (merchant-string heuristic:
  hardcoded `TOKYO_SIGNALS` negative list, `OUTSIDE_TOKYO_SIGNALS`
  positive list, ≥2 lines within a 7-day window) into candidates.
- `createBusinessTripReports` writes `business_trip_reports` (status
  'candidate') + `business_trip_report_lines` and flags lines
  `business_trip_status='candidate'`.
- The ONLY operator interaction is the per-line amber strip on the
  reconcile screen (Confirm/Exclude → PATCHes the LINE status). Nothing
  ever updates the trip report row: `trip_name` and `purpose` are
  permanently NULL, trip status stays 'candidate' forever, and the
  'exported' status value has no writer. The export month review page
  lists trip reports read-only.
- Receipts cannot belong to a trip at all — membership is lines-only, so
  CASH/DIGITAL trip expenses (e.g. a cash-paid 駅弁 or local taxi) have
  no trip linkage.
- `expense_categories.default_business_trip_eligible` is seeded (0006)
  but read by zero application code.

Operator requirements (2026-07-17):

1. "Tokyo" really means HOMEBASE. Charges at homebase are normal
   operations; multiple charges outside homebase indicate a trip —
   especially when accompanied by hotel / train / airplane / car
   charges.
2. A dedicated screen to REGISTER a trip spanning chosen dates, then
   SELECT the related charges. Critically: prebooking is often charged
   BEFORE the trip dates and service providers may charge AFTER,
   spanning multiple statement months. Trip dates describe the trip, not
   the charge window.
3. Month close must not wait for this feature. June 2026 is being closed
   now and contains trip charges (Ekinet, hotel, Odawara) that must be
   attachable to a trip retroactively — after their month is sealed.

Requirement 3 is the architectural forcing function: sealed months are
immutable (ADR 0009), so trip membership must be modeled as an overlay
that never mutates receipt or line rows that a sealed export shipped.

## Decisions

### D1. Trips become operator-managed; detection demotes to suggestion

Full CRUD on `business_trip_reports`: create (name, start/end dates,
purpose, primary location, optional cardholder), edit, confirm, reject.
Import-time detection is kept but produces SUGGESTIONS only (status
'candidate', as today) and must first check for an existing trip whose
date range overlaps the same cardholder's cluster — if one exists it
links new lines to that trip instead of creating a duplicate.

Known defect folded into this work: detection runs on every import over
the month's lines, and `createBusinessTripReports` mints new trip UUIDs
each time — re-importing a statement can create duplicate candidate
trips. The overlap-dedupe above fixes this class. Worker must verify the
current duplicate behavior on live data and report before migrating.

### D2. Membership = lines AND receipts, date-unconstrained, overlay-only

New link table mirroring the existing lines one:

```sql
CREATE TABLE IF NOT EXISTS business_trip_report_receipts (
  id TEXT PRIMARY KEY,
  business_trip_report_id TEXT NOT NULL
    REFERENCES business_trip_reports(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (business_trip_report_id, receipt_id)
);
```

Rules:

- Membership writes touch ONLY link tables (+ `business_trip_id` /
  `business_trip_status` on lines, which the sealed-export CSV snapshot
  already captured at seal time — changing them later does not alter any
  sealed artifact). Receipt rows are never written. Therefore attaching
  a sealed-month receipt to a trip is legal by construction — no
  conflict with the exported-receipt guard or ADR 0009. This is what
  lets June close now and gain trip linkage later.
- NO date constraint on membership. The picker UI defaults its charge
  list to trip dates ±45 days across month boundaries, with search and a
  "show all" escape — prebooking/post-charging is the norm, not the
  exception.
- Receipts get NO new status column. A receipt's trip relationship is
  membership alone; lines keep `business_trip_status` because the
  finalize gate and the export CSV already consume it.

### D3. Homebase is configuration, not a hardcoded city

- `ComplianceSettings` gains `homebase_signals: string[]` (default = the
  current `TOKYO_SIGNALS` list) editable in Settings → Compliance.
  `isOutsideTokyo` → `isOutsideHomebase(merchant, homebaseSignals)`; the
  broad `OUTSIDE_TOKYO_SIGNALS` region list is retained as the positive
  signal set (rename `REGION_SIGNALS`). Defaults reproduce today's
  behavior exactly — zero behavior change until the operator edits
  settings.
- Category boost (finally uses `default_business_trip_eligible`): a
  line/receipt whose expense category is trip-eligible (travel,
  business_trip; hotel/train/air/car charges) joins a cluster within the
  window even when its merchant string carries no location signal.
  Rationale: Ekinet/airline/hotel-chain merchants often bill without a
  region string; today they silently fall out of clusters.

### D4. Status lifecycle gets an owner and sync rules

- Transitions (trip screen is the owner): candidate → confirmed |
  rejected. 'exported' is set only by Phase C export integration.
- Confirming a trip sets member lines `business_trip_status='confirmed'`;
  rejecting sets them 'excluded' and clears `business_trip_id`.
  (Receipt members: membership rows survive; there is no receipt status.)
- The reconcile amber strip DELEGATES when the line belongs to a trip:
  Confirm/Exclude there confirm/reject the whole trip (with a link to
  the trip screen). Lines with no trip keep today's line-only behavior.
  This fixes the current orphan state where lines get confirmed but trip
  rows stay 'candidate' forever.
- Finalize gate: UNCHANGED (line-level 'candidate' blocks, as today).
  A candidate trip overlapping the month becomes a non-blocking WARNING
  on the export page. No new hard gates.

### D5. Export integration is Phase C and never retroactive

A per-trip 出張報告 (trip report) artifact joins the bundle of the month
containing the trip's END date: trip name, dates, purpose, member
charges — cross-month members are listed as references (their No +
month), not re-shipped. Sealing that month sets the trip 'exported'.
Sealed months never gain artifacts retroactively; a trip whose anchor
month is already sealed ships in the next finalized month's bundle with
its anchor month noted. Exact artifact format to be specced with the
accountant's input at Phase C — do not build speculatively.

## Screen (Phase B): /receipts/trips

- List view: candidate / confirmed / all tabs; each card shows name (or
  "(unnamed trip)"), dates, location, cardholder, member count, status.
- Detail view: editable fields (name, dates, purpose, location);
  member table (lines + receipts, cross-month, with month + amount +
  merchant); Add charges picker per D2; Confirm / Reject actions per D4.
- Nav entry beside Reconcile. Bee-theme conventions.

## API surface (Phase A)

- `GET/POST /api/receipts/trips` — list (with member counts) / create.
- `GET/PATCH /api/receipts/trips/[id]` — detail (members resolved) /
  edit fields + status transitions.
- `POST/DELETE /api/receipts/trips/[id]/members` — attach/detach
  `{ lineIds?: string[], receiptIds?: string[] }`.
- All via `requireReceiptsActor`; every mutation writes an audit entry
  (`business_trip.created|updated|confirmed|rejected|members_changed` —
  new AuditAction values).

## Phasing (one worker prompt each)

- **Phase A — schema + backend.** Migration 0023 (receipts link table,
  settings), db functions, homebase/config refactor + category boost +
  detection dedupe (incl. live duplicate-trip investigation), trip CRUD
  + membership APIs, status sync, unit tests. No UI.
- **Phase B — trips screen** + reconcile-strip delegation + nav.
- **Phase C — export artifact** + candidate-trip export warning +
  month-close runbook update.

## Consequences

- June 2026 closes on the current schedule; its Ekinet/hotel/Odawara
  receipts attach to a registered trip after Phase A with zero touch to
  the sealed bundle.
- Homebase config means a future homebase change (or a second cardholder
  based elsewhere) is a settings edit, not a code change.
- Trip data finally has an owner: the trip screen. The reconcile strip
  stops being a dead-end that leaves trip rows permanently 'candidate'.
- The export CSV's BusinessTripStatus column becomes meaningful for
  confirmed trips; the accountant-facing trip artifact lands in Phase C
  without blocking A/B.
- Risk accepted: name-based homebase heuristics remain imperfect;
  the design compensates with easy manual registration rather than
  chasing heuristic perfection.
