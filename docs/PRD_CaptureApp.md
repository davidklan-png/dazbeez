Below is a PRD for a **thin Dazbeez Capture iPhone app**. The key design constraint is that the iPhone app should **not** become a second accounting system or CRM. It should be a fast, reliable capture client that sends receipts into the existing receipt module and business cards into the existing CRM/business-card review pipeline.

The receipt system already has a separated `/receipts` module with its own `RECEIPTS_DB`, R2 buckets, auth, upload route, review route, attendees, AMEX reconciliation, exports, and audit log. The business-card system already shares a CRM spine through `CRM_DB`, with `contact_batches`, `business_card_images_v2`, `batch_cards`, companies, contacts, review tasks, processing jobs, and audit logs; the current admin flow stores original/cropped images, runs OCR-style extraction, and creates reviewable `batch_cards`.

# PRD: Dazbeez Capture iPhone App

## 1. Product summary

**Product name:** Dazbeez Capture
**Platform:** iPhone first
**Primary users:** Dazbeez internal users
**Initial deployment:** Internal/TestFlight, not public App Store first
**Primary purpose:** Fast capture of receipts and business cards into the existing Dazbeez backend.

The app should provide two primary actions:

```text
[ Capture Receipt ]
[ Capture Business Card ]
```

The app should handle camera capture, local confirmation, offline queueing, and upload retry. The existing Dazbeez web app remains the place for review, correction, extraction, categorization, reconciliation, export, and CRM follow-up.

## 2. Problem statement

The current web app can capture receipts through mobile browser upload, but native capture would improve speed, reliability, and usability, especially for:

```text
receipts at point of purchase
business cards at events
batch capture
offline or unstable network conditions
fewer browser/auth interruptions
```

Business cards are especially good candidates for native capture because the current system relies on composite upload, AI-detected bounds, browser crop generation, OCR-style extraction, and later admin review. A native app can send cleaner single-card images or structured batches into that pipeline. 

## 3. Goals

### MVP goals

1. Capture a receipt photo and upload it to the receipt module.
2. Capture a business card photo and upload it to the CRM/business-card pipeline.
3. Provide clear capture acknowledgment.
4. Queue uploads when offline.
5. Retry failed uploads.
6. Preserve original image files.
7. Avoid duplicate uploads through idempotency keys.
8. Show pending/failed upload status without retaining successful-upload history.
9. Keep all accounting/CRM review in the web app.

### Non-goals

The iPhone app should not do these in v1:

```text
receipt accounting review
expense categorization
AMEX reconciliation
monthly export
business-card enrichment
email draft generation
full CRM editing
tax compliance decisions
invoice compliance review
```

Those remain in the existing web/admin modules.

## 4. Target users and use cases

### User: Dazbeez operator

Common receipt use case:

```text
User pays with AMEX or cash
opens Dazbeez Capture
taps Capture Receipt
takes photo
sees “Receipt saved”
continues with work
later reviews details on /receipts/review
```

Common business card use case:

```text
User meets someone at an event
opens Dazbeez Capture
taps Capture Business Card
takes photo
optionally assigns event/batch name
uploads
later reviews extracted contact data in /admin/batches
```

## 5. UX principles

The app should be a **capture tool**, not a review tool.

Use this principle throughout:

```text
Capture now. Review later.
```

Receipt capture should follow the simplified receipt workflow already used in the web module: one receipt per record, file first, metadata later. The existing receipt plan already supports a mobile-first, one-receipt-per-record workflow with capture, review, file streaming, extraction, reconciliation, and export milestones. 

## 6. MVP user flows

## 6.1 First launch / pairing flow

### User story

As a Dazbeez user, I want to securely pair my iPhone with the Dazbeez backend so that I can upload receipts and business cards without logging into Cloudflare Access every time.

### Flow

```text
Open app
→ “Pair with Dazbeez”
→ app shows pairing code
→ user enters code on browser pairing page behind Cloudflare Access
→ backend issues mobile device token
→ app stores token in Keychain
→ app shows Capture screen
```

### Requirements

* Device token must be scoped narrowly.
* Token must be revocable.
* Token must not allow exports, deletes, or admin actions.
* Token should have no fixed expiry; revocation is the primary control.
* Bearer token must only be delivered to the polling iPhone, never displayed in the browser.
* Token must be stored securely on-device.
* User should see device name and last sync status.

