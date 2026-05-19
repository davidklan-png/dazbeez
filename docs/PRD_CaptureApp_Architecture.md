# Capture App — Architecture & Implementation Plan

Companion to [`PRD_CaptureApp.md`](./PRD_CaptureApp.md). This doc is grounded in the
current code; references like `lib/receipts/auth.ts:311` point at exact lines.

## Decisions locked

| # | Decision | Choice |
|---|----------|--------|
| 1 | Device-trust storage | **Extend `trusted_devices`** (add `platform`, `app_version`, `scopes_json`). Reuse `enrollDevice` + HMAC + revocation machinery in `lib/receipts/trusted-devices.ts`. Do **not** create a parallel `mobile_devices` table. |
| 2 | Mobile auth transport | **Bearer token** in `Authorization` header. Same HMAC-signed `{id, actor, exp}` payload as the existing device cookie — only transport differs. |
| 3 | Receipt endpoint | New `POST /api/mobile/receipts/upload` wrapping existing `lib/receipts/*` helpers (`createReceiptRecord`, `uploadOriginal`, `createReceiptFile`). Browser route at `app/api/receipts/upload/route.ts` stays untouched. |
| 4 | Business-card endpoint | New `POST /api/mobile/business-cards/upload`. Backend creates a 1-image, 1-card batch and runs `extractBusinessCardDetails` server-side — iPhone does **not** do detection/cropping. |
| 5 | Card capture UX | **VisionKit `VNDocumentCameraViewController`** in M2 (not deferred to M4). Server gets a clean cropped card image, not a cluttered phone photo. |
| 6 | Source-type encoding | Keep `source = 'mobile_capture'`, `source_type = 'paper_scanned'`, add `upload_origin = 'mobile'`. **Do not** add `ios_app` to the `source_type` enum — it would violate the existing CHECK constraint (`db/receipts/0001_init.sql:22`). |
| 7 | App platform | **SwiftUI native** under `ios/DazbeezCapture/` in this repo. |
| 8 | Local retention | Delete image after successful upload. Encrypted SQLite (GRDB) queue for offline. |
| 9 | Distribution | TestFlight internal. |

## Backend changes (this repo)

### Migrations

`db/receipts/0015_mobile_devices.sql`:
```sql
ALTER TABLE trusted_devices ADD COLUMN platform TEXT;          -- 'web' | 'ios'
ALTER TABLE trusted_devices ADD COLUMN app_version TEXT;
ALTER TABLE trusted_devices ADD COLUMN scopes_json TEXT;

CREATE TABLE mobile_pairing_codes (
  code TEXT PRIMARY KEY,                  -- 6-char human-readable
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,               -- 5 min TTL
  consumed_device_id TEXT,
  consumed_at TEXT
);

ALTER TABLE receipt_records ADD COLUMN device_id TEXT;
ALTER TABLE receipt_records ADD COLUMN client_capture_id TEXT;
ALTER TABLE receipt_records ADD COLUMN captured_at_client TEXT;
ALTER TABLE receipt_records ADD COLUMN upload_origin TEXT;     -- 'web' | 'mobile'

CREATE UNIQUE INDEX idx_receipt_mobile_idempotency
  ON receipt_records(device_id, client_capture_id)
  WHERE device_id IS NOT NULL AND client_capture_id IS NOT NULL;
```

`networking-card/migrations/0012_mobile_capture.sql`:
```sql
ALTER TABLE business_card_images_v2 ADD COLUMN device_id TEXT;
ALTER TABLE business_card_images_v2 ADD COLUMN client_capture_id TEXT;
ALTER TABLE business_card_images_v2 ADD COLUMN captured_at_client TEXT;
ALTER TABLE business_card_images_v2 ADD COLUMN upload_origin TEXT;
ALTER TABLE business_card_images_v2 ADD COLUMN source_app_version TEXT;

CREATE UNIQUE INDEX idx_business_card_mobile_idempotency
  ON business_card_images_v2(device_id, client_capture_id)
  WHERE device_id IS NOT NULL AND client_capture_id IS NOT NULL;
```

### Library additions

In `lib/receipts/trusted-devices.ts`:
- `enrollMobileDevice({ actor, label, platform, appVersion, scopes })` → `{ id, bearerToken }`
- `verifyBearerDevice(headers)` — `Authorization: Bearer <payload>.<sig>` (HMAC + DB revocation)
- Export a `requireMobileActor(headers, requiredScope)` that uses `verifyBearerDevice` and enforces `scopes_json`.

