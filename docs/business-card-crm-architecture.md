# Business Card CRM Architecture

## Runtime shape

The new business-card ingestion system extends the existing Dazbeez lead-capture architecture instead of creating a parallel silo:

- `dazbeez.com` remains the primary admin surface
- `networking-card/` remains the NFC / hi.dazbeez.com capture app
- both now share the same contact spine through the `CRM_DB` D1 binding

## Main components

### Shared D1 schema

`networking-card/migrations/0007_bespoke_crm.sql` adds:

- `contact_batches`
- `business_card_images`
- `batch_cards`
- `companies`
- `enrichment_runs`
- `enrichment_facts`
- `synergy_analyses`
- `email_drafts`
- `review_tasks`
- `processing_jobs`
- `admin_settings`
- `audit_logs`

It also broadens the legacy `contacts`, `contact_methods`, and `contact_events` tables so the same contact identity can be reused across:

- NFC / QR capture
- OAuth/manual card registration
- public contact form submissions
- paper-card batch ingestion
- admin manual review decisions

### Admin flow

1. `/admin/batches` uploads a composite image.
2. `/admin/api/detect-cards` sends the image to the Cloudflare AI vision model for card boundary detection.
3. The browser crops each detected card from the original upload.
4. `/admin/api/batches` stores the original and cropped images, runs OCR-style extraction on each crop, and creates reviewable `batch_cards`.
5. `/admin/batches/[id]` lets an admin edit extracted fields, mark invalid cards, or explicitly link to an existing contact.
6. `processApprovedBatch()` upserts contacts/companies, stores enrichment facts from official websites, computes deterministic fit scoring, and generates draft-only follow-up emails.

### Public lead unification

`/api/contact` still writes to the legacy `contact_submissions` table for compatibility, but it now also writes into the shared CRM tables so website inquiries join the same identity graph as NFC and paper-card captures.

## Design choices

- Raw D1 access instead of a new ORM, to match the existing repo
- Cloudflare AI binding instead of a native OCR/image stack, to fit the Workers runtime
- Client-side crop generation, because Workers do not provide a native image-processing stack suitable for this workflow
- Deterministic synergy scoring and draft templating, so the last-mile relationship logic stays auditable

## Current limitations

- Card cropping currently uses AI-detected bounds and canvas cropping; it does not perform a full perspective transform
- PDF upload is not enabled yet
- Settings editing is intentionally JSON-first rather than form-heavy
- Provider secrets remain environment-backed rather than editable in the admin UI