### Suggested token scopes

```text
receipt:create
business_card:create
device:heartbeat
```

Both capture scopes are available to paired devices in v1. The app should default
to receipt capture on launch.

## 6.2 Receipt capture flow

### User story

As a Dazbeez user, I want to take a receipt photo quickly and know it was saved, without entering accounting details on my phone.

### Flow

```text
Tap Capture Receipt
→ camera opens
→ take photo
→ preview
→ Retake or Use Photo
→ optional payment hint: AMEX / CASH
→ Uploading…
→ Receipt saved
```

### Required fields sent to backend

```text
capture_type = receipt
client_capture_id
device_id
captured_at_client
image_file
sha256_hash if computed locally
payment_hint optional: AMEX / CASH
note optional
app_version
```

### Backend target

```text
POST /api/mobile/receipts/upload
```

or, if the existing route is extended:

```text
POST /api/receipts/upload
```

### Expected backend behavior

The backend should create:

```text
receipt_records row
R2 original image
audit log entry
status = needs_review
source = mobile_capture
source_type = paper_scanned
upload_origin = mobile
payment_path = provided hint or UNKNOWN
```

The existing receipt module already has R2 storage, receipt records, upload API, review pages, and audit log as core pieces of the architecture. 

## 6.3 Business card capture flow

### User story

As a Dazbeez user, I want to capture a business card and send it to the existing CRM review pipeline.

### Flow

```text
Tap Capture Business Card
→ camera opens
→ take photo
→ preview
→ Retake or Use Photo
→ active event/batch is applied
→ Uploading…
→ Business card saved
```

### Required fields sent to backend

```text
capture_type = business_card
client_capture_id
device_id
captured_at_client
image_file
sha256_hash if computed locally
batch_id optional
event_name required once event mode is active
note optional
app_version
```

### Backend target

Preferred new endpoint:

```text
POST /api/mobile/business-cards/upload
```

Alternative, if reusing admin namespace:

```text
POST /admin/api/batches/mobile
```

### Expected backend behavior

The backend should create or update:

```text
contact_batches
business_card_images_v2
batch_cards
processing_jobs
audit_logs
```

The existing business-card architecture already uses `contact_batches`,
`business_card_images_v2`, `batch_cards`, review tasks, processing jobs, and
audit logs in the shared `CRM_DB` contact spine.

Event/batch capture is required on day one. Once the user registers or selects an
event in the app, that event applies to all subsequent business-card scans until
the user changes or clears the active event.

## 6.4 Offline queue flow

### User story

As a user, I want photos captured even when Wi-Fi or mobile connectivity is bad.

### Flow

```text
Capture photo
→ no network detected
→ save to local encrypted queue
→ show “Saved on device. Will upload when online.”
→ retry automatically
→ show “Uploaded”
```

### Requirements

* Queue stores image plus metadata.
* Queue uses `client_capture_id` for idempotency.
* Queue retries with exponential backoff.
* User can manually retry.
* User can delete a queued item before upload.
* Successfully uploaded images should be removed from local storage.

## 6.5 Upload status

### User story

As a user, I want to know what is still pending or failed, without keeping a local
history after successful upload.

### UI

```text
⟳ Receipt waiting for network 15:02
⚠ Business card upload failed
```

Successful uploads are removed from local history after the user sees the final
status. Duplicate retries should surface as `Already uploaded` and then clear
from local history.

### Statuses

```text
queued
uploading
uploaded
failed
duplicate
```

## 7. Functional requirements

## 7.1 Capture modes

The app must support:

```text
receipt capture
business card capture
```

Later optional modes:

```text
multi-page receipt
invoice/PDF import from Files
```

## 7.2 Image handling

MVP:

```text
capture image
preview image
retake
upload original image
JPEG-only app upload
target payload under 500 KB
```

Business-card capture should use VisionKit document scanning/crop in v1. Receipt
capture can use a simpler camera flow, but should still send JPEG only and target
files under 500 KB. Cloudflare resizing remains the backend fallback. The backend
should preserve the uploaded JPEG.

## 7.3 Receipt metadata

At capture, only allow optional lightweight hints:

```text
AMEX
CASH
Note
```

Do not require:

```text
merchant
amount
date
category
attendees
invoice registration number
business purpose
```

Those belong in `/receipts/review`.

## 7.4 Business card metadata

At capture, allow optional:

```text
active event/batch
note
```

