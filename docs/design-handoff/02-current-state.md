# Current State Inventory

Reference document. Every route, API, lib module, component, and table that exists today. Don't read top-to-bottom — search for what you need.

## Routes (`app/(receipt-system)/receipts/`)

| Route | File | Server/Client | Current UX state |
|---|---|---|---|
| `/receipts` | `page.tsx` | SSR | Dashboard, 6 quick-link cards + missing-statement alert. Polished. |
| `/receipts/capture` | `capture/page.tsx` | SSR shell, client form | Drag-drop form. Accepts `?payment=AMEX/CASH` and `?mode=rapid`. Works but desktop-biased. |
| `/receipts/review` | `review/page.tsx` | SSR | Lists 50 most recent receipts. Basic table. Needs design. |
| `/receipts/review/[id]` | `review/[id]/page.tsx` | SSR shell, client form | Big form + image viewer. Functional, rough. **The most-used screen after capture.** |
| `/receipts/amex` | `amex/page.tsx` | SSR | CSV upload + statement stats + artifact history. Polished. |
| `/receipts/reconcile` | `reconcile/page.tsx` | SSR shell, client table | Month picker + match table. **Most complex screen.** Data-heavy, functional. |
| `/receipts/export` | `export/page.tsx` | SSR | Blocker checklist + generate/finalize panel. Functional. |
| `/receipts/settings` | `settings/page.tsx` | SSR | Stub linking to devices. Placeholder. |
| `/receipts/settings/devices` | `settings/devices/page.tsx` | SSR | Device list + revoke. Basic. |
| `/receipts/enroll` | `enroll/page.tsx` | SSR | One-time device enrollment. Basic. |

Layout: `app/(receipt-system)/receipts/layout.tsx` wraps all of the above in `<ReceiptShell>` (nav + auth guard).

## API routes (`app/api/receipts/`)

| Method + path | Purpose |
|---|---|
| `POST /api/receipts/upload` | Multipart upload → SHA256 dedup → R2 → D1 row. Returns `{ ok, receiptId, reviewUrl }`. |
| `GET /api/receipts/[id]` | Fetch receipt + attendees. |
| `PATCH /api/receipts/[id]` | Update fields + attendees (rewrites attendee list). Blocked when exported/archived. |
| `DELETE /api/receipts/[id]` | Soft delete (sets `deleted_at`). |
| `POST /api/receipts/[id]/extract` | Trigger Google Cloud Vision OCR. |
| `GET /api/receipts/[id]/file` | Stream original from R2 (image viewer source). |
| `POST /api/receipts/amex/import` | Parse Netアンサー CSV → batch-insert AMEX lines → detect business-trip candidates. |
| `GET /api/receipts/amex/lines/[id]` | Fetch one AMEX line. |
| `POST /api/receipts/reconcile` | Confirm or unlink one AMEX↔receipt match. |
| `POST /api/receipts/reconcile/[month]/manifest` | Generate reconciliation CSV. |
| `POST /api/receipts/reconcile/finalize` | Sign off month (locks edits). |
| `POST /api/receipts/export/month` | Build monthly CSV + ZIP, stage to R2, create draft. |
| `POST /api/receipts/export/[month]` | Finalize export (immutable after). |
| `GET /api/receipts/export/[month]` | Fetch export record. |
| `POST /api/receipts/devices/enroll` | Create trusted-device cookie. |
| `DELETE /api/receipts/devices/[id]/revoke` | Revoke device. |
| `POST /api/receipts/alerts/dismiss` | Snooze missing-statement alert (3 days). |

## Lib modules (`lib/receipts/`)

| Module | Role |
|---|---|
| `auth.ts` | Multipass auth: trusted-device HMAC → CF Access JWT → Basic auth. Exports `requireReceiptsActor`, `isReceiptsAuthorized`, `getReceiptsAuthChallengeHeaders`. |
| `auth-request.ts` | `assertReceiptsPageAccess()` — page-level guard. |
| `trusted-devices.ts` | Device cookie sign/verify, D1 revocation list. |
| `db.ts` | ~60 CRUD functions. Receipts, attendees, AMEX lines, artifacts, exports, business trips, alerts. |
| `db-utils.ts` | `newUuid`, `nowIso`, `stringifyJson`. |
| `validation.ts` | File MIME/size, AMEX CSV parsing, business-trip detection. |
| `categories.ts` | 14-item expense category catalog (JA/EN, attendee + trip rules). |
| `extraction.ts` | Google Cloud Vision OCR. |
| `storage.ts` | R2 upload/download + conditional put dedup. |
| `client-image.ts` | Browser HEIC/HEIF → JPEG + max-2MP resize before upload. |
| `reconciliation.ts` | Merchant fuzzy match + auto-match scoring. |
| `statement-window.ts` | ±2-week date range for receipt↔AMEX matching. |
| `export.ts` | Monthly CSV builder (14 columns). |
| `month-closing.ts` | Month finalization. |
| `reconciliation-signoff.ts` | Reconciliation sign-off. |
| `audit.ts` | `createAuditEntry()` — all mutations logged. |
| `attendee-directory.ts` | Predefined attendee names for autocomplete. |
| `types.ts` | 440 lines of types — read first when building anything. |

