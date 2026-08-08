ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Phase B — automated monthly delivery (server side)

Decisions D1–D14, O3, O6, O7 in `docs/2026-06-pack-approved-delta.md` §15–16.
Post-merge lessons in `docs/2026-08-07-phase-a-verification.md`. Read both.

**Scope: server side only.** The approval/confirmation UI and the pack preview
screen are Phase C. Phase B exposes endpoints + pure logic with full test coverage.
Do not build UI.

**Commit architect-authored doc/prompt changes as your FIRST action.** Branch with
`git checkout -b feature/monthly-delivery-send origin/master`.

---

## Read this before you write a line

PR #160 shipped three defects with one shape: **a value that was correct inside its
module and invalid where it crossed a boundary.** Non-ASCII in an HTTP header
ByteString; an `await` outside an error boundary after a seal; a live read against
mutable state for a sealed artifact.

Phase B is almost entirely boundary work — an HTTP call to a third party, a state
transition around a seal, a size ceiling, a retry with ambiguous failure. **When you
write a value that crosses a boundary, check that boundary's constraints as you write
it.** Do not defer it to review. Constraints are stated inline below; treat them as
requirements, not notes.

---

## What exists already

- `lib/receipts/notify.ts` — Resend transport (`sendViaResend`), recipient resolution
  (Settings `notification_recipient` → `ACCOUNTANT_EMAIL` → unconfigured),
  `composeFinalizeNoticeData` (async; now inside the non-blocking try/catch per
  `3067f02`). Today it sends a **summary + link**, single recipient, no attachment.
- `lib/receipts/pack-preflight.ts` — 18 checks, pure, **not wired to anything**.
- `buildPackNotice(input, names)` — accepts an optional `operatorMessage`, omitted when
  empty. Phase B supplies it.
- `receipt_exports.payment_due_date` — snapshotted at bundle build (migration 0035).

---

## Change 1 — delivery state machine (D2)

**D2 says "send failure is finalize failure." Do NOT implement this as a rollback.**
R2 archival, D1 state and a third-party API cannot share a transaction, and a sent
email cannot be recalled. Implement as state:

```
draft → sealed → delivered
              ↘ sealed_undelivered   (retryable; month NOT closed)
```

The sealed artifact is immutable and always survives. Only the *month-closed* status
waits on delivery. A failed send must never destroy a valid seal.

### Critical: sealing and closing are different things

**Do NOT make edit-locking depend on delivery.** `loadSealedExportMonths`
(`membership.ts:44`) and the finalized-reconciliation edit guard stay exactly as they
are, keyed on the seal. If a failed send unlocked a sealed month, its contents could
change between attempts and a retry would send different bytes than the first attempt
— silently. Seal locks edits; delivery closes the month for reporting. Report back if
you find a place where these are currently conflated.

### Schema

New migration. A separate table, not columns on `receipt_exports` — retries need
attempt history and the idempotency key is per-attempt:

```sql
CREATE TABLE export_deliveries (
  id TEXT PRIMARY KEY,
  export_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,        -- one per operator-initiated send; reused by automatic retries
  idempotency_key TEXT NOT NULL,   -- derived from attempt_id; stable across retries of that attempt
  state TEXT NOT NULL,             -- 'pending' | 'sent' | 'failed'
  to_address TEXT NOT NULL,
  cc_address TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,              -- the exact assembled text sent (D5)
  operator_message TEXT,           -- the free-text portion alone (O7)
  zip_filename TEXT NOT NULL,
  zip_sha256 TEXT NOT NULL,
  zip_bytes INTEGER NOT NULL,
  provider_message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
```

Plus a denormalised `delivery_state` on `receipt_exports` for list queries, written in
the same transaction as the `export_deliveries` row.

**Additive only.** Pre-existing exports read as NULL / not-delivered.

---

## Change 2 — send (D1, D3) and its boundaries

Send fires **strictly after the seal transaction commits**, never inside it, and only
after an explicit confirmation call. Ordering: approve copy → finalize → seal commits →
`POST /api/receipts/export/{month}/send`.

### Boundary constraints — implement these, don't discover them

**B-1 Attachment size.** Base64 inflates ~33%. Resend's per-request payload ceiling is
~40 MB. Check `zip_bytes` **before** encoding and fail loudly with the actual size and
the ceiling if over. Put the ceiling in a named constant (Phase C reads it from
settings). Never truncate, never silently fall back to a link. June is ~6 MB / 33
receipts, so the working headroom is real but finite.

**B-2 Worker memory/CPU.** The ZIP bytes plus their base64 both sit in memory. Confirm
headroom and report measured peak for the June-sized pack. Paid plan: 128 MB,
30s CPU/request.

**B-3 Idempotency.** A network timeout on the response is **ambiguous** — the mail may
have been accepted. Send `Idempotency-Key` on the Resend request, derived from
`attempt_id`. The key is **stable across automatic retries of the same attempt** and
**new for each operator-initiated send**. Do not derive it from the body — that would
defeat the D6 guard. Record `provider_message_id` on success.

