# Error-Surfacing Audit — 2026-07-05

**Scope:** `app/api/**`, `lib/receipts/**`, `components/receipts/**`,
`scripts/receipts-consumer/**`, queue / launchd config.

**Method:** every `catch` / `except` / `.catch(() => …)` whose body continues
without surfacing. Severity class:

| Class | Meaning |
|---|---|
| **A** | Silent data loss possible (the incident class — row drifts, R2 orphans, message dropped without trace). |
| **B** | Silent wrong answer shown to the operator (stale/default data appears authoritative). |
| **C** | Benign best-effort (acceptable, documented here). |

**Headline counts:** A = **4**, B = **6**, C = **5**. Total = **15** findings.

---

## Severity A — silent data loss possible

| # | Where | What fails | Today | Backlog? |
|---|---|---|---|---|
| A1 | `app/api/receipts/upload/route.ts:132-134` | `receipt_files` manifest write after R2 put + D1 receipt insert | `console.error` only; receipt row exists, file row never appears → 15 orphans on 2026-07-04 | **#5** (already on backlog) |
| A2 | `app/api/receipts/reconcile/finalize/route.ts:144-158` | (a) delete draft reconciliation row, (b) delete R2 archive object on finalize | `.catch(() => {})` on both — no log, no metric. D1 drafts leak; archive bucket accumulates orphans | new |
| A3 | `lib/receipts/db.ts:1100-1118` (`purgeFailedAmexArtifactsByHash`) | R2 delete of AMEX-import artifacts after purge decision | `console.error` per-object; D1 purge proceeds regardless → R2 orphans if Worker can't reach R2 mid-purge | new |
| A4 | Cloudflare Queue (`dazbeez-receipts-extraction`) — no DLQ | 4xx is ack'd (good, by design in `consumer.py:447-450`); 5xx stays unacked for redelivery; consumer crash mid-batch loops the same batch forever | Stuck messages invisible to operator until they notice a `captured` receipt never advancing | **#9** (already on backlog) |

---

## Severity B — silent wrong answer shown to operator

| # | Where | What fails | Today | Backlog? |
|---|---|---|---|---|
| B1 | `app/(receipt-system)/receipts/capture/page.tsx:43-53` (`countCapturedToday`) | D1 count query throws | Returns `0`; capture page renders "0 receipts today" regardless of true count | new |
| B2 | `app/api/receipts/compliance/[month]/route.ts:28-41` | Per-receipt compliance check throws | Empty `catch` — receipt either skipped or marked non-compliant; report totals are wrong | new |
| B3 | `app/api/receipts/amex/import/route.ts:278-288` | Trip-detection helper throws | `console.error` only; import proceeds without trip flags → fewer trips surface in reconcile view | new |
| B4 | `app/api/receipts/[id]/route.ts:270-278` (PATCH) | Compliance recompute on field change throws | `console.error` only; UI shows stale compliance state until next successful recompute | new |
| B5 | `scripts/receipts-consumer/consumer.py:218-219` (`_parse_structured_output`) | MLX emits malformed JSON in structured-output block | `except json.JSONDecodeError: pass` — fields (merchant, amount, date, tax, IRN…) silently dropped; receipt reaches `needs_review` with empty sidebar and operator can't distinguish "no data on receipt" from "parser failed" | new |
| B6 | `lib/receipts/queue.ts:51-61` + `app/api/receipts/upload/route.ts:151-153` | `enqueueExtractionJob` returns `false`; caller sets `extraction_state='captured'` and emits `console.error` | Receipt row stays at `captured` extraction state forever; operator sees "pending" with no error. Recoverable only by manual `--backfill` run | **#9**-adjacent |

---

## Severity C — benign best-effort (documented, no action)

