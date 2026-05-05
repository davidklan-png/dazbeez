# Receipt Module

Internal expense management system at `/receipts`. Replaces monthly paper-receipt composite-scan with mobile-first, one-receipt-per-record capture, AMEX reconciliation, and accountant export.

## Routes

| Route | Purpose |
|-------|---------|
| `/receipts` | Dashboard |
| `/receipts/capture` | iPhone-friendly receipt capture form |
| `/receipts/review` | Review and correction queue |
| `/receipts/amex` | AMEX statement import |
| `/receipts/reconcile` | AMEX–receipt reconciliation |
| `/receipts/export` | Monthly accountant export and archive |
| `/receipts/settings` | Category and export settings |

All routes and `/api/receipts/*` are protected, noindexed, and not linked from the public site.

## Authentication

**Production:** Cloudflare Access application protecting `dazbeez.com/receipts*` and `dazbeez.com/api/receipts*`. The Worker validates `Cf-Access-Jwt-Assertion` JWT against the JWKS endpoint. Set as Wrangler secrets:

```
npx wrangler secret put CF_ACCESS_TEAM   # e.g. yourteam.cloudflareaccess.com
npx wrangler secret put CF_ACCESS_AUD    # from the CF Access application settings
```

**Local dev:** HTTP Basic Auth fallback. Add to `.dev.vars`:

```
RECEIPTS_AUTH_USERNAME=receipts
RECEIPTS_AUTH_PASSWORD=<your-local-password>
```

If neither `CF_ACCESS_TEAM` nor `RECEIPTS_AUTH_USERNAME` is configured, the module denies all access (fail-closed).

## Cloudflare Bindings

Add to `wrangler.jsonc` after running `npx wrangler d1 create dazbeez-receipts` and creating the R2 buckets:

```jsonc
{
  "d1_databases": [
    {
      "binding": "RECEIPTS_DB",
      "database_name": "dazbeez-receipts",
      "database_id": "<from wrangler d1 create>",
      "migrations_dir": "db/receipts"
    }
  ],
  "r2_buckets": [
    { "binding": "RECEIPTS_BUCKET", "bucket_name": "dazbeez-receipts" },
    { "binding": "RECEIPTS_ARCHIVE_BUCKET", "bucket_name": "dazbeez-receipts-archive" }
  ]
}
```

Then run `npm run cf-typegen` to regenerate `cloudflare-env.d.ts`.

## Database Migrations

```bash
# Create the D1 database (once)
npx wrangler d1 create dazbeez-receipts

# Apply migrations locally
npx wrangler d1 migrations apply RECEIPTS_DB --local

# Apply migrations to production
npx wrangler d1 migrations apply RECEIPTS_DB
```

Migrations live in `db/receipts/` and follow the `NNNN_description.sql` naming convention.

## R2 Buckets

```bash
# Create working and archive buckets (once)
npx wrangler r2 bucket create dazbeez-receipts
npx wrangler r2 bucket create dazbeez-receipts-archive
```

Original receipt images are stored in `RECEIPTS_BUCKET` with a key pattern of `receipts/{YYYY}/{MM}/{id}/{uuid}-{filename}` and are never overwritten. Finalized monthly export bundles go to `RECEIPTS_ARCHIVE_BUCKET`.

## lib/receipts namespace

| File | Purpose |
|------|---------|
| `types.ts` | All TypeScript types |
| `auth.ts` | CF Access JWT validation + basic auth fallback |
| `auth-request.ts` | Server-side `assertReceiptsPageAccess()` helper |
| `db.ts` | D1 data access |
| `storage.ts` | R2 upload/download/archive |
| `validation.ts` | File type/size and field validation; AMEX CSV parsing |
| `audit.ts` | Audit log write/read |
| `extraction.ts` | Pluggable OCR/LLM provider abstraction |
| `reconciliation.ts` | AMEX statement matching logic |
| `export.ts` | Monthly CSV generation, SHA-256 hashing |

## Implementation Milestones

1. **Isolated shell** — route group, auth, lib stubs, noindex ✓
2. **Storage and database** — wrangler bindings, D1 schema, upload API
3. **Capture and review** — mobile capture form, review screen
4. **AMEX import and reconciliation** — CSV import, matching, reconciliation UI
5. **Monthly export and archive** — CSV bundle, SHA-256 manifest, archive bucket
6. **Structured extraction** — pluggable OCR/LLM provider

## Security Notes

- `/receipts` routes are not linked from the public site and are not indexed by search engines
- `robots.ts` disallows `/receipts/`
- Middleware adds `X-Robots-Tag: noindex, nofollow` to all receipt responses
- Receipt layout re-asserts auth server-side on every page render
- Every API route re-asserts auth from the request headers
- R2 originals are never overwritten; key collisions throw before upload
- All edits and state changes write to `receipt_audit_log`