In `lib/crm.ts`:
- Refactor: extract the per-card body of `createBusinessCardBatch` (`lib/crm.ts:709-793`) into `insertBatchCard()` so both the admin composite path and the new mobile single-card path call it.
- Add `createMobileBusinessCardBatch({ actor, deviceId, clientCaptureId, image, eventName, batchName, note, capturedAtClient, appVersion })` → `{ batchId, batchCardId }`.

### Routes

```
POST /api/mobile/auth/start-pairing      (public)             → { code, expiresAt }
GET  /api/mobile/auth/check?code=...     (public)             → { ready, bearerToken? }
POST /api/mobile/auth/complete-pairing   (CF Access required) → consumes code, mints token
POST /api/mobile/auth/revoke             (Bearer)             → revokes own device
GET  /api/mobile/me                      (Bearer)             → { deviceId, actor, scopes, lastSeenAt }
POST /api/mobile/receipts/upload         (Bearer, scope receipt:create)
POST /api/mobile/business-cards/upload   (Bearer, scope business_card:create)
GET  /api/mobile/uploads                 (Bearer, scope upload_status:read_own)

/receipts/pair                           (CF Access required) — pairing web page
```

Pairing UX: app shows `DAZ-7K3M`; user visits `/receipts/pair?code=DAZ-7K3M` in a browser already logged into CF Access, clicks "Pair this iPhone", server consumes the code and returns the bearer token; the iPhone is polling `check?code=...` and stores the token in Keychain.

### Critical idempotency invariant

The mobile receipt route must check the `(device_id, client_capture_id)` unique index **before** the R2 upload (not after, like the browser route at `app/api/receipts/upload/route.ts:81-107`). On retry, the existing receipt is returned with `duplicate: true` and no R2 write happens.

## iPhone app structure

```
ios/DazbeezCapture/
├── App/                  DazbeezCaptureApp.swift, AppEnvironment
├── Pairing/              SFSafariViewController + code polling
├── Capture/              HomeView, ReceiptCaptureView, BusinessCardCaptureView (VisionKit)
├── Queue/                GRDB-backed queue, background URLSession, BGTaskScheduler
├── Networking/           APIClient (Bearer), KeychainTokenStore
├── History/              UploadHistoryView (calls /api/mobile/uploads)
└── Settings/             revoke, server URL, app version
```

Key choices:
- `URLSessionConfiguration.background(_:)` so uploads continue when the app is suspended.
- `waitsForConnectivity = true` for offline-tolerant retries.
- Keychain attr: `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (no iCloud sync).
- `clientCaptureId = UUID()` generated at capture time, never changes on retry.
- No analytics / crash SDK in v1.

## Milestones

| M | Scope | Acceptance |
|---|-------|------------|
| 1 | Backend mobile API (this repo) | `curl` with bearer token uploads receipt + card; duplicate `client_capture_id` returns existing record; `npm run build:cf` passes |
| 2 | iPhone MVP (online only) | Internal user pairs once, captures one receipt + one card, both visible in `/receipts/review` and `/admin/batches` |
| 3 | Offline queue + retry hardening | Airplane-mode capture → reconnect → upload succeeds, no duplicates |
| 4 | Capture quality polish | Image-quality settings, optional batch card mode |
| 5 | TestFlight pilot | 2 users on TestFlight for 1 week, no data loss |

## Risks worth tracking

1. **Single-image card OCR quality.** Mitigation: VisionKit scanner from M2 ensures a deskewed cropped card reaches the existing `extractBusinessCardDetails`.
2. **Pairing-page CF Access policy.** `/receipts/pair` must be inside the Access policy; smoke-test before any TestFlight build.
3. **Card-batch code reuse vs fork.** The mobile path must reuse the extracted `insertBatchCard()` helper so audit / review-task / dedupe logic does not diverge.
4. **R2 orphan on retry.** Idempotency check must precede `uploadOriginal()`.

## Out of scope for v1

Per PRD §3 non-goals: no in-app review, no categorization, no AMEX reconciliation, no exports, no contact enrichment, no full CRM editing, no tax determinations. All of that stays in the web app.
