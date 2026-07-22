# Authentication — Clerk (current spec)

This is the **current** authentication reference for the Dazbeez Worker
(dazbeez.com). It documents how `/receipts/*`, `/admin/*`, `/api/receipts/*`,
and the mobile API are protected today.

For the historical Cloudflare Access / HTTP-Basic setup, see
[cf-access-app.md](cf-access-app.md) (retained only as the rollback/control-plane
reference until Phase 4C). For the migration narrative, see
[clerk-auth-migration.md](clerk-auth-migration.md).

## Identity provider

- **Clerk** is the single auth gate. Production instance is linked to this repo
  via its git remote; the application is "Dazbeez".
- **Custom domain:** `dazbeez.com`. Clerk Frontend API lives at
  `https://clerk.dazbeez.com`; the accounts portal at `https://accounts.dazbeez.com`.
  DNS/SSL/mail for the Clerk domain are verified. `www.dazbeez.com` 308-redirects
  to the apex, so only the apex needs Clerk/Access coverage.
- No secrets appear in this doc. The publishable key is a build-time
  `NEXT_PUBLIC_*` var; the secret key is a Wrangler runtime secret.

## Sign-in methods

Production sign-in is **email one-time code (OTP)** + **password**. Google OAuth
is configured but **not yet production-ready** (pending production OAuth
credentials) and is not a live sign-in path. Username, phone, and passkey sign-in
are off. Session-token lifetime and clock skew are instance config (Clerk
dashboard), not application code.

`publicMetadata.role` is carried in the session JWT, so role checks need no
network call.

## How a request is gated

`middleware.ts` runs `clerkMiddleware` on exactly these path patterns
(`config.matcher`, a static literal Next.js extracts at build time):

- `/receipts/:path*`
- `/admin/:path*`
- `/api/receipts/:path*`
- `/api/mobile/auth/complete-pairing`  ← the **only** `/api/mobile/*` route that is Clerk-matched

For any matched, non-public route the middleware calls `await auth.protect()`,
which redirects signed-out browser users to `/receipts/sign-in` (307) and
rejects signed-out API callers. `auth.protect()` **must** be awaited — without
`await`/`return` its rejection is silently dropped and the request falls through.

### `PUBLIC_ROUTES` — matched routes that skip `auth.protect()`

These stay in the matcher (so `clerkMiddleware` runs and `auth()` is populated)
but skip `auth.protect()` because the handler does its own layered auth:

- `/receipts/sign-in(.*)` — the Clerk-hosted sign-in page.
- `/api/receipts/:id/file`, `/extract`, `/extraction-failed`, `/proof`, `/render`
- `/api/receipts/inbox/:id/promote`

Each of those processor routes independently requires either a valid
`x-receipts-processor-key` header (the Mac MLX consumer) **or** a
Clerk-authenticated operator (`requireReceiptsActor`). Listing them here only
skips `auth.protect()`; it does **not** make them public. Without the exemption,
`auth.protect()` would 404-rewrite the consumer's processor-key requests before
the handler runs (this silently dropped receipts early in Phase 2).

## Handler-level identity

- `requireReceiptsActor()` (`lib/receipts/auth.ts`) — resolves the acting
  operator (primary email → username → Clerk user id). Used by ~30 receipts
  handlers/pages. Throws if there is no Clerk session.
- `isReceiptsAuthorizedLight()` (`lib/receipts/auth.ts`) — a no-DB redirect gate
  used by receipt pages via `assertReceiptsPageAccess` (`lib/receipts/auth-request.ts`),
  defense-in-depth behind Clerk middleware.
- `requireOwnerActor()` / `isOwnerRole()` / `OwnerAuthorizationError`
  (`lib/clerk-owner.ts`) — owner privilege. `isReceiptsOwner()` in
  `lib/receipts/owners.ts` shares the same `isOwnerRole` predicate (single source
  of truth for `publicMetadata.role === "owner"`).

## Mobile API

- `/api/mobile/auth/complete-pairing` — the operator-approval POST from
  `/receipts/pair`. Clerk-matched + non-public + `requireReceiptsActor`.
- All **other** `/api/mobile/*` routes are intentionally **outside** the Clerk
  matcher and use their own auth: a **device bearer token** (`/api/mobile/me`,
  `/revoke`, `/receipts/upload`, `/business-cards/upload`) or a **pairing code**
  (`/start-pairing`, `/check`). They must not be added to the matcher.

## Roles

- **owner** (`publicMetadata.role === "owner"`) — full `/admin` (CRM console),
  admin API (`/admin/api/*`, `/admin/images/[id]`), and the all-devices view +
  cross-user revoke in receipts trusted-devices.
- **member** (any other signed-in user) — receipts only; scoped to their own
  data. Admin pages return a deliberate 404 (`notFound()`); admin API/image
  routes return **403**.

### Admin owner enforcement