An event/batch must be available on day one. Once selected or registered, the
active event applies to subsequent card scans until changed or cleared.

Do not require:

```text
name
company
email
phone
title
```

Those belong in the existing review pipeline.

## 7.5 Idempotency

Every capture must have:

```text
client_capture_id = UUID generated on device
device_id
sha256_hash if available
```

Backend should enforce:

```text
unique(device_id, client_capture_id)
```

If the same upload retries, backend should return the existing record instead of creating a duplicate.

## 7.6 Acknowledgment messages

Every capture must show one of:

```text
Photo captured.
Uploading…
Saved.
Saved on device. Will upload when online.
Upload failed. Please retry.
```

No silent no-op is allowed.

## 8. Backend API requirements

## 8.1 Mobile auth

Add a mobile-device auth layer that uses Cloudflare browser auth only for pairing.
After pairing, the iPhone uses a narrowly scoped bearer token backed by the
existing `trusted_devices` revocation model.

### Required endpoints

```text
POST /api/mobile/auth/start-pairing
GET  /api/mobile/auth/check?code=...
POST /api/mobile/auth/complete-pairing
POST /api/mobile/auth/revoke
GET  /api/mobile/me
```

### Token storage

Backend:

```text
trusted_devices extended with platform, app_version, scopes_json
mobile_pairing_codes for short-lived pairing codes
```

iPhone:

```text
Keychain
```

### Token policy

* Do not store the bearer token server-side; verify HMAC, then check the trusted-device row for revocation.
* Token can be revoked from web settings.
* Token is scoped to capture/upload only.
* Token has no fixed expiry; explicit revocation is the primary control.

## 8.2 Receipt upload endpoint

```text
POST /api/mobile/receipts/upload
```

Request:

```multipart
file
client_capture_id
device_id
captured_at_client
payment_hint optional: AMEX / CASH
note optional
app_version
```

Response:

```json
{
  "ok": true,
  "receiptId": 123,
  "status": "needs_review",
  "reviewUrl": "/receipts/review/123",
  "duplicate": false
}
```

## 8.3 Business card upload endpoint

```text
POST /api/mobile/business-cards/upload
```

Request:

```multipart
file
client_capture_id
device_id
captured_at_client
batch_id optional
event_name required once event mode is active
note optional
app_version
```

Response:

```json
{
  "ok": true,
  "batchId": 123,
  "businessCardImageId": 456,
  "reviewUrl": "/admin/batches/123",
  "duplicate": false
}
```

## 8.4 Device upload status endpoint

```text
GET /api/mobile/uploads
```

Returns pending or failed uploads for this device if server-side status is needed.
The iPhone should not keep a successful-upload history.

## 9. Data model additions

## 9.1 Trusted mobile devices

```sql
ALTER TABLE trusted_devices ADD COLUMN platform TEXT;      -- 'web' | 'ios'
ALTER TABLE trusted_devices ADD COLUMN app_version TEXT;
ALTER TABLE trusted_devices ADD COLUMN scopes_json TEXT;

CREATE TABLE mobile_pairing_codes (
  code TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_device_id TEXT,
  consumed_at TEXT
);
```

## 9.2 Receipt additions

Add to `receipt_records` if missing:

```text
source = mobile_capture
source_type = paper_scanned
device_id
client_capture_id
captured_at_client
upload_origin = mobile
```

Add unique index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_mobile_idempotency
ON receipt_records(device_id, client_capture_id)
WHERE device_id IS NOT NULL AND client_capture_id IS NOT NULL;
```

## 9.3 Business card additions

Add to `business_card_images_v2`:

```text
device_id
client_capture_id
captured_at_client
upload_origin = mobile
source_app_version
```

Add unique index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_card_mobile_idempotency
ON business_card_images_v2(device_id, client_capture_id)
WHERE device_id IS NOT NULL AND client_capture_id IS NOT NULL;
```

## 10. Security and privacy requirements

The app handles financial documents and personal contact data.

Required:

```text
store token in Keychain
narrow token scopes
no analytics SDK in v1
no ad tracking
Apple crash reporting only
no third-party crash reporting
delete local image after successful upload by default
encrypted local queue
clear camera permission reason
clear privacy policy
device revoke screen in web admin/settings
```

The app should not request full photo library access in v1 unless needed. Prefer camera capture and explicit file/image picker.

## 11. Compliance requirements