**B-4 Header/encoding.** The subject may contain Japanese. Resend takes UTF-8 JSON and
handles MIME encoding, but **verify against a real send** rather than assuming, and
report what arrived. The attachment filename is ASCII by design
(`202606_Dazbeez_Monthly_Expense_Report.zip`) — assert that and fail if it ever is not.
If the body is sent as HTML, escape the operator message; if text, ensure no
transformation. This is the `Content-Disposition` lesson from #160 in a new place.

**B-5 No live lookups for sealed state.** Every value in the email — filenames, counts,
totals, payment date — comes from the sealed export record and its artifacts, never
from current month state. `payment_due_date` is on `receipt_exports` (0035) for exactly
this reason. ADR 0009.

---

## Change 3 — preflight as a hard pre-send gate (O6)

Run `pack-preflight` against the **actual sealed artifact bytes** — fetch the ZIP from
R2, parse the entries and CSVs from it — not against a re-derivation from D1. A gate
that checks a different object than the one being sent is not a gate.

Any failing check **blocks the send**. Return the itemised report to the caller so
Phase C can render it. Record the report on the delivery row when a send is blocked.

---

## Change 4 — email body (D4, D14, O7)

**One message, two surfaces.** The operator writes the message once. It is injected
into both:

1. the email body, and
2. 【今月のご連絡】 in `{yyyymm}_ご連絡事項.txt` inside the pack.

**Ordering consequence — think this through and report your approach.** The notice
lives *inside the sealed ZIP*, so the operator message must be captured **before the
pack is built**, while the email body is assembled **at send**. Both must come from
one stored value. Suggested: persist the operator message on the export record at
approval time; the pack build reads it; the send reads the same row. Do not let the
two surfaces be authored or stored separately.

Body = auto-generated summary **regenerated at send from the sealed pack** + the
operator message. The summary must never be a stale copy captured at approval time
(D4). No revision info anywhere in accountant-facing copy (O2) — a re-delivery reads
as a fresh delivery; supersession is the operator's message to write.

Recipients: **To** accountant, **Cc** business manager. Both from Settings. One
artifact for all recipients — no per-recipient variants.

---

## Change 5 — guards (D6, O3, D7)

**Double-send guard** keyed on `yyyymm`: refuse a second send for a month that already
has a `sent` delivery, unless the caller passes an explicit override flag. The override
must be a distinct parameter — not a boolean buried in a payload — and must write an
audit entry naming the operator and the prior delivery id.

The June 2026 re-delivery (D17) is the first real use of this override: a corrected
pack for a month already delivered.

**D7 recipient settings:** when `notification_recipient` (or the new Cc setting) is
edited, return a message stating that this address receives the monthly pack
automatically on finalize and that the field is audited. Write the audit entry.

---

## Reverse the old hard rule

`notify.ts:11-14` states email failure must never fail finalize. That was correct when
the email was a *notification* backed by a durable link. It is now the delivery.
Replace the comment and the behaviour per D2: finalize still returns 200 and the seal
stands, but the month lands in `sealed_undelivered` with a visible, retryable failure
rather than a swallowed warning.

Keep the existing `sendFinalizeNotification` seam and its mockability.

---

## Tests

`npm test` (tsx --test — **not vitest**).

- state machine: every transition, including retry from `sealed_undelivered`; assert a
  failed send never mutates the sealed artifact or the seal's edit lock
- idempotency: same `attempt_id` → same key across retries; new operator send → new key
- size ceiling: a pack over the limit fails **before** base64 encoding, with the real
  numbers in the error
- preflight gate: a pack failing any one check is refused; the report is returned
- one-message-two-surfaces: the string in 【今月のご連絡】 and the string in the email
  body come from the same stored value and cannot diverge
- summary freshness: a summary regenerated at send reflects the sealed pack, not the
  approval-time snapshot
- double-send: blocked without override; allowed with it; audit entry written
- no accountant-facing copy contains revision info
- attachment filename asserted ASCII

Mock the Resend transport at the existing seam. Do **not** send real mail from tests.

## Verification

1. `npx tsc --noEmit` clean, `npm test` green, `npm run build:cf` green (Node 22)
2. `npm run cf:dev` against live bindings
3. **One real send to David's own address only** — never to the accountant or the
   business manager. Report: what arrived, whether the Japanese subject rendered,
   whether the attachment opened, measured peak memory, and the `provider_message_id`.
4. **Do not send anything for 2026-06.** That month's re-delivery is a separate
   operator decision (D17) and must not be triggered by testing.
5. Do not deploy or merge.

## Report back

- Migration SQL and how `delivery_state` stays consistent with `export_deliveries`
- Where you placed the send relative to the seal commit, and why it cannot run inside it
- How the operator message is stored once and read by both surfaces
- Your answers to B-1 through B-5, each with the check you wrote
- Any place where seal-lock and month-closed were conflated
- Test count before/after
- Anything you had to decide that this prompt did not cover