## Components (`components/receipts/`)

| Component | Client? | Role |
|---|---|---|
| `receipt-shell.tsx` | client | Top nav, auth guard, breadcrumbs. |
| `receipt-capture-form.tsx` | client | Wraps drop button + success/error states. |
| `receipt-drop-button.tsx` | client | Drag-drop / file picker / base64 → `/upload`. |
| `receipt-capture-success.tsx` | client | Success card + "Add another" (rapid mode). |
| `receipt-review-form.tsx` | client | Big form with debounced PATCH per field + image sidebar. **Slow UX, ripe for redesign.** |
| `attendee-editor.tsx` | client | Add/remove attendees with directory autocomplete. |
| `receipt-review-table.tsx` | client | List 50 receipts. |
| `receipt-image-viewer.tsx` | client | Loads image from `/api/receipts/[id]/file`. |
| `amex-import-form.tsx` | client | CSV upload + month picker. |
| `month-switcher.tsx` | client | Month dropdown. |
| `reconciliation-table.tsx` | client | **Most complex component.** Per-line card with match status, category select, attendee editor, confidence display, bulk confirm. |
| `monthly-export-panel.tsx` | client | Export history + generate/finalize. |
| `device-list.tsx` | client | Device list + revoke. |
| `enroll-device-form.tsx` | client | Device enrollment. |
| `amex-missing-statement-alert.tsx` | client | Dismissible banner. |

## Database tables (`db/receipts/0001_init.sql` through `0012_re_review_flag.sql`)

| Table | What it stores |
|---|---|
| `receipt_records` | One row per receipt. Status: `captured → needs_review → reviewed → reconciled → exported → archived`. Payment paths: `AMEX / CASH / DIGITAL / UNKNOWN`. |
| `receipt_attendees` | One row per attendee per receipt. `is_dazbeez_employee` bit. |
| `amex_statement_lines` | One row per AMEX transaction. Match status: `unmatched / matched / confirmed / no_receipt`. |
| `amex_statement_artifacts` | One row per imported CSV. Status: `pending / parsed / replaced / failed`. |
| `receipt_exports` | One row per month. Status: `draft / finalized`. |
| `business_trip_reports` | Auto-detected trip groupings. Status: `candidate / confirmed / rejected / exported`. |
| `business_trip_report_lines` | Join table: trips ↔ AMEX lines. |
| `amex_line_attendees` | Attendees on AMEX lines (when no matched receipt). |
| `dashboard_alert_dismissals` | Snoozed alerts. |
| `trusted_devices` | Phone enrollments. |
| `expense_categories` | 14-item catalog (synced from `lib/receipts/categories.ts`). |
| `receipt_audit_log` | All mutations. |

## Tests (`tests/receipts/`)

- `validation.test.ts`, `amex-parser.test.ts`, `extraction.test.ts`, `categories.test.ts`, `reconciliation.test.ts`, `statement-window.test.ts`, `merchant-override.test.ts`, `export.test.ts`, `manifest-csv.test.ts`.
- All run with mocked bindings. `npm test` is the PC-side feedback loop.

## Bindings & env (do not modify on PC)

`wrangler.jsonc`:
- `RECEIPTS_DB` (D1)
- `RECEIPTS_BUCKET`, `RECEIPTS_ARCHIVE_BUCKET` (R2)
- `AI` (Workers AI — bound but unused; potential local Vision fallback)

`receipts-env.d.ts`:
- `CF_ACCESS_TEAM`, `CF_ACCESS_AUD` (production auth)
- `RECEIPTS_AUTH_USERNAME`, `RECEIPTS_AUTH_PASSWORD` (local Basic auth)
- `RECEIPTS_DEVICE_SECRET` (trusted-device HMAC)

## Theme tokens (from `app/globals.css`)

```
--bee-yellow:       #F59E0B   (amber-500, primary CTA, focus ring)
--bee-yellow-light: #FBBF24   (amber-400, highlights)
--bee-black:        #1F2937   (gray-800, secondary dark surfaces)
--bee-charcoal:     #111827   (gray-900, primary dark surface)
--background:       #FFFFFF
--foreground:       #111827
```

Focus ring: `:focus-visible { outline: 2px solid var(--bee-yellow); outline-offset: 2px; }` — already applied globally, don't override.
