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
- Runs `npm run dev` for fast UI iteration and `npm run cf:dev` for end-to-end runtime testing against real bindings
- Runs `npm run build:cf` to validate production builds
- Deploys via `npm run deploy`

### Workflow

1. Branch from `main` on the Mac
2. Implement + run `npm run cf:dev` against real bindings to verify behavior
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
2. For Cloudflare runtime checks, run `npm run cf:dev`
3. Smoke-test the deployment with `bash scripts/check-deployment.sh <base-url>`

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
