# Runbook — Cloudflare Access Application for the receipts module

The receipts module relies on a Cloudflare Access application at the edge to gate every `/receipts/*` and `/api/receipts/*` request. The Worker only verifies the JWT after Access lets the request through — so when sign-in "doesn't persist", the bug is almost always in the **Application configuration in the dashboard**, not in the receipts code.

This runbook is the source-of-truth for what that Application config should be. The repo cannot pin it (it lives entirely in Cloudflare's dashboard), so without this doc it drifts silently and breaks sessions in ways that look like receipts bugs.

## What Access does here

1. Intercepts every request to the configured hostname(s) + path(s) below.
2. If the request has no valid `CF_Authorization` cookie → challenge the user via the configured Identity Providers (IdP).
3. On success → set `CF_Authorization` (JWT) and `CF_App_Auth` (session) cookies on the application hostname.
4. Forward the original request to the Worker, with `Cf-Access-Jwt-Assertion` header attached.
5. The Worker (`lib/receipts/auth.ts:isCfAccessTokenAcceptable`) verifies the JWT signature against `${CF_ACCESS_TEAM}/cdn-cgi/access/certs`, the issuer, the audience (`CF_ACCESS_AUD`), and the expiry.

The receipts-level `receipts_device` cookie (HMAC-signed, 1 year) is set by `/api/receipts/devices/enroll` **after** the user has already passed Access. It is irrelevant to the Access OTP loop — it only matters once Access is satisfied.

## Reference: what the dashboard config should be

> Below, anything marked `[VERIFY IN DASHBOARD]` could not be derived from the repo. Confirm the live value matches.

### Application

| Field | Expected | Live | Read from |
|---|---|---|---|
| **Application name** | `Dazbeez Receipts` (or similar) | `[VERIFY IN DASHBOARD]` | Zero Trust → Access → Applications |
| **Type** | Self-hosted | `[VERIFY IN DASHBOARD]` | Same |
| **Session duration** | `24 hours` or longer (NOT "browser session" — that ends on tab close, which on iOS Safari means every cold start re-challenges) | `[VERIFY IN DASHBOARD]` ⚠️ **prime suspect for "doesn't persist" bugs** | Same → Settings → Application session duration |
| **Same-site attribute** | `Lax` (NOT `Strict` — `Strict` drops the cookie when the OTP email link redirects in) | `[VERIFY IN DASHBOARD]` | Same → Additional settings → Same-site |
| **HTTP only** | `Yes` | `[VERIFY IN DASHBOARD]` | Same → Additional settings |
| **Cookie domain** | _leave empty_ (use the request hostname) — setting it to a parent domain can break subdomain scoping | `[VERIFY IN DASHBOARD]` | Same → Additional settings → Cookie domain |

### Public hostnames (the path Access gates)

Both must be listed, because the Worker is deployed on both:

| Hostname | Status |
|---|---|
| `dazbeez.com/receipts*` | `[VERIFY IN DASHBOARD]` |
| `dazbeez.com/api/receipts*` | `[VERIFY IN DASHBOARD]` |
| `www.dazbeez.com/receipts*` | `[VERIFY IN DASHBOARD]` — if users sometimes land on `www.`, this MUST be covered |
| `www.dazbeez.com/api/receipts*` | `[VERIFY IN DASHBOARD]` — same |

⚠️ **Cookie scoping bug pattern**: if the Application covers `dazbeez.com` but the user navigates to `www.dazbeez.com` (or vice versa), the `CF_Authorization` cookie set on one hostname is not sent on requests to the other. The Worker handles both, so Access must too. Either cover both explicitly, or use a redirect rule to canonicalise to one.

### Identity Providers

| IdP | Status | Notes |
|---|---|---|
| **One-time PIN (email)** | `[VERIFY IN DASHBOARD]` — almost certainly enabled, given the "this one-time pin has already been used!" error seen in production | Built-in; requires an email route. The "already been used" error specifically means the same OTP link was clicked twice — which happens when the cookie didn't persist after the first click, so the user re-clicks. |
| **Google** | `[VERIFY IN DASHBOARD]` | If enabled, Google session duration matters too — when Google's session expires, Access re-challenges regardless of its own session length. |
| **Other IdPs** | `[VERIFY IN DASHBOARD]` | List whatever else is enabled. |

### Policies

| Policy | Expected | Live |
|---|---|---|
| Default policy | `Allow` for the receipts owner email(s) (comma-separated). Currently `david.klan@gmail.com,tazukowen@gmail.com` per `RECEIPTS_OWNER_EMAILS`. | `[VERIFY IN DASHBOARD]` |
| Service-token policy (machine access) | If the Mac MLX consumer hits `/api/receipts/*` through this same Access app, a separate policy must allow the Access service token. See `docs/runbooks/receipts-extraction-rollout.md` step 3. | `[VERIFY IN DASHBOARD]` |

> Note: `RECEIPTS_OWNER_EMAILS` (Worker secret) controls who sees the **admin** devices view inside the receipts module. The Access **policy** controls who can reach the receipts module at all. They are independent — both must list everyone who should have access.

## Code-side config (already in the repo)

These are the only CF Access values the Worker needs. They're set as Wrangler secrets and read in `lib/receipts/auth.ts`.

| Secret | Purpose | How to set |
|---|---|---|
| `CF_ACCESS_TEAM` | Team domain used to fetch the JWKS (e.g. `dazbeez.cloudflareaccess.com`). Must NOT include scheme or trailing slash. | `npx wrangler secret put CF_ACCESS_TEAM` |
| `CF_ACCESS_AUD` | Audience tag from the Access Application's settings. The JWT `aud` claim must match this exactly. | `npx wrangler secret put CF_ACCESS_AUD` |

If either is unset, `isCfAccessTokenAcceptable` returns `{ ok: false }` for every request and Access JWTs are effectively ignored — the module then falls back to the HMAC device cookie / Basic auth paths. Fail-closed if none of those are configured either.

## How to read the live config

Most fields are read-only via `wrangler` (it has no `access` subcommand). Two options:

### Option A — Dashboard

Zero Trust → Access → Applications → [the receipts app]. Every field in the table above is on that page or its Settings sub-page.

### Option B — Cloudflare API (scriptable)

Requires an API token with **Account → Access → Apps → Read**. The Queues-scoped token in `scripts/receipts-consumer/.env` cannot do this — use `wrangler`'s OAuth by running the curl with `--env-file=/dev/null` after `wrangler login`, or create a dedicated read-only token.

```bash
# List all Access apps on the account
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" | jq '.result[] | {id, name, type, domain, session_duration, auto_redirect_to_identity}'

# Read one app's full config (replace APP_ID from above)
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${APP_ID}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" | jq '.result'

# Read the app's policies (who is allowed)
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${APP_ID}/policies" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" | jq '.result'

# Read enabled identity providers
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/identity_providers" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" | jq '.result[] | {name, type}'
```

## Failure-mode playbook

### "This one-time pin has already been used!" + sign-in doesn't persist

The OTP email link was clicked twice. That happens when the cookie didn't persist after the first click — the user lands back on the Access challenge and clicks the same link again.

**Order of investigation:**

1. **Session duration** — if it's "browser session" or under ~1h, that's the bug. Bump to `24 hours`. Most common root cause.
2. **Hostname coverage** — confirm the Application covers the exact hostname the user is hitting (including or excluding `www.`). If users land on both, either cover both or add a redirect rule to canonicalise.
3. **SameSite** — confirm it's `Lax`, not `Strict`. `Strict` breaks the OTP email link click because the cross-site navigation drops the cookie.
4. **Client side** — for iOS Safari specifically: Settings → Safari → "Block All Cookies" (off), "Prevent Cross-Site Tracking" (try off as a test), and confirm the user isn't in a Private Browsing tab. Chrome and Firefox on iOS use the same WebKit engine but configure ITP differently — if it works in one of those, it's Safari-specific.
5. **IdP session** — if Google (or another IdP) is enabled, its session expiry forces re-auth regardless of the Access session duration.

### "Invalid CF Access JWT" or 401 on every request after sign-in

`CF_ACCESS_TEAM` or `CF_ACCESS_AUD` is wrong / stale (e.g. after recreating the Access app, the AUD changes). Verify the secret values match the dashboard:

```bash
npx wrangler secret list            # confirm both are present
# Values aren't readable back — re-put from the dashboard if in doubt
```

### Mac MLX consumer gets a 302 to an Access login page instead of `200` from `/extract`

The Access Application is gating `/api/receipts/*` at the edge but there's no service-token policy. Either:
- Add a service-token policy on the Access app (see `receipts-extraction-rollout.md` step 3), OR
- Narrow the Access app's path coverage to exclude `/api/receipts/*` and rely on the Worker's own auth (`x-receipts-processor-key`, `CF-Access-Jwt-Assertion` verification).

## When this doc drifts

If you change anything in the Access dashboard — bump session duration, add an IdP, change hostnames — update the corresponding row in the **Reference** table above. That's the whole reason this doc exists: the dashboard config has no source-of-truth in the repo, so without this file the next "sign-in doesn't persist" bug starts from zero.