Clerk middleware verifies the caller is **signed in**; it does **not** check the
owner role. Owner enforcement happens in the handler/page:

- Admin pages/layout: `assertAdminPageAccess()` → `requireOwnerActor()`. A
  signed-in non-owner is handled intentionally via `notFound()` (404
  concealment), never an unhandled 500.
- Admin API + image routes (`/admin/api/batches`, `/admin/api/detect-cards`,
  `/admin/images/[id]`): a direct, **awaited** `requireOwnerActor()` runs before
  any request-body read, image load, or CRM/provider work. A signed-in non-owner
  throws `OwnerAuthorizationError` → **403**.
- Admin server actions (`app/admin/crm-actions.ts`, `app/admin/actions.ts`):
  `getAdminActor()`/`assertAdminPageAccess()` → `requireOwnerActor()`; a non-owner
  fails before any mutation.

> The owner check is `await`ed. An un-awaited `requireOwnerActor()` is a no-op
> security bug — the earlier `assertAdminPageAccessFromHeaders` shim was called
> without `await` in three handlers, which let signed-in non-owners through.
> Phase 4B replaced those with direct awaited calls.

## Direct Worker / preview hostnames

Server-side `auth()` requires `clerkMiddleware` to have run for the request
(Clerk raises `auth_signature_invalid` otherwise), so every handler that calls
`requireReceiptsActor`/`requireOwnerActor` must be covered by `config.matcher`.

Because production uses the **live** `pk_live_…` publishable key (which rejects
`localhost` Origin), neither `next dev` nor `cf:dev` can serve `/receipts/*` —
receipts UI validation must happen on `dazbeez.com`. A direct Worker/preview
hostname is still fail-closed for signed-out requests via Clerk middleware.

## Secrets that must remain

- `CLERK_SECRET_KEY` (Wrangler runtime secret) — Clerk backend calls.
- `RECEIPTS_PROCESSOR_KEY` (Wrangler secret) — authenticates the Mac consumer
  to the processor routes; also held in the consumer `.env`.
- `RECEIPTS_DEVICE_SECRET` (Wrangler secret) — HMAC key for trusted-device
  cookies/tokens.
- `RESEND_API_KEY`, `NFC_ADMIN_API_KEY`, `NFC_ADMIN_API_URL` — email + NFC.
- Consumer side: `CF_API_TOKEN` (Cloudflare **Queues** API, scoped
  `queues_read`+`queues_write` — not an Access token), `CF_ACCOUNT_ID`,
  `CF_QUEUE_ID`, `RECEIPTS_R2_BUCKET`, `MLX_MODEL`, `RECEIPTS_EXTRACT_URL`.

The legacy Access/Basic secrets (`CF_ACCESS_TEAM`, `CF_ACCESS_AUD`,
`RECEIPTS_AUTH_USERNAME/PASSWORD`, `ADMIN_PAGE_USERNAME/PASSWORD`,
`RECEIPTS_OWNER_EMAILS`) are no longer read by any runtime code; their deletion
is a Phase 4C control-plane task, after this code is deployed and verified.

## Transitional note — Cloudflare Access still intercepts complete-pairing

As of the Phase 4A audit, a Cloudflare Access application on this account still
intercepts **`/api/mobile/auth/complete-pairing*`** at the edge (302 → the
Access login, `CF_AppSession` cookie). It does **not** intercept `/receipts`,
`/admin`, or `/api/receipts/*` — Clerk owns those. Because `complete-pairing` is
also Clerk-gated, the Access layer is redundant; Phase 4C will remove the Access
application once its application/policy snapshot is captured (the snapshot is the
open prerequisite — see `clerk-auth-migration.md`). Until then, an operator
approving a pairing may see an additional Access OTP step on top of Clerk.

## Troubleshooting

- **Signed-out `/receipts` or `/admin` redirects to `/receipts/sign-in`** — that
  is Clerk working as intended (307). If it instead 404s, the request lacked a
  browser `Accept` header (raw clients get a 404 from `auth.protect()`); use a
  browser UA.
- **"auth_signature_invalid" / Clerk middleware did not run** — the route is not
  in `config.matcher`. Add it (the handler calls `auth()`/`requireReceiptsActor`).
- **403 on an admin API route for a signed-in user** — `requireOwnerActor()`
  rejected a non-owner. This is correct; grant `publicMetadata.role = "owner"` if
  the user should be an admin.
- **`pk_live` rejects localhost** — expected. Validate receipts UI on
  `dazbeez.com`, not `cf:dev`/`next dev`.
- **Sign-in/session/custom-domain failures** — confirm the Clerk custom domain
  (`dazbeez.com`) DNS/SSL/mail are complete (`clerk deploy status`), the
  publishable key in `wrangler.jsonc`/`.env.production` decodes to
  `clerk.dazbeez.com`, and sign-in/up URLs point at `/receipts/sign-in`.