For receipts:

* Preserve the original uploaded image.
* Compute/store SHA-256 server-side.
* Store upload timestamp and actor/device.
* Create audit log event.
* Do not allow mobile app to alter reviewed/exported records.
* Do not make tax determinations in the app.
* Use web review for Japanese tax/accountant workflows.

The receipt module already uses immutable-style R2 key patterns, R2 original storage, receipt records, and a receipt audit log in its implementation plan. 

For business cards:

* Preserve original card image.
* Store upload actor/device.
* Use review pipeline before creating/updating final contacts.
* Keep draft-only follow-up logic in the web/admin side.

The business-card architecture explicitly keeps deterministic scoring and draft templating auditable, and places review/editing in the admin flow. 

## 12. App screens

### 12.1 Home

```text
Dazbeez Capture

[ Capture Receipt ]
[ Capture Business Card ]

Upload queue
Settings
```

### 12.2 Capture receipt

```text
Camera
Preview
Retake
Use Photo
Optional: AMEX / CASH
Upload status
```

### 12.3 Capture business card

```text
Camera
Preview
Retake
Use Photo
Active event/batch
Upload status
```

### 12.4 Upload queue

```text
Queued
Uploading
Uploaded
Failed
Retry
Delete local draft
```

### 12.5 Settings

```text
Signed in as
Device name
Server URL
App version
Clear uploaded local files
Revoke device
Privacy policy
```

## 13. Technical recommendation

### Preferred app stack

```text
SwiftUI native iPhone app
```

Why:

```text
best camera UX
best offline queue control
Keychain integration
TestFlight-ready
small internal app
```

### Backend

Keep existing Cloudflare/Next.js backend.

Add only:

```text
mobile auth
mobile receipt upload endpoint
mobile business-card upload endpoint
device management
idempotency fields
```

Do not create a separate backend for the app.

## 14. Milestones

### Milestone 1 — Backend readiness

Deliver:

```text
trusted_devices mobile extensions
mobile_pairing_codes table
device pairing/token flow
receipt mobile upload endpoint
business-card mobile upload endpoint
idempotency checks
audit log events
```

Acceptance:

```text
curl can upload one receipt with mobile token
curl can upload one business card with mobile token
duplicate client_capture_id returns existing record
```

### Milestone 2 — iPhone MVP

Deliver:

```text
SwiftUI app shell
pairing/auth
receipt capture
business-card capture
upload status
local queue
```

Acceptance:

```text
internal user can capture receipt and see it in /receipts/review
internal user can capture business card and see it in /admin/batches
```

### Milestone 3 — Offline and retry hardening

Deliver:

```text
encrypted local queue
automatic retry
manual retry
failed-upload diagnostics
local cleanup after success
```

Acceptance:

```text
capture offline
reconnect
upload succeeds
no duplicate backend rows
```

### Milestone 4 — Capture quality improvements

Deliver:

```text
document scanner mode
optional crop
image quality settings
event/batch ergonomics
```

Acceptance:

```text
business-card OCR/review quality improves compared with raw camera photo
```

### Milestone 5 — TestFlight pilot

Deliver:

```text
TestFlight build
privacy policy
device revoke UI
pilot checklist
known issues log
```

Acceptance:

```text
2 Dazbeez users install through TestFlight
one-week pilot captures real receipts and cards
no data loss
```

## 15. Major architecture choices and remaining confirmations

### Decision 1: Native SwiftUI vs React Native/Expo vs PWA wrapper

Recommendation: **SwiftUI native**.

Reason: this is a small internal app where camera capture, offline queueing, Keychain, and reliability matter more than UI reuse.

Current direction:

```text
Build a native SwiftUI app under ios/DazbeezCapture.
```

### Decision 2: Authentication model

Options:

1. Cloudflare Access browser session inside app.
2. App-specific mobile device token after pairing.
3. Manual long-lived API token copied into app.

Recommendation: **device pairing + scoped mobile token**.

Current direction:

```text
Pair through Cloudflare Access in the browser, then issue a scoped mobile bearer token.
```

### Decision 3: Business-card endpoint path

Options:

```text
POST /api/mobile/business-cards/upload
POST /admin/api/batches/mobile
reuse /admin/api/batches
```

Recommendation: **new `/api/mobile/business-cards/upload` endpoint** that writes into the existing CRM tables.

Current direction:

```text
Create a clean mobile API namespace.
```

