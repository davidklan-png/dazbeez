import Foundation

/// Encrypted persistent upload queue.
///
/// This file is a placeholder for the GRDB-backed queue scheduled for M3 of
/// the PRD. The plan:
///
///   - SQLite database opened with SQLCipher / SQLiteEncryptionExtension
///   - Schema: `captures(id, kind, client_capture_id, file_path, metadata_json,
///                          status, retry_count, next_retry_at, created_at)`
///   - Retries via `URLSessionConfiguration.background(_:)` with
///     `waitsForConnectivity = true`
///   - `BGTaskScheduler` "com.dazbeez.capture.queue-drain" to trigger periodic
///     drains when the app is suspended
///   - On `uploaded`, delete the local file and remove the row so the
///     app keeps no successful-upload history
///   - Statuses surfaced in UI: `queued`, `uploading`, `failed`, `duplicate`
///
/// The MVP online path bypasses the queue and posts directly via
/// `APIClient.uploadReceipt` / `uploadBusinessCard`. M3 makes the queue the
/// only path so offline capture stops dropping events.
enum UploadQueue {
    static let placeholderTodo = "Implement in M3 — see PRD §6.4 and PRD_CaptureApp_Architecture §iPhone app structure"
}