| # | Where | What | Why acceptable |
|---|---|---|---|
| C1 | `lib/receipts/trusted-devices.ts:178-188, 425-436` | Fire-and-forget `last_seen_at` update on each device-auth: `.catch(() => {})` | Stale timestamp drift on telemetry only; auth decisions don't depend on it. |
| C2 | `lib/receipts/extraction.ts:498-512` | Vision `response.json().catch(() => ({}))` | The empty object falls into the next branch which throws a real "no OCR text" error → surfaced as 422 → consumer acks as permanent failure (visible `[drop]` log line). Not actually swallowed. |
| C3 | `scripts/receipts-consumer/consumer.py:398, 437` | `os.unlink(image_path)` `except OSError: pass` (×2 — backfill + main loop) | Temp file leak only; no data loss; `/tmp` cleared on reboot. |
| C4 | `scripts/receipts-consumer/com.dazbeez.receipts-consumer.plist:37-40` | `StandardOutPath` / `StandardErrorPath` write to `/tmp/dazbeez-receipts-consumer.{err.,}log` with no rotation | No `RotateLogFile` key, no newsyslog entry. `/tmp` is cleared at boot so the log self-truncates, but a long-running uptime could grow it unbounded and a reboot loses incident forensics. |
| C5 | `app/api/receipts/upload/route.ts:108-110` | R2 cleanup after D1 insert failure — `console.error` only | The D1 insert has already failed (the user-visible transaction is rolled back); an orphaned R2 object here is recoverable via the existing AMEX purge / orphan-sweep path. Lower-likelihood instance of A3. |

---

## Top 3 by risk

1. **A1 — manifest write swallowed on upload** (`receipt_files` row). Already
   backlogged as #5 because it materially caused the 15-orphans incident on
   2026-07-04. The chosen remediation (fail loudly vs. reconcile-job heal) is
   still an open design decision.

2. **A2 — finalize cleanup `.catch(() => {})`**. Reconciliation finalize is
   *the* point of no return for a month-close. Silently dropping the draft-row
   + archive-object cleanup means D1 and R2 drift out of sync exactly when the
   operator believes the month is sealed.

3. **B5 — MLX structured-output parse failure silently drops fields**. This is
   the consumer-side twin of the middleware incident: it doesn't lose the
   receipt, but it loses the *parsed* receipt and gives the operator no signal.
   Will likely be invisible until an operator notices a receipt that "should
   have parsed" with an empty sidebar.

---

## Infra gaps

### Gap 1 — no DLQ on the extraction queue

- **Queue:** `dazbeez-receipts-extraction` (1 producer, 1 HTTP pull consumer
  per `wrangler queues list`).
- **Config:** `wrangler.jsonc:68-75` only declares the producer side. The
  consumer is configured via Cloudflare API/dashboard (per the comment on
  line 65-67).
- **Limit:** `wrangler queues consumer http list <name>` does not exist —
  settings like `max_deliveries`, `dead_letter_queue`, and `delivery_delay`
  cannot be inspected from the CLI. Operator must verify in the Cloudflare
  dashboard whether they were ever set.
- **Consequence:** 4xx messages are ack'd by `consumer.py:447-450` (good —
  poison pills don't cycle), but a message that throws a 5xx or hits the
  consumer's broad `except Exception` (`consumer.py:453-454`) is left unacked
  for redelivery without a delivery cap. Without a DLQ, a perpetual failure
  mode is invisible until the operator notices a stuck receipt.

### Gap 2 — no log rotation on the launchd plist

- **File:** `scripts/receipts-consumer/com.dazbeez.receipts-consumer.plist:37-40`.
- **Logs:** `/tmp/dazbeez-receipts-consumer.log` (stdout) and
  `/tmp/dazbeez-receipts-consumer.err.log` (stderr).
- **Limit:** No `RotateLogFile` key, no `newsyslog` entry. macOS clears `/tmp`
  on boot (so logs self-truncate eventually) but a long-uptime Mac can grow
  these files unbounded, and a reboot silently erases incident forensics.
- **Consequence:** The consumer's `[fail]` / `[retry]` / `[drop]` lines — the
  only signal an operator has for consumer-side failures — are not retained
  across reboots and could be lost mid-incident.

---

## Cross-references

- Backlog item #5 (`receipt_files` write integrity) → **A1**.
- Backlog item #9 (queue drops) → **A4**, partial **B6**.
- 2026-07-04 incident (17 dropped receipts) — caused by Clerk middleware
  blocking consumer, not by any path in this audit. Documented here only to
  note it is **not** in scope.
- 2026-07-04 incident (15 orphans) — caused by **A1**.

---

**This audit is fact-gathering only. No code paths were modified. Remediation
design belongs to the architect.**
