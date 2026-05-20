# Dazbeez Capture (iPhone)

SwiftUI native capture app for receipts and business cards. Companion to the
backend mobile API documented in [`../../docs/PRD_CaptureApp.md`](../../docs/PRD_CaptureApp.md)
and [`../../docs/PRD_CaptureApp_Architecture.md`](../../docs/PRD_CaptureApp_Architecture.md).

This directory contains plain Swift sources organized by feature. The Xcode
project (`.xcodeproj`) is **not** committed yet — it must be generated on the
Mac after a one-time setup step (see "Initial Mac setup" below). The sources
are designed to drop straight into an Xcode project with no rearrangement.

## Module layout

```
ios/DazbeezCapture/
├── App/         App entry, environment, root view
├── Pairing/     Pairing flow (DAZ-XXXX code + browser handoff + polling)
├── Capture/     Home, ReceiptCaptureView, BusinessCardCaptureView (VisionKit)
├── Events/      Active event/batch selection for business-card scans
├── Queue/       Persistent encrypted upload queue (GRDB + URLSession background)
├── Networking/  APIClient (Bearer), KeychainTokenStore, server URL config
└── Settings/    Revoke device, app version, privacy policy link
```

## Initial Mac setup

1. Open Xcode → File → New → Project → iOS → App
2. Product Name: `DazbeezCapture`, Interface: SwiftUI, Language: Swift,
   Storage: None (we add GRDB manually).
3. Save the project at this path so the generated folder structure is
   `ios/DazbeezCapture/DazbeezCapture.xcodeproj`.
4. Delete the auto-generated `ContentView.swift` and `DazbeezCaptureApp.swift`
   stubs — the sources here replace them.
5. Add the existing Swift files in this directory to the Xcode project
   (File → Add Files to "DazbeezCapture"... and select the feature folders).
6. Add dependencies via Swift Package Manager:
   - GRDB.swift (`https://github.com/groue/GRDB.swift`) for the encrypted local queue.
7. Configure capabilities in Signing & Capabilities:
   - Background Modes → Background fetch + Background processing
   - Keychain Sharing (default group)
8. Set `Info.plist`:
   - `NSCameraUsageDescription` = "Take photos of receipts and business cards."
9. Configure the server URL in `Networking/AppEnvironment.swift` (or via
   the Settings screen) to point at your Dazbeez deployment.

## Distribution

TestFlight internal testing only for the MVP. See PRD §15 Decision 9.

## Things this scaffold does NOT do (yet)

- It does not include the Xcode project file. That's a one-time Mac step.
- It does not include the encrypted GRDB schema or background URLSession
  delegate plumbing — those are M3 (offline queue) work. The Networking and
  Capture modules currently target the online happy path.
- It does not include any analytics, crash reporting, or third-party SDKs
  beyond GRDB. Apple's built-in crash reporting is the only telemetry.

## Backend contract

| Endpoint | Method | Auth | Used by |
|---|---|---|---|
| `/api/mobile/auth/start-pairing` | POST | none | `PairingViewModel.start()` |
| `/api/mobile/auth/check?code=…` | GET | none | `PairingViewModel.poll()` |
| `/api/mobile/auth/revoke` | POST | Bearer | `SettingsViewModel.revoke()` |
| `/api/mobile/me` | GET | Bearer | `AppEnvironment.refreshDevice()` |
| `/api/mobile/receipts/upload` | POST multipart | Bearer (`receipt:create`) | `UploadQueue.uploadReceipt()` |
| `/api/mobile/business-cards/upload` | POST multipart | Bearer (`business_card:create`) | `UploadQueue.uploadBusinessCard()` |

Pairing is "code only": the iPhone shows `DAZ-XXXX`; an operator types it
into `/receipts/pair` in a browser behind Cloudflare Access. The bearer
token is delivered exclusively to the polling iPhone — it is never shown
in the browser.
