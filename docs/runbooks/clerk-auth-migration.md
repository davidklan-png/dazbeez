# Migration plan — Clerk replaces CF Access + Basic-auth + owners.ts

Status: Phase 0 closed (3 of 4 secrets rotated out of the bundle; `NFC_ADMIN_API_KEY` deferred).
Phase 1 closed Jul 4 via `clerk` CLI — see Phase 1 section for what's now verified firsthand.
Phase 2 implemented on `feat/clerk-phase2` (commit `aaa2549`), pending S7 cf:dev sign-in test
and S8 deploy.

The original Phase 1 status note (kept for history): Clerk app created (Production instance,
custom domain `clerk.dazbeez.com`), keys wired (publishable in `.env.production`, secret via
`wrangler secret put`), session duration and sign-in methods configured. Spike
(`spike/clerk-feasibility`) confirmed Clerk builds and runs cleanly on this app's Cloudflare
Workers/OpenNext setup, and the build-time publishable-key delivery question is also resolved
(`spike/clerk-publishable-key-build-time`).

## ⚠️ Unrelated urgent issue found during the build-time-key spike (fix before Phase 1)

While confirming how `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` gets inlined at build time, the spike discovered
that `.open-next/cloudflare/next-env.mjs` exports **every** var from the root `.env` file — not just
`NEXT_PUBLIC_*` ones — into the deployed Worker bundle. `ADMIN_PAGE_PASSWORD`, `CLOUDFLARE_TUNNEL_TOKEN`,
`ANTHROPIC_API_KEY`, and `NFC_ADMIN_API_KEY` are currently shipping in plaintext inside the live deployed
Worker code. This is pre-existing and unrelated to Clerk, but was surfaced by this work.

**Action, independent of this migration and higher priority:** rotate all four credentials, then move them
out of the root `.env` file into real Wrangler secrets (`wrangler secret put ...`) or `.dev.vars`
(local-only), so they're runtime-only and never enter the build artifact. Root `.env` /
`.env.production` should hold **only** genuinely public `NEXT_PUBLIC_*` values from here on (i.e. just the
Clerk publishable key). See the "Decisions" section below — this has its own line item now.

**Status: closed, except NFC_ADMIN_API_KEY (deferred by David).** Findings from the closeout task
(`fix/secrets-hygiene-next-env-mjs`, deployed as `dc0360b1-...`):
- `ADMIN_PAGE_USERNAME`/`ADMIN_PAGE_PASSWORD` are the only ones of the four actually read by live Worker
  code (`lib/admin-page-auth.ts`). Both are now real Wrangler secrets with rotated values — the actual
  runtime credential is fixed, not just the `.env` file.
- `ANTHROPIC_API_KEY` and `CLOUDFLARE_TUNNEL_TOKEN` were confirmed (by the Mac session, and independently
  re-verified by a repo-wide grep in the sandbox) to be unused by any committed application code — they
  were vestigial `.env` entries that got swept into the bundle by OpenNext's blanket env export, not live
  credentials the app reads. Removed from `.env` entirely; no Wrangler secret needed since nothing
  consumes them. The Cloudflare Tunnel's actual signing credential (a local `.json` file, never in the
  repo) was never exposed — only its UUID was, via `.env`.
- Old values confirmed purged from `.open-next/cloudflare/next-env.mjs` after rebuild + redeploy; smoke
  test passed (same pre-existing `/admin` 500, unrelated).
- **Follow-up caught during sandbox verification, not yet done:** the old (pre-rotation) values were
  also found cached in plaintext in local `.wrangler/tmp/dev-*/worker.js` build artifacts from earlier
  `wrangler dev`/`cf:dev` runs. Confirmed gitignored — never reached git or a real deployment — but still
  worth clearing: `rm -rf .wrangler/tmp` (safe, regenerates automatically).
- **Separate, low-urgency cleanup suggestion:** the tunnel whose UUID was exposed (`server-tunnel`,
  serving 404s) is vestigial per README.md:116 — production no longer uses Cloudflare Tunnel. Consider
  deleting it outright rather than just noting the exposure.
