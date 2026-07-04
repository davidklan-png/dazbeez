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

## Receipts Data Lifecycle (operator-confirmed, 2026-07)

Steady state once monthly reconciliation is habitual: **at most 2 statement
months open at a time**. When a new month starts, the previous month should be
closed — all receipts reconciled against the monthly AMEX statement and the
reconciliation finalized. Design consequences:

- Hot working set is bounded (≤2 open months). Prefer **month-scoped queries**
  over global `LIMIT n` pagination in list/queue/reconcile views.
- Closed months are immutable (finalized-reconciliation guard already enforces
  this) → candidates for archival (R2 `RECEIPTS_ARCHIVE_BUCKET`) and exclusion
  from default views, keeping hot D1 size flat regardless of system age.
- Month-close should eventually be a visible gate/checklist in the UI, not
  just operator habit.

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

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