### Decision 4: Receipt endpoint path

Options:

```text
extend /api/receipts/upload
create /api/mobile/receipts/upload
```

Recommendation: **create `/api/mobile/receipts/upload`** and reuse lower-level receipt storage/db functions internally.

Current direction:

```text
Create a separate mobile upload API and reuse lower-level receipt helpers.
```

### Decision 5: Local retention policy

Options:

```text
delete local image after successful upload
keep local copy for 7 days
manual clear only
```

Recommendation: **delete after upload by default and keep no successful-upload history**.
Pending and failed queue items remain visible until they upload or the user deletes
them.

Current direction:

```text
Delete captured images after successful upload and keep no successful-upload history.
```

### Decision 6: Offline queue scope

Options:

```text
no offline queue
queue only while app open
persistent encrypted queue
```

Recommendation: **persistent encrypted queue** for MVP if native app is worth building.

Current direction:

```text
Persistent encrypted offline queue from day one.
```

### Decision 7: Business card capture mode

Options:

```text
single-card only
batch capture
composite image capture
```

Recommendation: **event/batch capture on day one**.
Once an event is registered or selected, it applies to all subsequent card scans
until the user changes or clears the active event.

Current direction:

```text
Event/batch capture is required for MVP.
```

### Decision 8: Image processing

Options:

```text
raw camera image only
document scanner crop
automatic deskew/perspective correction
```

Recommendation: **VisionKit document scanner/crop for MVP business-card capture**.
Receipt capture can start with raw camera image plus preview, but card OCR quality
depends on sending the backend a clean cropped card rather than a cluttered phone
photo.

Current direction:

```text
Business cards use VisionKit scanner/crop in MVP. Receipts use JPEG-only capture.
The app should target files under 500 KB; Cloudflare resizing remains the server fallback.
```

### Decision 9: App distribution

Options:

```text
direct Xcode install
TestFlight internal testing
public App Store
Apple Business Manager / custom app
```

Recommendation: **TestFlight internal**.

Current direction:

```text
Distribute through TestFlight internal testing.
```

### Decision 10: Repository structure

Options:

```text
ios/DazbeezCapture inside existing dazbeez repo
separate dazbeez-ios repo
```

Recommendation: **start in existing repo under `ios/DazbeezCapture`** so backend/API contracts and app code evolve together.

Current direction:

```text
Keep the iOS app in this repo under ios/DazbeezCapture.
```

## 16. Risks

### Risk: App duplicates web functionality

Mitigation: keep app capture-only.

### Risk: Mobile auth becomes too complex

Mitigation: begin with a simple device-token pairing flow and narrow scopes.

### Risk: Offline queue stores sensitive images

Mitigation: encrypt local queue, delete after upload, provide manual purge.

### Risk: Business-card upload bypasses review

Mitigation: mobile upload must create reviewable records only. Do not auto-create final contacts without admin approval.

### Risk: Receipt upload bypasses tax/compliance workflow

Mitigation: mobile upload creates `needs_review`; review/export remain web-only.

### Risk: App Store overhead slows MVP

Mitigation: TestFlight/internal distribution first.

## 17. Acceptance criteria

MVP is complete when:

1. User can pair iPhone with Dazbeez.
2. User can capture one receipt photo.
3. Receipt appears in `/receipts/review` as `needs_review`.
4. User can capture one business card photo.
5. Card appears in `/admin/batches` or equivalent review queue.
6. Failed uploads retry without duplicates.
7. Captures show clear acknowledgment and final status.
8. Local images are deleted after upload and successful-upload history is not retained.
9. Device token can be revoked.
10. No export, accounting finalization, CRM finalization, or deletion is possible from the app.
11. Existing web receipt and CRM workflows remain unchanged.
12. `npm test` and `npm run build:cf` pass for backend changes.

## 18. Recommendation

Proceed with:

```text
SwiftUI app
code-only pairing + scoped mobile token with no fixed expiry
/api/mobile/* namespace
persistent encrypted offline queue
delete local images after successful upload and keep no successful-upload history
receipt-default home screen
AMEX/CASH receipt hint UI
JPEG-only uploads targeting under 500 KB
event/batch business-card capture on day one
Apple crash reporting only
TestFlight internal distribution
same repo under ios/DazbeezCapture
```

This gives you a practical capture app without turning the phone into a second accounting system or CRM.