- `NFC_ADMIN_API_KEY` remains untouched and still exposed in the bundle, per David's explicit deferral.

## Why

Five independent, ad hoc auth mechanisms currently gate this app for exactly 2 real users:

| # | Mechanism | File(s) | Problem |
|---|---|---|---|
| 1 | Cloudflare Access (edge JWT) | `lib/receipts/auth.ts:130-234`, config lives only in the CF dashboard | Config has no source of truth in the repo (see `docs/runbooks/cf-access-app.md`) — drifts silently |
| 2 | Web "trusted device" cookie | `lib/receipts/trusted-devices.ts` | Custom HMAC scheme, 1-year expiry, one more thing to maintain |
| 3 | Basic-auth fallback | `lib/receipts/auth.ts:15-24,264-275` (`RECEIPTS_AUTH_USERNAME/PASSWORD`) | Meant for local dev, live as a real prod path with no env gate |
| 4 | Admin Basic-auth | `lib/admin-page-auth.ts` (`ADMIN_PAGE_USERNAME/PASSWORD`) | Entirely separate from everything else — third identity concept |
| 5 | Owner allowlist | `lib/receipts/owners.ts:9` (`RECEIPTS_OWNER_EMAILS`) | Manually duplicated against the CF Access dashboard policy; nothing checks the two agree |

Enforcement is also scattered across ~30 individual page/route call sites since `middleware.ts` was
deleted (commit `7babde1`, 2026-05-16) — a new route that forgets to call the guard fails open.

Two more mechanisms exist for **machines**, not people, and are explicitly **out of scope** — Clerk
doesn't fit them and they aren't part of the "clunky" problem:

- Mobile device pairing (`lib/receipts/mobile-pairing.ts`) — the iPhone capture app.
- `RECEIPTS_PROCESSOR_KEY` — the Mac MLX OCR consumer.

## Target state

One Clerk application. `clerkMiddleware()` becomes the single chokepoint gating `/receipts/:path*` and
`/admin/:path*` — this also fixes the "scattered, fails-open" regression from the `middleware.ts`
deletion, as a side effect of adopting Clerk's idiomatic Next.js pattern. "Owner" becomes a Clerk
`publicMetadata.role` field on your two Clerk users instead of an env var that has to match a second,
separately-maintained list. CF Access, both Basic-auth schemes, and `owners.ts`'s allowlist are retired.

## Sequencing

