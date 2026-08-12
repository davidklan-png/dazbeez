# Dazbeez - AI Agent Guidelines

## Project Context

Dazbeez is a Next.js 16.2.3 website for AI, Automation & Data consulting services. Production now runs on Cloudflare Workers via OpenNext, with Cloudflare D1 used for contact submission persistence.

## Tech Stack

- **Framework:** Next.js 16.2.3 (App Router - not Pages Router!)
- **Styling:** Tailwind CSS (bee theme: amber/yellow + charcoal)
- **Production Runtime:** Cloudflare Workers via OpenNext
- **Persistence:** Cloudflare D1
- **Local Reference Runtime:** Docker Compose on Mac M4
- **Optional LLM:** Ollama for chatbot enhancement

## Key Conventions

### File Structure (App Router)
```
app/
├── layout.tsx          # Root layout (no _app.tsx or _document.tsx)
├── page.tsx            # Home page (root route)
├── globals.css         # Global styles (Tailwind)
├── [dynamic]/          # Dynamic routes use [bracket] syntax
└── .../
```

### Styling Guidelines
- Use bee colors: `amber-500` (#F59E0B) primary, `gray-900` (#111827) dark
- Rounded corners: `rounded-xl` or `rounded-2xl`
- Hover states: `hover:opacity-90` or `hover:bg-amber-600`
- Responsive: `md:` and `lg:` breakpoints

### Component Patterns
- Server components by default (no "use client")
- Client components only for interactivity (forms, animations)
- Use `Link` from `next/link` for navigation
- Use `Image` from `next/image` for optimized images

### Routes
| Route | Purpose |
|-------|---------|
| `/` | Landing page |
| `/services` | Services list |
| `/services/[slug]` | Service detail (ai, automation, data, governance, pm) |
| `/contact` | Contact form (accepts `?service=<slug>` to preselect) |
| `/business-card` | Explainer for the NFC card |
| `/nfc` | NFC micro-page (widget-style) |
| `/api/contact` | POST endpoint for contact submissions (D1 persistence) |

> `/inquiry` has been retired and 308-redirects to `/contact`.

## When Making Changes

1. **Always use App Router patterns** - No `getStaticProps`, `getServerSideProps`
2. **Server components first** - Only add `"use client"` when needed
3. **Test responsive** - Check mobile (375px) and desktop (1024px+)
4. **Preserve bee theme** - Keep amber/yellow + charcoal color scheme
5. **Run dev server** - `npm run dev` to test changes

### Boundary checks are the writer's job, not the reviewer's

Three P1/P2 defects in PR #160 shared one shape: a value was correct in its
module and invalid where it crossed a boundary — non-ASCII in an HTTP header
ByteString, an `await` outside an error boundary after a seal, a live read
against mutable state for a sealed artifact. Whoever writes a value that
crosses a boundary checks that boundary's constraints. Verification that only
diffs outputs will not catch these.

A concrete recurring boundary: any new `app/api/receipts/[id]/*` handler doing
processor-key-OR-Clerk layered auth is correct in its module but **must also be
added to `PUBLIC_ROUTES` in `middleware.ts`** — or Clerk's `auth.protect()`
404-rewrites the processor-key request before the handler runs. This is the
*second* occurrence of the PR #59 failure that silently dropped 17 receipts
(2026-08-09, `/enqueue`; first occurrence documented at `middleware.ts:39-41`).
The writer of a new processor-key route adds it to `PUBLIC_ROUTES` in the same
change; `tests/middleware-routing.test.ts` asserts the exemption.

## Deployment

- Cloudflare build: `npm run build:cf`
- Local Workers preview: `npm run cf:dev`
- Deploy worker: `npm run deploy`

## Docker Reference

- `Dockerfile` and `docker-compose.yml` are kept only for local/reference workflows.
- The `llm` Compose profile is local-only and does not participate in production.

## Receipts Module — All-Mac Development

The receipts module (`app/(receipt-system)/receipts/`, `app/api/receipts/`, `lib/receipts/`) is developed end-to-end on the Mac M4 with live Cloudflare bindings. The previous PC/Mac split has been retired — all coding, building, testing, and deployment happen on the Mac.

### Mac M4 — Single Source of Truth

- Owns `wrangler.jsonc` bindings for D1 (`RECEIPTS_DB`, `CRM_DB`), R2 (`RECEIPTS_BUCKET`, `RECEIPTS_ARCHIVE_BUCKET`), and any AI bindings
- Holds Cloudflare Tunnel config, Access policies, and auth keys
- Runs SQL migrations against live D1
- Runs `npm run dev` for fast UI iteration
- Runs `npm run cf:dev` (`opennextjs-cloudflare preview`) for runtime checks — **local miniflare bindings only**: empty local D1/R2/Queue, and `RECEIPTS_PROCESSOR_KEY` (a wrangler secret) is absent locally. It proves the worker boots and routes are mounted/auth-gated; it is NOT a real-data functional test. Do **not** add `--remote` to the default `cf:dev` script. The live functional gate is post-deploy `bash scripts/check-deployment.sh`.
- Runs `npm run build:cf` to validate production builds
- Deploys via `npm run deploy`

### Workflow

1. Branch from `main` on the Mac
2. Implement + run `npm run cf:dev` to verify boot/routing/auth-gating (local miniflare bindings — NOT real data; see Mac M4 note above)
3. `npm run build:cf` must pass
4. Smoke-test with `bash scripts/check-deployment.sh <base-url>` after deploy
5. Commit, push, open PR, merge, deploy

### Cloud / Remote Sessions

When Claude Code runs in a cloud sandbox (e.g. claude.ai/code web session) the container does **not** have the Mac's credentials, `wrangler.jsonc` secrets, or D1/R2 access. In that environment:

- Treat the session as code-only: edit, `tsc --noEmit`, run unit tests with mocked bindings, commit, push
- Do not attempt `wrangler dev`, `cf:dev`, or `deploy` — they will fail without bindings
- For any change that depends on live D1/R2 behavior, hand off to the Mac for verification and deploy

## Verification
1. Run `npm run build:cf` before shipping deployment changes
2. For Cloudflare runtime checks, run `npm run cf:dev` (boot/routing/auth-gating
   only — local miniflare bindings, NOT real data; see Mac M4 note above)
3. Smoke-test the deployment with `bash scripts/check-deployment.sh <base-url>`
4. **Open the affected screen in the live app, signed in, and read the state the
   operator sees.** Required, not optional — see below.

### Step 4: open it and look

Steps 1–3 prove the code compiles, the worker boots, and the routes answer.
None of them prove the receipt is *right*. Every defect found on 2026-08-09 was
invisible to steps 1–3 and to diff review:

- `promoteIntake` never enqueued extraction — found by a D1 state query, not by
  reading the promote path.
- `promoteIntake` never wrote the `receipt_files` manifest row — found by
  opening the receipt and seeing a `missing_receipt` blocker next to a rendered
  87 KB PDF. It survived a careful architect review of that exact function,
  because the review was checking the change against its spec, and the omission
  was in what the function *didn't* do.
- Backlog #17 (fake queue position) was observed firing in production during
  the same session, on the ordinary flow — not the rare trigger it was filed
  under.

So: after deploying anything that touches receipt state, open the affected
receipt/queue/month in the browser and check the blocker list, the badges, the
counts, and the field values — not merely that the page renders. A screen that
loads is not a screen that is correct.

Whoever closes the task does this. In the two-agent split the ARCHITECT also
does it independently before signing off; verification that only reads the
worker's report inherits the worker's blind spots.

A useful heuristic for what to look at: pick the invariant the change was
supposed to establish, and find the place in the UI where its violation would
be visible. If there is no such place, that absence is itself a finding.

## Cloudflare Plan & CPU Budget (root cause of 2026-07-04 Error 1102s)

The chronic Error 1102 ("Worker exceeded resource limits") storms were CPU
budget exhaustion on the **Workers Free plan**: the 10ms/request CPU budget
is enforced as a sustained average (bursts allowed, then the isolate is
punished — subsequent requests fail fast at ~10ms until eviction). Measured
average CPU is ~38ms/request (SSR + Clerk JWT verification since PR #59),
i.e. ~4× the Free budget. Not fixable in code — do not burn time optimizing
for a 10ms ceiling. If 1102s recur on the paid plan at normal CPU levels,
that's a platform issue → Cloudflare support ticket, not a rollback.

**Resolved 2026-07-04: account upgraded to Workers Paid ($5/mo).** Current
headroom vs usage (~4.4k req/day, ~5M CPU-ms/mo): 10M requests + 30M CPU-ms
included, 30s/request CPU limit. Architecturally relevant quotas now
available: D1 5 GB / 25B reads / 50M writes per month; Queues 1M/mo;
Workers Logs 20M events, 7-day retention (use for per-route CPU
attribution); Workers AI 10K/day and Durable Objects unlocked (unused —
candidates for future extraction/processing phases, not current design).

## Receipts Data Lifecycle (operator-confirmed, 2026-07; policy per ADR 0005)

Steady state once monthly reconciliation is habitual: the module is designed
and tested for **3–4 concurrent open statement months** with overlapping
statement windows (ADR 0005). There is **no hard runtime cap** on open months
— the design still holds if a fifth month opens — but the normal operator
habit favors closing the previous month (reconciling all receipts against the
monthly AMEX statement and finalizing the reconciliation) once a new month
starts. Design consequences:

- Hot working set is small in practice. Prefer **month-scoped queries** over
  global `LIMIT n` pagination in list/queue/reconcile views.
- Closed months are immutable (finalized-reconciliation guard already enforces
  this) → candidates for archival (R2 `RECEIPTS_ARCHIVE_BUCKET`) and exclusion
  from default views, keeping hot D1 size flat regardless of system age.
- Out-of-order finalize is allowed with a non-blocking warning (sealing April
  while March is open is legitimate); a receipt matched to AMEX lines in two
  statement months blocks finalize on both until disambiguated.
- Month-close should eventually be a visible gate/checklist in the UI, not
  just operator habit.

## Receipts Backlog (architect-tracked, not urgent)

1. **Deprecate `expense_type` in favor of `expense_category_code`.** DONE
   (c865c36, 2026-07-19, sandbox session — cf:dev smoke still needed on
   the Mac). Expense Type field removed from the review form (form-pane.tsx);
   Category is the single classification input. Attendee-requirement gate
   was already Category-driven (categoryRequiresAttendees), so no
   functional regression there. Dead expense_type-based attendees_required
   check at insert removed (db.ts) — it never fired live since expense_type
   is always "UNKNOWN" at insert. David decided: drop ExpenseType from the
   accountant-facing export CSV now (export.ts) rather than leave it
   permanently blank — flag to David to give the accountant a heads-up on
   the column-layout change before the next delivery. expense_type DB
   column + type kept untouched for historical rows, no migration. 577
   receipts tests pass, tsc clean.
2. **`listReceiptSummaries` refactor** — month-scoped, column-projected
   queries (no `extraction_json`) for review queue / reconcile / capture /
   export list views; replaces global `LIMIT 200/1000`. Bundle with #1
   (same screens).
3. **Per-route CPU attribution** via Workers Logs (now available on paid
   plan) — explain the ~38ms average request CPU before adding features.
4. **Month-close UI gate** — dashboard nudge when a prior month has
   unreconciled receipts and a new month has activity (see Data Lifecycle
   section).
5. **receipt_files write integrity.** The mobile upload route
   (app/api/mobile/receipts/upload/route.ts:139) swallows manifest-write
   failures (console.error only) — this silently created the 15 orphans
   backfilled on 2026-07-04. Design decision needed: fail the upload
   loudly vs. a reconcile job that heals drift. Related: 2 dangling
   receipt_files rows reference receipt IDs absent from receipt_records
   (object_ids 37df0d98…, 45dfd7e5…) — likely the purge path deletes
   receipts without cascading to receipt_files (and possibly R2). Fix
   cascade + clean the 2 rows in the same PR.
   DECISION (2026-07-05, audit finding A1): fail loudly — compensating
   delete of R2 object + receipt row, return 500; client shows error tile.
   DONE (40efd02, PR #63): both routes fail loudly via new canonical
   hardDeleteReceipt(); the 2 dangling rows were already gone from prod.
   Remaining follow-up: iOS client must SURFACE the 500 — PARKED
   (operator decision 2026-07-05: app development on hold until system
   stabilized; repo contains only Xcode scaffolding, no Swift source).
6. **Consolidate month-closing validation.** After the read-through fix
   (223b22e), validateMonthReadyForExport's inline receipt loop duplicates
   checks now covered by validateAmexLinesForSignoff. Cleanup pass to
   single-source them.
7. **Known edge — 2026-05 NFCTAGS line (91f51402…).** Line category =
   advertising_promotion, receipt category = null, month already finalized
   (archived manifest in R2 unchanged). Any future re-finalize/export
   revision of 2026-05 will block on the null receipt category — and the
   finalized-reconciliation guard also locks receipt edits. Resolution
   path: unfinalize 2026-05 → set receipt category → re-finalize. Verify
   an unfinalize flow exists before attempting.
8. **Orphan classification: "upcoming" vs. true orphan.** Classify orphans by
   date: receipt date after the latest statement period → "upcoming" (expected
   to match when the next statement arrives); receipt date within an existing
   statement's period → true orphan (needs investigation). Derive at query time
   (no stored flag) so classification flips automatically when a new statement
   lands. Surface the distinction in reconcile/queue views so upcoming receipts
   don't read as problems.
   HISTORY (2026-07-05): at that time the 16 orphan receipts observed were all
   dated after the 2026-07 AMEX statement period — they weren't errors, just
   receipts awaiting the next statement. That "all upcoming" framing was true
   for that one snapshot.
   AUDIT (2026-07-21, read-only): no longer true. The default reconcile month is
   now 2026-08 (12 orphans). The 2026-08 orphan population is dominated by
   **possible AMEX re-captures** (same canonical merchant + currency + amount +
   date, distinct files — e.g. a HOLIDAY SKY LOUNGE ¥10680 triple, a 岡芳商店
   ¥3862 triple) and **cross-month leakage** (a receipt confirmed in 2026-07
   whose status drifted to "reviewed" appeared as a 2026-08 orphan because the
   page built its linked-set from the displayed month only). Other live
   duplicates: ロトンド / ブラチェリアロトンド and PERFECT / PBK四ッ谷
   descriptor-vs-legal-name pairs, a NFCTAGS mobile-photo + desktop-PDF
   cross-channel pair, and a MIURA re-capture of an already-exported receipt.
   NOTE: the audit did **not** complete visual comparison of the receipt images
   (the local viewer did not render and images were not sent to a third-party
   vision service), so these are metadata-strong **possible** duplicates, not
   pixel-confirmed. A legitimate JR round-trip (two ¥4280 えきねっと charges,
   one day apart, reconciled to two distinct lines) must not be mislabeled.
   PHASE 1 DONE — merged via PR #145 (merge commit b1edaa3, deployed to
   production 2026-07-21, Worker version 35af2121). Verified live against the
   default 2026-08 Reconcile population: (a)
   status-downgrade prevention — the public review PATCH owns only
   captured/needs_review→reviewed, and ordinary autosaves omit status
   (lib/receipts/receipt-status-policy.ts); (b)
   cross-month false-orphan removal — receipts claimed by a matched/confirmed
   line in another statement month are excluded from candidates and orphans,
   keyed on the AMEX line relationship not receipt.status
   (lib/receipts/cross-month-claims.ts); (c) honest classification — only true
   in-period unmatched receipts count as "Orphan receipts"; leading-slack,
   upcoming, and undated are separate labeled sections
   (lib/receipts/orphan-classification.ts); (d) the global newest-200 AMEX
   query is replaced by an exhaustive windowed read with a hard cap that throws
   loudly (listAmexReceiptsForReconcile in db.ts); (e) non-blocking AMEX
   possible-duplicate badges in Reconcile (lib/receipts/amex-duplicates.ts) —
   never auto-matches/deletes. Open data-cleanup (operator action, NOT in this
   code-only phase): the stray duplicate receipts identified by the audit still
   need manual delete-after-review; no production data was mutated.
9. **Consumer poison-pill handling + DLQ.** Undecodable files (pre-PDF-fix:
   PIL UnidentifiedImageError) fall into the generic retry path and redeliver
   until max-deliveries silently drops them — receipt stuck at
   extraction_state=queued with no signal. Two-part design: (a) consumer
   classifies permanent local failures (undecodable file, conversion error)
   and marks the receipt extraction_state='failed' (needs a Worker endpoint
   or D1 write path — decide) instead of leaving unacked; (b) configure a
   DLQ on the extraction queue so nothing is dropped invisibly. Backfill
   remains the recovery net, but it shouldn't be the only detection.
   Audit cross-ref: findings A4 + B6 (docs/audits/2026-07-05).
   DONE (PR #63 + PR #65): (a) shipped 1525b2e/d5d8dc5 — consumer
   classifies permanent failures (explicit exception-type allowlist),
   POSTs /api/receipts/:id/extraction-failed (processor-key guarded),
   acks; failed receipts show a red pill in the queue, terminal until
   operator action. (b) shipped — DLQ
   dazbeez-receipts-extraction-dlq + max_retries=5. The expected HTTP-pull
   consumer policy lives in scripts/receipts-consumer/queue_policy.py +
   docs/runbooks/receipts-queue-control-plane.md, with a safe read-only REST
   verifier (scripts/receipts-consumer/audit-queue-config.sh); live settings
   were verified matching on 2026-07-16. HTTP pull is configured out of band
   (control plane), not declarative in wrangler.jsonc. Note: the configured
   HTTP-consumer default visibility_timeout_ms is 43200000 (12 hours); the
   Mac consumer sends an explicit per-pull override of 300000 (5 minutes),
   which wins for the current consumer — the 12-hour default remains a trap
   for any future consumer that omits the override.
10. **Source provenance: desktop uploads tagged "mobile_capture".** DONE
    (e1005cd, 5514501). `source` is now a typed `VALID_SOURCES` value
    (`mobile_capture` | `desktop_upload`) in the client-safe
    `lib/receipts/upload-policy.ts`; the upload route requires and validates
    it (rejects missing/invalid instead of silently defaulting to
    `mobile_capture`); the desktop client sends `desktop_upload`, mobile web
    sends `mobile_capture`. `deriveSourceType` and `VALID_SOURCE_TYPES` are
    shared/single-sourced (explicit valid `sourceType` wins; else
    mobile_capture→paper_scanned, PDF→electronic_receipt, otherwise
    manual_upload). Note: filename-based "paper-scan" detection was
    deliberately NOT added — the system lacks the information to infer that
    reliably (architect decision). Existing rows keep their historical values.
11. **Capture client test coverage + cleanup.** DONE (ee0e5e7). The
    hand-rolled desktop pool, mobile single-flight guard, AbortController
    collection, and SessionUpload row transitions were extracted into
    client-safe, unit-tested modules (`lib/receipts/upload-pool.ts`,
    `single-flight.ts`, `abort-registry.ts`, `session-upload.ts`). Coverage:
    desktop concurrency exactly 3 + FIFO ordering + slot release on
    resolve/reject; mobile single-flight; abort-registry lifecycle
    (register/unregister/abortAll, unregister-after-abort harmless);
    success/error/cancellation row transitions (rows never silently removed;
    BatchTile renders the message). Dead props removed from
    `CaptureDesktopProps` (`phase` and `initialPayment`); their mobile/form
    usage is retained. 15 new tests; no jsdom/Testing Library added (pure
    extraction).
12. **Error-surfacing hardening pass (theme).** Three loss incidents share
    one property — failures that don't announce themselves: swallowed
    receipt_files manifest writes (#5), silent queue max-deliveries drops
    (#9), silently aborted client uploads (fixed, 4a08f92). Audit complete:
    docs/audits/2026-07-05-error-surfacing.md (PR #62) — 15 findings
    (A=4, B=6, C=5) + 2 infra gaps. Phase 1 DONE (PR #63, commits
    40efd02/58d38be/beb1e96/1e18891): A1 loud uploads, A2 atomic finalize
    cleanup + warnings banner, DLQ+max_retries, B5 parse-failure badge.
    Phase 2 DONE (PR #64): B1–B4 warnings/banners, stuck-pending pill,
    log rotation (newsyslog conf installed by operator). Theme CLOSED
    (PR #65 completed #9(a) consumer failed-state marking). Every failure
    path from the audit now surfaces or dies visibly. C-class accepted
    as documented.
13. **Multi-page PDF handling.** IMPLEMENTED (code complete; Mac consumer
    restart + surgical re-extraction still required). Real-world case:
    5608427143.pdf (5c1ab53f…) has 2 pages; the old consumer rendered page 0
    only. The consumer now renders every PDF page to an ordered ~200-DPI PNG
    list, passes all images to mlx-vlm with `num_images` and a page-scaled
    output budget, cleans up all page files on success/failure, and persists
    `sourcePageCount` in extraction_json. Five focused regressions cover
    single-page compatibility, multi-page order/completeness, partial-failure
    cleanup, multi-image model input, and empty-input rejection; the complete
    consumer suite is 84 passing. Automation/backfill scanning is deliberately
    parked. Live follow-up: restart the launchd consumer from the committed
    code, then re-extract only receipt 5c1ab53f… and verify
    `sourcePageCount=2` plus page-2 text before considering this operationally
    closed.
14. **Extraction quality: 登録番号 recall.** Extractor missed a clearly
    printed T-number (receipt 92418c1a, T2810074043972 visible on image).
    Improve Mac-side extractor recall; consider a re-extract pass over
    existing receipts whose extraction_json lacks the field.
15. **Canonical merchant at capture (write-side canonicalization).** PR A
    (merchant.ts) ships READ-side canonicalization: computeDuplicateReceiptWarnings
    grouping + isTopUpVenueMerchant canonicalize before matching, so OCR-garbled
    chain variants (2026-06 "セブンーエレブン" vs "セブン-イレブン 東中野末広橋店")
    cluster/match without touching stored data. Assessed WRITE-side here, did
    NOT build it: a canonical_merchant column populated at capture would need a
    schema migration + backfill + edits to THREE write paths (MLX-extraction
    apply, amex import, the receipt PATCH merchant field) and re-canonicalize on
    every operator edit — it touches the MLX consumer contract (the garbles
    originate in extraction.ts parseMerchant VLM output). Recommendation:
    DEFER until backlog #14 (extraction recall) lands — canonicalizing a
    column that a noisy extractor keeps re-garbling is churn. When added, a
    stored canonical key also lets the manifest/export and the reconcile dedup
    UI show a clean merchant without re-deriving. Read-side canonicalization
    delivers the user value now (June-2 pair clusters; IC count 7→8) and is the
    single match authority until then.

16. **Bank-debit utility lines + 家事按分 proration.** PARKED — design only, no
    code. Water/electricity/gas are paid by 口座振替, have no AMEX line and no
    receipt, and are currently invisible to the module; only a business fraction
    (~50%, rate TBC by the accountant) is deductible. Design captured in
    [ADR 0013](docs/adr/0013-bank-debit-lines-and-household-proration.md):
    operator-uploaded bank CSV (no stored credentials, no automated login, no
    aggregator); a bank debit modelled as a **statement line, not a receipt** —
    new `bank_statement_lines` table + third `ExportRow.rowType` `"bank_line"`,
    NOT a fourth `PaymentPath` (measured blast radius: 34 files touch
    `PaymentPath`, 25 hardcode `"DIGITAL"`, and every existing value presumes a
    captured image + extraction + review, none of which a bank debit has);
    gross amount + **snapshotted** `business_ratio_bp` stored, deductible
    derived (a live-lookup ratio would silently rewrite sealed months — breaks
    ADR 0009); inside the finalize/seal gate, not stapled on at delivery.
    TWO HARD GATES before any design decision is locked or code written:
    (G1) **current application stabilized** — this sits behind the open items
    above; (G2) **a real bank statement export inspected first** (operator
    instruction 2026-08-03). G2 exists because D3 (descriptor-matching rules)
    and D4 (per-utility gross) rest on assumptions about a file nobody has
    looked at — if the 口座振替 descriptor is truncated katakana, unstable, or
    names only the collection agent rather than the utility, the rules approach
    collapses and the fallback is operator-tagged lines. See ADR 0013 §Gate G2
    for the six questions one month's export would settle. Also open: three
    questions for the accountant (rate + basis, debit-date vs. service-period
    booking, whether the system's derived deductible is authoritative or
    informational).

17. **Review screen fakes queue position for out-of-view receipts.** DONE —
    CLOSED 2026-08-09 (PR #163, commits 00b9a09 + 9e6b9d8, master 37cb88c,
    deployed and verified live by the architect per §Verification Step 4).
    Pure `resolveQueueNavigation` + nullable `queueIndex` + "not in this view";
    the working set was NOT widened. A server-derived **"View in July 2026"**
    link (`switchToMonthTarget`, suppressed for same-month / all-months /
    undated) turns the dead end into a route and delivers what the CUT
    Copy-link button was for, closing that design thread. Known acceptable gap:
    a receipt filtered out by *Closing scope* rather than month shows
    "not in this view" with no link — the remedy there is switching the tab, so
    a month link would mislead. Original spec was at
    `prompts/WORKER-PROMPT-share-receipt-link.md`; the corrected one is
    `prompts/WORKER-PROMPT-queue-position-out-of-view.md`. History below.
    In `review/[id]/page.tsx`, `activeIndex = queueItems.findIndex(...)` is
    `-1` when the active receipt isn't in the working set;
    `Math.max(1, activeIndex + 1)` then renders a false **"1 of N"**, and
    `nextReceiptId` resolves to `queueItems[0]` — so Skip and save-and-advance
    jump into an unrelated queue. (`prevReceiptId` is harmless: `[-2]` →
    undefined.)
    **OBSERVED LIVE IN PRODUCTION 2026-08-09 — the filed trigger was wrong.**
    This was filed as a latent bug gated behind a rare sharing scenario. It is
    routine. Observed with no deep link, no second user, and no month picker:
    the three recovered `email_attachment` receipts were undated (so they sat in
    the default Aug-2026 working set); extraction backfilled transaction dates of
    Jul 22 / Jul 26 / Jul 31; all three immediately left the Aug working set
    while one was still the open receipt. The page then rendered a fabricated
    **"1 of 1"** / "0 of 1 done" while the rail held only an unrelated receipt,
    and `nextReceiptId` pointed at that unrelated receipt — so `s` (save &
    advance) would have jumped queues. **Any undated capture that extracts into
    a prior month reproduces this**, which is the normal path for anything
    captured near a month boundary or recovered after a delay. Re-prioritize
    accordingly, and do NOT let an implementer test only the deep-link path.
    The original (still valid, but secondary) trigger: a **shared deep link
    crossing a month boundary** — rail hrefs come from `buildReviewQueryParams`,
    which only emits `month` when the operator used the month picker, so a link
    copied from the default view carries none — after the calendar month rolls
    over the recipient's rail is the new month and both bugs fire. Also reachable
    in practice: receipt links are being shared with a second Clerk user
    (2026-08-04 decision — Clerk account + existing protected deep link;
    a signed capability-link design was assessed and rejected: third principal
    class, scoped PATCH, unauthenticated R2 read path, seal-guard
    reimplementation, and a weaker audit actor on 接待交際費 attendees).
    Fix: extract a pure `resolveQueueNavigation` into `review-queue-filter.ts`
    (absent id → `index: null`, `nextId: null`) + widen `FormPaneProps.queueIndex`
    to `number | null` and render "not in this view". State it, don't fix it up —
    do NOT widen the working set to make the receipt fit; that set is
    export/closing-scope authority, not a display convenience. A Copy-link
    button + share-URL builder were designed and CUT in the same pass: ordinary
    right-click-copy covers the common cases and the button's only real value
    was pinning the month, i.e. a workaround for this bug.

18. **Capture completeness is not a contract — unify the four capture paths.**
    NOT DISPATCHED — spec at `prompts/WORKER-PROMPT-capture-contract.md`.
    `createReceiptRecord` is fiercely single-sourced ("Do not add a second
    insert path"), but the *rest* of a capture — the `is_original`
    `receipt_files` row and the extraction enqueue — is a hand-rolled sequence
    copy-pasted into each route. On 2026-08-09 `promoteIntake`'s attachment
    branch was found to have omitted **both** (fixed: 2f2474f, 1cea51c). A
    fourth capture path was added and simply forgot; a fifth will too. The
    invariant to make structural: **a capture is not complete until the receipt
    has (a) a row, (b) an `is_original` `receipt_files` row, and (c) EITHER an
    enqueued extraction job OR `needs_render=1`.** Paths:
    `/api/receipts/upload`, `/api/mobile/receipts/upload`, `promoteIntake`
    (attachment), `promoteBodyIntake` (defers enqueue to `/render`). This is
    the AGENTS.md "boundary checks are the writer's job" failure at the level
    of a whole subsystem.
    DECISIONS (2026-08-09, architect, on the worker's B2 proposal):
    (i) Full `captureReceipt()` wrapper in `lib/receipts/capture.ts`, NOT a
    thinner `completeCapture()` — one door, not a step you can skip.
    (ii) **The real deliverable is enforcement, not the wrapper.** After the
    refactor there must be exactly ONE importer of `createReceiptRecord`:
    `lib/receipts/capture.ts`. Add a test that reads the source tree and
    asserts that importer set. Without it the contract is convention, and
    convention is what failed. This is the only part of #18 that protects the
    NEXT path rather than the four current ones.
    **PREMISE CORRECTED 2026-08-09 (worker finding).** #18 assumed
    `createReceiptRecord` is the single insert path. It is not: there are TWO
    `INSERT INTO receipt_records` — `db.ts:91` and `mobile-upload.ts:56`
    (`createMobileReceiptRecord`, adding `device_id`, `client_capture_id`,
    `captured_at_client`, `upload_origin`). The mobile route never imports
    `createReceiptRecord`, so the importer test alone would PASS while the
    mobile path bypassed the contract. Note `email-intake.ts:18` already said
    "Do not add a second insert path" — migration 0015 added one anyway. A rule
    in a comment, unenforced, silently violated.
    So the test must assert BOTH: (1) exactly one `createReceiptRecord`
    importer, AND (2) no `INSERT INTO receipt_records` outside `db.ts`.
    Resolution = **Option A**: extend `CreateReceiptInput` +
    `createReceiptRecord` with the optional mobile fields, delete
    `createMobileReceiptRecord`, mobile route calls `captureReceipt`. Option B
    (insert-then-UPDATE) is rejected on CORRECTNESS, not taste: the partial
    UNIQUE index (`0015`, `WHERE device_id IS NOT NULL AND client_capture_id IS
    NOT NULL`) only fires when both columns are set AT INSERT, so a
    NULL-at-insert window lets two concurrent mobile uploads both succeed and
    silently breaks idempotency.
    (ii-b) **Merging the two INSERTs must not silently pick a winner.** Report a
    column-by-column divergence audit before the merge lands. One is already
    known: `preservation_status` is hardcoded `'needs_review'` in db.ts,
    `'captured'` in mobile-upload.ts, while migration 0014's own backfill maps
    `status='captured'` → `'needs_metadata'`. Three answers, no reader.
    RULING: derive it from `status` using 0014's CASE as the single authority
    (pure + unit-testable); do not hardcode either literal. Do NOT backfill
    existing rows in this PR — that writes to every receipt including sealed
    months and could trip the export-lock/finalized guards; file separately
    (filed as #23).
    (ii-c) **A column audit cannot see the real risks — they live AROUND the
    INSERT.** Four behavioural divergences found 2026-08-09, two with teeth:
    (a) **Audit payload.** Both emit action `receipt.uploaded`, but db.ts writes
    `{paymentPath, expenseType, source}` while mobile writes eight fields
    including `device_id`, `client_capture_id`, `app_version`, `note`.
    `app_version` and `note` never reach `receipt_records` at all — they exist
    only in the audit JSON, so a column-by-column diff is structurally blind to
    them. The merged payload MUST be a superset or every mobile capture loses
    device provenance from a 10-year tax record.
    (b) **Error taxonomy.** `createMobileReceiptRecord` throws on the 0015
    unique-index collision and the ROUTE (`app/api/mobile/receipts/upload/route.ts:98`)
    catches it, looks up `findMobileReceiptByIdempotency`, deletes the R2
    object, and returns 200 `{duplicate:true}`. `captureReceipt`'s manifest-LOUD
    policy also throws (after `hardDeleteReceipt`), and that catch block cannot
    tell the two apart — a manifest failure would be mis-handled as an
    idempotency race and vice versa. `captureReceipt` MUST throw typed errors
    (e.g. `CaptureIdempotencyConflict` vs `CaptureManifestFailure`) so the route
    branches on cause, not on "something threw".
    (c) After the merge the mobile path gains `assertTransactionMonthEditable`
    (split lock, audit A5) and (d) `assignMembershipForReceipt` (ADR 0008).
    Both are no-ops today because mobile inserts with no `transaction_date` —
    recorded as deliberate findings, not assumptions.
    (iii) Failure semantics stay deliberately different: manifest fails LOUD
    (`hardDeleteReceipt` + throw), enqueue fails BEST-EFFORT. Do not unify.
    (iv) `needs_render` opts out via an `enqueue: false` parameter, not a
    branch on source type.
    (v) #20 marker = nullable `extraction_enqueue_failed_at` column, NOT a
    fourth `extraction_state` (which would enter `PENDING_EXTRACTION_STATES`
    and touch every consumer). Migration is additive, no backfill, and ships in
    the same PR as the code that writes it.
    (vi) Surface it as a separate health class 1b, not folded into class 1 —
    "never tried" is a code defect to report, "queue outage" is a retry, and
    folding them dilutes class 1's provable-not-heuristic property.

22. **Render-leg failures are stderr-only.** `process_renders`
    (`scripts/receipts-consumer/consumer.py:955`) catches every exception and
    prints to `~/Library/Logs/dazbeez/receipts-auto-promote-render.err.log`.
    No D1 write, no `extraction_state='failed'`, no badge — a failing render
    leg leaves receipts at `needs_render=1` silently and indefinitely. Backlog
    #19's class 3 DETECTS the aging, but cannot name which receipt failed or
    why. Note this is backlog #12 ("error-surfacing hardening", declared
    CLOSED) not covering a path that shipped after it — the same
    fix-applied-path-by-path pattern as #5 recurring in `promoteIntake` and
    #9's backfill net missing never-extracted receipts. Design: mirror the
    extraction leg — classify permanent render failures and POST a
    processor-key-guarded endpoint that records the failure, so it surfaces
    like `extraction_state='failed'` does.

23. **`preservation_status` is a three-way inconsistency in existing rows —
    backfill SEPARATELY (not in the capture-contract PR).** Found during the #18
    column-by-column divergence audit: at insert, `createReceiptRecord`
    hardcodes `'needs_review'`, `createMobileReceiptRecord` hardcodes
    `'captured'`, and migration 0014's own backfill CASE maps
    `status='captured' → 'needs_metadata'`. Three answers for one concept on a
    10-year tax record, undetected because nothing reads the column. The
    capture-contract merge FIXES the insert (derives `preservation_status` from
    `status` via 0014's CASE as the single authority — pure, unit-tested, no
    literal on either path), but deliberately does NOT backfill existing rows
    in that PR. **Open question for the backfill (filed here, NOT resolved):**
    a backfill writes to EVERY receipt including finalized/sealed statement
    months, which could trip the export-lock / finalized-reconciliation guards
    (a sealed month's rows are supposed to be immutable). Decide before
    backfilling whether (a) `preservation_status` is exempt from those seals
    (it's display-only — nothing reads it today), permitting a blanket UPDATE,
    or (b) the backfill must respect the seal and skip/defer sealed-month rows.
    Do NOT backfill until that is answered.

24. **Export workflow UX — staged, predictable month-close.** NOT STARTED.
    Do not begin until 2026-06 is sent and closed. Full design:
    `docs/export-workflow-ux-plan.md`. Operator complaint (2026-08-11):
    "Review & finalize" and "Send" must be separate, clearly-sequenced
    steps with visual cues for complete / in-progress / pending, and the
    operator shouldn't hunt the page for what comes next. Root causes found
    in code: the `Pipeline` component (`export-screen.tsx:269`) models
    Reconcile→Draft→Review→Finalize→**Archived** — Send is not a stage at
    all, so delivery is bolted on as a banner below the export history
    table; "Archived" is a property not a stage and goes green at finalize,
    so the pipeline reads fully complete at the exact moment the month is
    sealed-undelivered (how 2026-06 sat unsent); `stepIndex` (line 278) has
    two identical branches so blocker count never affects the step; and
    "Reconcile" is hardcoded `done: true`. The next action lives in four
    different places across three pages, and `Pipeline` renders only on the
    export page — so the map disappears the moment you advance a stage.
    Fix = one server-derived `deriveMonthStage()` (same one-authority
    pattern as `delivery-status.ts` / the `ExportBlocker` union), a stage
    model of Reconcile→Draft→Review→Finalize→Send→Closed, one primary
    action in one fixed position, and the pipeline mounted on all three
    surfaces. No server-side gate changes; the finalize/send decoupling
    (D1/D2) and the three-page split both stay.

25. **Japanese business-letter ordering for the delivery email + pack
    notice.** NOT STARTED. Filed 2026-08-11 after the 2026-06 delivery.
    Japanese business correspondence opens with the recipient, salutation,
    and message — not with a machine statement. Today both
    `buildDeliveryEmail` (`delivery-send.ts:150`) and `buildPackNotice`
    (`proofs.ts:120`) emit `{monthLabel} の領収証憑一式を…お送りします。`
    FIRST, then 【今月のご連絡】 with the operator's greeting under it, so
    the letter opens mid-sentence from the accountant's point of view.
    **Target order (operator-approved, BOTH surfaces):** operator preface
    (recipient → salutation → message) → 【今月のご連絡】 → the
    `領収証憑一式` line → then 【勘定科目別集計】 (email) /
    【この資料について】 (notice) → closing → signature. The heading moves
    with the machine line so it introduces the business content rather than
    labelling the greeting.
    **Empty-message degradation:** with no operator message the surface
    opens directly at 【今月のご連絡】 + the `領収証憑一式` line. Do not emit
    a bare heading with nothing under it and do not leave a leading blank.
    **The trap — O7 / preflight check #19.** `pack-preflight.ts` extracts
    the operator message as the lines BETWEEN 【今月のご連絡】 and
    【この資料について】 (~L285-300) and check #19 asserts it equals the
    stored `operator_message`. Under the new order the preface sits ABOVE
    【今月のご連絡】, i.e. from start-of-file to that heading — the extractor
    inverts and MUST change in the same PR or #19 fails on every new pack.
    The separate 【この資料について】 anchor at L276 is unaffected (that
    heading does not move).
    **Second trap — old sealed packs.** Preflight runs at SEND time, not
    seal time, so any month sealed before this ships (2026-06 and earlier)
    still carries the old layout. If such a pack is ever re-sent, a parser
    that understands only the new order will fail it. The extractor must
    accept BOTH layouts; add a regression test pinning a pre-change notice.
    No migration, no re-seal of existing packs.

26. **Sealed-export deletion is out-of-band and untyped.** NOT STARTED.
    Found 2026-08-12 while investigating 2026-06's missing revisions 1 & 2
    (audit in `docs/audits/2026-08-backlog-questions.md` §3). Verdict on the
    deletion itself: legitimate — operator-authorized pre-close test-seal
    cleanup on 2026-07-22 (batch 8a4671fb…), R2 objects removed with no
    orphans, other months contiguous from rev 1. **The gap is the
    mechanism.** The audit actions written (`export.test_seal_removed`,
    `export.draft_supersession_cleared`) are NOT members of the
    `AuditAction` union, and no committed code deletes `receipt_exports`
    (only the 0017 FK cascade, never reached from app code). So rows for a
    SEALED export under `legal_hold=1` were deleted by an out-of-band
    operation that does not exist in the repository, recorded with a
    free-text `retention_legalhold_exception`. On a 10-year tax record that
    is the finding. Fix = a typed `export.deleted` AuditAction, a committed
    script that is the only way to do it (asserting the legal-hold
    exception is explicit and recorded), and a runbook entry. Related
    doctrine: sealing locks edits — the deletion path is the one hole in
    that guarantee and it currently has no code review surface.

27. **Attendee roster has no confirmation surface — it only exists as a
    sealed CSV.** NOT STARTED. Raised by the operator 2026-08-12: "where is
    the attendee list now, how can it be confirmed each month without
    sending to the accountant?" The answer today is: you cannot, until
    after you seal.
    **Current state.** `参加者一覧` is built by `buildAttendeesExportCsv`
    (`export.ts:305`) into `exports/{month}/{exportId}-attendees.csv` — a
    sealed, per-revision artifact containing name/company/title for the
    attendees referenced by that month's rows. Per D9 (2026-08-07, the
    accountant's written request) it is NOT in the delivered ZIP and the
    会議-出席者ID column was removed from the delivered 照合CSVs; only 人数
    ships. It is downloadable by the operator from the sealed-bundle panel.
    The directory behind it is `receipt_attendee_directory` via
    `/api/receipts/attendee-directory`, populated per-receipt through
    `attendee-editor.tsx` in the review form.
    **Gap 1 — no pre-seal review.** `review-screen.tsx` has NO attendee
    section (zero matches). The roster first materialises at seal time, so
    the only way to inspect the month's attendees is to finalize and
    download the CSV — confirmation after the irreversible step. The
    finalize gate already blocks on `attendees_required` /
    `attendee_unresolved`, so the data to show is already computed; it just
    is not rendered anywhere the operator can act on it in time.
    **Gap 2 — no directory surface.** The API exists; nothing renders it.
    D9 makes this worse, not better: `reconciliation-files.ts:13` states
    "retention now matters MORE — we are the only copy." A tax-relevant
    roster that is the only copy has no browse, correct, or audit screen.
    **Fix shape.** (1) An attendee section on the export review screen
    listing, for the month, each referenced attendee with company/title and
    the receipts they appear on, unresolved names flagged inline against
    the existing gate codes — confirmation belongs at Review, alongside
    everything else about the month. (2) A directory management screen
    (browse / correct / merge duplicates). Consider whether the roster
    should be an explicit month-close acknowledgement like the operator
    message decision (`message_not_reviewed`), rather than passive display.

19. **Never-enqueued receipts are undetectable — wire a pipeline health
    surface.** NOT DISPATCHED — same prompt as #18, Part A (do it FIRST).
    `getExtractionHealth` (`lib/receipts/extraction-state.ts:69`) is written
    and unit-tested but imported by **nothing outside its own test**, and it
    reads `pendingProcessingReceipts`, which excludes `needs_render`. So the
    system has no surface for "the pipeline is not draining." The 2026-08-09
    receipts sat 6 days; the only signal was a per-row `stuck?` badge in one
    rail, and the operator found them by eye. Three distinct failure classes
    need covering, the first of which is **provable, not heuristic**:
    (a) `extraction_state='captured' AND extraction_enqueued_at IS NULL AND
    needs_render=0` → no consumer will ever see this receipt;
    (b) pending with `enqueued_at` set and older than the consumer interval →
    consumer stalled; (c) `needs_render=1` aging → render leg stalled
    (its failures are stderr-only in `process_renders`, never written to D1).
    Related: `receipt_files`-count zero is a fourth invariant already computed
    by `countReceiptFilesByObjectIds`.

20. **Enqueue failure and never-enqueued are indistinguishable in D1.**
    `enqueueExtractionJob` returns `false` on failure and callers then leave
    `extraction_state='captured'` with a null `extraction_enqueued_at` — byte
    for byte what a missing enqueue call produces. A queue outage and a code
    path that forgot to enqueue cannot be told apart after the fact. Wants a
    distinct marker (a timestamp column or a fourth `extraction_state`); fold
    into #18 rather than shipping alone.

21. **`/extract` doesn't recompute compliance.** Observed 2026-08-09: after the
    consumer wrote merchant/date/amount, `receipt_compliance_checks` still
    showed `missing_receipt` / `missing_transaction_date` / `missing_amount`
    OPEN until the review page was loaded and `runComplianceChecksForReceipt`
    refreshed them. Pre-existing, not introduced by that session's fixes, and
    self-healing on operator visit — but it means any dashboard or gate reading
    persisted compliance rows (rather than recomputing) can be stale by exactly
    one review-page load. Decide whether compliance should be recomputed at the
    end of `/extract` or whether every consumer of those rows must recompute.
    Low urgency; the month-close gate recomputes.

## Two-Agent Workflow: Sandbox (Architect) vs. CLI (Worker)

This repo is developed across two separate Claude sessions that share the same
working tree (`/Users/dklan/projects/work/dazbeez`) but have different
capabilities. Do not blur these roles.

- **Sandbox session (this one, no live Cloudflare bindings)** is the
  **ARCHITECT, PLANNER, and VERIFIER**. It diagnoses bugs, designs fixes,
  reviews diffs/reports, and makes the calls on tradeoffs. It does not have
  D1/R2/Wrangler bindings and cannot run `cf:dev`, `deploy`, or touch live
  data — it must hand off any change that needs live verification.
- **Mac Claude Code CLI session** is the **WORKER**. It has live bindings, runs
  migrations, deploys, and reports back facts (what changed, what was
  verified, what broke). It does not make architectural decisions — if it
  hits a design fork (e.g. a schema tradeoff), it stops and reports back
  instead of improvising.
- The operator (David) relays prompts and reports between the two sessions
  by hand. Every prompt written by the architect for the CLI worker must open
  with an explicit role header so the receiving session knows immediately
  which hat it's wearing:

  ```
  ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
  sandboxed session) designed the following change and needs it implemented,
  verified against live bindings, and reported back — not redesigned. If you
  hit a design decision this prompt doesn't cover, stop and report back
  instead of improvising.
  ```

### If you are Claude Code on the Mac M4 — you are the WORKER

Implement exactly what the prompt specifies, verify against live D1/R2 (per
the "Verification" section above), and report back concretely: what changed,
what you tested, what passed/failed. Flag anything ambiguous or any
unexpected finding instead of resolving it yourself — send it back to the
architect for a decision.

### Known risk: shared filesystem

Both sessions mount the exact same folder. Concurrent git operations (stash,
checkout, branch switches) from either side can transiently hide or clobber
the other session's uncommitted files. Prefer small, quickly-committed
changes over long-lived uncommitted edits, especially in docs like this one.

Hard rules (adopted 2026-07-05 after `git reset --hard` destroyed the
architect's uncommitted AGENTS.md backlog twice in one day):

- **Worker: NEVER run `git reset --hard`, `git checkout -- <path>`,
  `git clean`, or `git stash drop` while the working tree has modifications
  you didn't make.** Branch from a remote ref with
  `git checkout -b <branch> origin/master`, which carries uncommitted
  changes across. If a destructive command seems necessary, stop and report.
- **Only one session touches the tree at a time.** The architect makes no
  edits while the worker has an active task, and vice versa. The operator's
  relay message is the handoff.
- **Commit architect-authored file changes as the FIRST action of a worker
  task**, before any branch setup that could disturb them.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