Given this is a live system 2 people use daily, this plan avoids both extremes — no long-lived
dual-auth transition layer (more code than it's worth for 2 users), and no uncoordinated flag-day
cutover either. Four phases, each independently reversible.

### Phase 0 — Unrelated secrets hygiene fix (do first, blocks nothing else but shouldn't wait)

- [ ] Rotate `ADMIN_PAGE_PASSWORD`, `CLOUDFLARE_TUNNEL_TOKEN`, `ANTHROPIC_API_KEY`, `NFC_ADMIN_API_KEY` —
      all four are currently exposed in plaintext in the deployed Worker bundle (see callout above).
- [ ] Move the rotated values out of the root `.env` file into `wrangler secret put` (or `.dev.vars` for
      local-only use). Confirm `next-env.mjs` no longer contains them after the next `build:cf`.

### Phase 1 — Clerk setup (config only, nothing deployed)

- [x] **Decided: Production instance with custom domain `clerk.dazbeez.com`.** Reversal of an earlier
      "stay on Development" draft — confirmed intentional by David, Jul 4. The tighter same-site session
      cookie behavior of Production is worth the one-time DNS CNAME setup; Development's
      querystring-based `__clerk_db_jwt` mechanism (which the spike proved works) is acceptable but the
      same-site cookie is cleaner. Custom domain live, `pk_live_...` wired into `.env.production`,
      `sk_live_...` set as a Wrangler runtime secret.
      **Verified firsthand Jul 4 via `clerk deploy status`:** domain `dazbeez.com` reports
      `dns: complete`, `ssl: complete`, `mail: complete`, no pending DNS records. Production
      instance ID `ins_3G1ekzEjYUWPN7XHC6tr0IgRgmn`. (Caveat: `deploy status` also reports
      `state: oauth_pending` because Google OAuth is "configured but missing production credentials"
      — David needs to either finish Google OAuth or remove it from the production instance. Not a
      blocker for email-code sign-in, which is the only sign-in method this app uses.)
- [x] **Clerk Application created** — one "Dazbeez" application (`app_3G1RAC2rvCzeSrA48wPNkoP1D0q`)
      with two instances: Development (`ins_3G1RAD5kUWoayFhcHLOvKcAybTn`, frontend host
      `golden-mosquito-0.clerk.accounts.dev`, `pk_test_...`) and Production
      (`ins_3G1ekzEjYUWPN7XHC6tr0IgRgmn`, `clerk.dazbeez.com`, `pk_live_...`). The spike's
      "separate test app `golden-mosquito-...`" turned out to be just the Development instance of
      the same Dazbeez app (Clerk's standard one-app-two-instances pattern), not a separate app —
      verified via `clerk apps list`. The dev instance's test keys (`pk_test_...` / `sk_test_...`)
      passed through chat during the spike should still be rotated in the Clerk dashboard for hygiene.
- [x] **Decided: email one-time code only.** No social/OAuth providers for now — avoids the
      sso-callback route entirely. Revisit later if Google sign-in becomes wanted.
      **Verified firsthand Jul 4 via `clerk config pull --instance prod`:**
      `auth_email.sign_in_strategies: ["email_code"]`, `verification_strategies: ["email_code"]`,
      `used_for_sign_in: true`, `used_for_sign_up: true`, `verify_at_sign_up: true`. No other
      auth_* blocks enabled.
- [x] **Decided: longest session duration Clerk's dashboard allows ("no limit / max").** Clerk's
      Session settings expose an "Inactivity timeout" and a "Maximum lifetime" — set both to the longest
      values the dashboard offers (Clerk may not literally offer "infinite"; if there's a practical cap,
      use it). This matches the 1-year, effectively-indefinite behavior of the trusted-device cookie it's
      replacing. Confirm the actual max in the dashboard when creating the app — the exact ceiling wasn't
      verified here.
      **Resolved Jul 4 — decision revised, not achievable as originally scoped:** David checked the
      dashboard's "Inactivity timeout" / "Maximum lifetime" settings directly — both are **Pro-plan-only**
      for production instances. Free plan is fixed at a **7-day maximum session lifetime**, non-
      configurable. David's call: stay on the free plan, accept 7 days rather than upgrade. Real
      consequence: both of you will need to re-sign-in (email code) roughly weekly, versus the ~1-year
      effective lifetime of the trusted-device cookie this replaces — a real but minor UX step down,
      accepted as worth it to avoid a paid plan for 2 users. (`session.lifetime` in the CLI's config
      schema is a separate, unrelated setting — the underlying JWT token's technical lifetime, not the
      persistent session; that one Clerk deliberately keeps short (default 60s) and silently refreshes,
      and is not what needed changing here.)
- [x] **`publicMetadata.role` set on both real users via Clerk CLI** (Jul 4). Done via
      `clerk api /users/{id}/metadata -X PATCH -d '{"public_metadata":{"role":"..."}}' --instance prod`.
      - `david.klan@gmail.com` (`user_3G1q2nsu5ddo2H6wtKcvseX8gGs`) → `public_metadata: {role: "owner"}`
      - `tazukowen@gmail.com` (`user_3G1q4tZjrym0fH2IqfZmJh440AM`) → `public_metadata: {role: "member"}`
      Both users already existed in the production instance (likely from earlier dashboard preview or
      spike testing — `last_active_at: null` confirms neither has done a real browser sign-in yet).
      No pre-create/invite needed; roles are pre-set so first real sign-in will already carry the claim.
      **Gotcha:** the older `PATCH /users/{id}` with `public_metadata` in the body is deprecated and
      silently no-ops — must use the dedicated `PATCH /users/{id}/metadata` endpoint instead.
- [x] **Session claim exposing `publicMetadata` configured** (Jul 4). `clerk config patch --instance prod`
      with `{"session":{"claims":{"publicMetadata":"{{user.public_metadata}}"}}}`. Resulting session
      config: `{"allowed_clock_skew":5,"claims":{"publicMetadata":"{{user.public_metadata}}"},"lifetime":60}`.
      This shape keeps `lib/clerk-owner.ts` and `lib/receipts/owners.ts` working unchanged — they read
      `session.sessionClaims.publicMetadata.role`, which is now populated.
- [x] **Resolved: build-time publishable key delivery.** `.env.production` at the repo root (gitignored),
      containing `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...`. `npm run build:cf` → `opennextjs-cloudflare
      build` runs `next build` as a subprocess inheriting the parent env; Next.js auto-loads
      `.env.production` and inlines `NEXT_PUBLIC_*` vars into client chunks at build time. Confirmed
      empirically (placeholder value found literally inlined in `.open-next/assets/.../*.js` after a real
      build) — see `spike/clerk-publishable-key-build-time`. `wrangler.jsonc`'s `vars` block is NOT the
      right place — that's runtime Worker env, not build-time. `CLERK_SECRET_KEY` remains a genuine
      runtime secret via `wrangler secret put CLERK_SECRET_KEY`, unaffected by any of this.
      **Do not put the four Phase-0 secrets in `.env`/`.env.production` — that file ships into the bundle
      wholesale, which is exactly the Phase 0 problem.**

### Phase 2 — Wire Clerk as the real gate (one deploy, reversible)

- [x] Create `middleware.ts` using `clerkMiddleware()`. The matcher explicitly includes
      `/receipts/:path*`, `/admin/:path*`, **and** `/api/receipts/:path*` — the API path does not match
      `/receipts/:path*` and would be unprotected otherwise. `/api/mobile/*` is intentionally NOT in the
      matcher (separate bearer-token scheme).
      **Deviation from the original plan** (which called for `proxy.ts`): Next.js 16 made `proxy.ts`
      Node.js-only (`runtime = "edge"` is rejected outright with "Proxy always runs on Node.js runtime"),
      but OpenNext-on-Cloudflare-Workers only supports Edge middleware. The legacy `middleware.ts`
      name still defaults to Edge under OpenNext and is the only path that builds today. Spike
      (`spike/clerk-feasibility`, commit `881d51d`) established this. Revisit when OpenNext supports
      Node.js proxy, or when Next.js 17 removes `middleware.ts` entirely.
- [x] Add a real sign-in route at `app/(receipt-system)/receipts/sign-in/[[...sign-in]]/page.tsx` using
      `<SignIn />`. (Note the `(receipt-system)` route group — `app/receipts/sign-in/...` would not
      resolve.) `/receipts/enroll` kept alive as a redirect shim to it, in case it's bookmarked.
- [x] Rewrite `requireReceiptsActor` / `isReceiptsAuthorizedLight` (`lib/receipts/auth.ts`) to resolve
      identity via Clerk's `auth()` (from `@clerk/nextjs/server` — **not** `@clerk/nextjs`, per the spike's
      own gotcha) instead of the CF-Access/cookie/Basic-auth chain. Keep the returned "actor" shaped as an
      email string, so the audit log, cardholder matching, etc. don't need to change.
- [x] Replace `owners.ts`'s array check with `sessionClaims?.publicMetadata?.role === "owner"`.
- [x] Point `/admin`'s guard (`lib/admin-page-auth.ts` / `assertAdminPageAccess`) at the same Clerk +
      owner-role check, folding admin into one identity system instead of a third, separate one. This
      also fixes the `/admin` 500 (broken since the `middleware.ts` deletion) as a side effect, since it'll
      get a real redirect instead of an uncaught throw.
- [ ] **Do not delete Cloudflare Access yet.** Leave the edge policy active through this phase as a
      safety net — if something in the Clerk wiring is wrong, Access still gates the edge and the failure
      mode is "broken app page," not "receipts data exposed." This is what makes Phase 2 reversible:
      rollback = redeploy the previous Worker version (Cloudflare keeps prior deployments; roll back via
      dashboard or `wrangler`).
- [ ] Ship at a quiet time. Verify both you and Taz can sign in for real, on your real devices, before
      moving on.

### Phase 3 — Device trust cleanup

- [ ] Decide whether to delete the web half of `lib/receipts/trusted-devices.ts` (the "remember this
      browser" HMAC cookie) now that Clerk's own session cookie covers the same need. **Recommended: yes**
      — one less custom crypto scheme — but confirm Clerk's session duration (set in Phase 1) actually
      matches what you want before removing the old fallback.
- [ ] Confirm the mobile-pairing "approve this device" step (`complete-pairing` route) now runs through
      the Clerk-based `requireReceiptsActor` from Phase 2 — this should fall out automatically since that
      route already calls `requireReceiptsActor`, but verify it explicitly with a real pairing test.
- [ ] Add an actual expiry to the mobile bearer token (`lib/receipts/mobile-pairing.ts`) — it currently
      has none, only revocation. Unrelated to Clerk itself, but worth bundling in since this code is
      already being touched. Suggest 90 days to 1 year with a silent re-pair prompt.

### Phase 4 — Retire the old mechanisms (after a 2-day burn-in period on Clerk with no issues — decided)

- [ ] Delete the Cloudflare Access application/policy in the dashboard.
- [ ] Delete the `RECEIPTS_AUTH_USERNAME`/`RECEIPTS_AUTH_PASSWORD` Basic-auth code path and secrets.
- [ ] Delete the `ADMIN_PAGE_USERNAME`/`ADMIN_PAGE_PASSWORD` Basic-auth code and secrets.
- [ ] Delete `lib/receipts/owners.ts`'s env-var allowlist path entirely.
- [ ] Remove now-dead Wrangler secrets: `CF_ACCESS_TEAM`, `CF_ACCESS_AUD`, `RECEIPTS_AUTH_USERNAME`,
      `RECEIPTS_AUTH_PASSWORD`, `ADMIN_PAGE_USERNAME`, `ADMIN_PAGE_PASSWORD`, `RECEIPTS_OWNER_EMAILS`.
- [ ] Archive `docs/runbooks/cf-access-app.md` (or delete it) and write a replacement
      `docs/runbooks/clerk-auth.md` documenting the new single-system setup, so the next "sign-in doesn't
      persist" investigation starts from Clerk's dashboard, not a stale CF Access runbook.

## Decisions

1. **Build-time publishable key delivery** — resolved: `.env.production`, confirmed empirically. See
   Phase 1.
2. **Sign-in methods** — email one-time code only. Decided; Google OAuth disabled Jul 4 (was
   half-configured/pending, never completed, would have shown a broken button).
3. **Session duration** — revised Jul 4: 7-day maximum lifetime (free-plan fixed limit; Pro required to
   extend). David chose to stay on the free plan rather than upgrade — accepted weekly re-sign-in as the
   real cost, down from the trusted-device cookie's ~1-year lifetime.
4. **Burn-in length before Phase 4** — 2 days. Decided (shorter than the 2-week default originally
   suggested — David's call).
5. **Clerk instance type** — Production with custom domain `clerk.dazbeez.com`. Decided Jul 4 (reversal
   of an earlier "stay on Development" draft — the same-site session cookie is worth the DNS setup).
6. **Unrelated secrets exposure (Phase 0)** — rotate `ADMIN_PAGE_PASSWORD`, `CLOUDFLARE_TUNNEL_TOKEN`,
   `ANTHROPIC_API_KEY`, `NFC_ADMIN_API_KEY` and move them off the root `.env` file. Higher priority than
   the rest of this plan; doesn't block it either way.

## Rollback

Every phase before Phase 4 is a single deploy or a dashboard-only config change — rollback is "redeploy
the previous Worker version" (Phase 2) or "no-op, nothing shipped yet" (Phase 1, 3 config parts). Phase 4
is the only one that removes fallback paths permanently, which is why it's gated on a burn-in period with
no issues on the new system first.
