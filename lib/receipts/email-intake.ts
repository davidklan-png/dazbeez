// ADR 0011 — email receipt intake (receipts@dazbeez.com).
//
// Two halves live here:
//   1. recordIntake() — the producer side, called by the Worker `email()`
//      handler. Validates attachments against the SAME policy that gates
//      mobile/desktop capture (upload-policy.ts), writes valid attachments
//      to R2 under an intake key, and inserts email_receipt_intake row(s).
//      Takes injected `db` + `bucket` so it runs in whatever Worker the
//      architect places the email() handler in (see ADR 0011 §3 — placement
//      is an open decision; this function is placement-agnostic).
//   2. listPendingIntake / promoteIntake / rejectIntake — the consumer side,
//      called from /receipts/inbox (Clerk-gated). Promote reuses the existing
//      createReceiptRecord() so an emailed receipt flows through the normal
//      capture → queue → Mac MLX → review pipeline unchanged.
//
// Nothing in email_receipt_intake is a tax record. Only promoteIntake creates
// a receipt_records row (legal_hold + 10-year retention), via the single
// existing insert path. Do not add a second insert path into receipt_records.

import { getReceiptsDb, getReceiptsBucket } from "@/lib/cloudflare-runtime";
import { createReceiptRecord } from "@/lib/receipts/db";
import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso, newUuid, stringifyJson } from "@/lib/receipts/db-utils";
import {
  generateR2Key,
  uploadOriginal,
  sanitizeFilenameForR2,
} from "@/lib/receipts/storage";
import {
  ALLOWED_RECEIPT_MIME_TYPES,
  ALLOWED_RECEIPT_EXTENSIONS,
  MAX_RECEIPT_FILE_BYTES,
  formatFileSize,
} from "@/lib/receipts/upload-policy";
import type {
  CreateReceiptInput,
  EmailIntakeStatus,
  EmailReceiptIntake,
} from "@/lib/receipts/types";

// Hard pre-parse ceiling on the raw MIME message (ADR 0011 "Negative"). This
// is INDEPENDENT of and TIGHTER than the per-attachment MAX_RECEIPT_FILE_BYTES
// (5 MiB) check: it rejects oversized messages before the Worker allocates or
// parses anything. Enforced by the email() handler before recordIntake; kept
// here as the single source of the constant.
export const INTAKE_MAX_MESSAGE_BYTES = 10 * 1024 * 1024; // 10 MiB

// ADR 0011 Phase A body-capture caps. Pragmatic guards against a pathological
// inline-image-laden HTML body bloating D1 rows and the triage UI payload —
// NOT a documented platform hard limit (none was found; if a tighter real
// ceiling surfaces, use it and tell the architect). Applied byte-accurately in
// the Worker via capBody() before recordIntake, so stored bodies are already
// bounded and body_truncated records whether EITHER was cut.
export const INTAKE_BODY_TEXT_MAX_BYTES = 256 * 1024; // 256 KiB
export const INTAKE_BODY_HTML_MAX_BYTES = 512 * 1024; // 512 KiB

// Pending rows older than this are stale and cleaned up by the scheduled job
// (ADR 0011 §6 / open question: 30-day window).
export const INTAKE_STALE_DAYS = 30;

export const INTAKE_STATUSES: readonly EmailIntakeStatus[] = [
  "pending_triage",
  "promoted",
  "rejected",
];

// ─── R2 intake key ───────────────────────────────────────────────────────────

/**
 * Intake object key: `receipts-intake/{YYYY}/{MM}/{intakeId}/{uuid}-{filename}`.
 * Distinct prefix from the promoted-receipt `receipts/...` pattern so intake
 * objects (disposable, no retention) are visually separable in the bucket and
 * cannot be confused with promoted tax-record originals. Sanitization is
 * shared with generateR2Key via sanitizeFilenameForR2 (no second sanitizer).
 */
export function generateIntakeR2Key(
  intakeId: string,
  filename: string,
  receivedAt: string,
): string {
  const date = receivedAt.slice(0, 10); // YYYY-MM-DD
  const [year, month] = date.split("-") as [string, string];
  const safe = sanitizeFilenameForR2(filename || "attachment");
  return `receipts-intake/${year}/${month}/${intakeId}/${newUuid()}-${safe}`;
}

// ─── Pure: attachment classification ────────────────────────────────────────
//
// Mirrors upload-policy.ts validateReceiptFile but operates on
// {filename, contentType, sizeBytes} (no DOM File object — the email handler
// has raw bytes, not a File). Kept in sync with upload-policy by reusing the
// SAME exported constants; do not re-decide accepted types here.

export interface AttachmentSpec {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface AttachmentClassification {
  valid: boolean;
  rejectReason: string | null;
}

export function classifyAttachment(spec: AttachmentSpec): AttachmentClassification {
  if (spec.sizeBytes > MAX_RECEIPT_FILE_BYTES) {
    return {
      valid: false,
      rejectReason: `attachment too large (${formatFileSize(spec.sizeBytes)}); limit ${formatFileSize(MAX_RECEIPT_FILE_BYTES)}`,
    };
  }

  const ext = extOf(spec.filename);
  const mime = spec.contentType;
  const typeErr =
    "attachment type not allowed; accepted: JPEG, PNG, HEIC, PDF";

  // Same rule as validateReceiptFile: a specific MIME must itself be
  // allowlisted; extension is only a fallback for absent/generic MIME.
  if (mime === "" || mime === "application/octet-stream") {
    return (ALLOWED_RECEIPT_EXTENSIONS as readonly string[]).includes(ext)
      ? { valid: true, rejectReason: null }
      : { valid: false, rejectReason: typeErr };
  }
  return (ALLOWED_RECEIPT_MIME_TYPES as readonly string[]).includes(mime)
    ? { valid: true, rejectReason: null }
    : { valid: false, rejectReason: typeErr };
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot).toLowerCase();
}

// ─── Producer: recordIntake (called by the email() handler) ─────────────────

export interface ParsedEmailAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  data: ArrayBuffer;
}

export interface RecordIntakeInput {
  receivedAt: string; // ISO; the message's Date (or now)
  fromAddress: string;
  toAddress: string | null; // destination alias the message arrived on (ADR 0011 follow-up)
  subject: string | null;
  spfPass: boolean;
  dkimPass: boolean;
  rawHeadersJson: string | null;
  // ADR 0011 Phase A: parsed body (already byte-capped by the Worker via
  // capBody). bodyTruncated is true if EITHER part was cut at its cap.
  bodyText: string | null;
  bodyHtml: string | null;
  bodyTruncated: boolean;
  attachments: ParsedEmailAttachment[];
}

/**
 * Persist one inbound email as 1+ email_receipt_intake rows.
 *
 * Fan-out (ADR 0011 §3.4): one row per attachment. A valid attachment is
 * written to R2 (intake key) and its metadata recorded; an invalid one
 * (wrong type / too large) is STILL recorded as a row with a NULL
 * attachment_r2_key + reject_reason, left at pending_triage so a human sees
 * why it can't be promoted (never silently dropped, never auto-rejected).
 * An email with zero attachments records a single row with reject_reason
 * 'no attachment' (§3.5) — visible in the inbox, nothing to promote.
 *
 * Returns the created intake row ids (always ≥1).
 */
export async function recordIntake(
  db: D1Database,
  bucket: R2Bucket,
  input: RecordIntakeInput,
): Promise<string[]> {
  const now = nowIso();
  const createdIds: string[] = [];

  const rowsToInsert: Array<Omit<EmailReceiptIntake, "created_at">> = [];

  if (input.attachments.length === 0) {
    // §3.5: body-only email — record it so it's visible, nothing to promote.
    rowsToInsert.push({
      id: newUuid(),
      received_at: input.receivedAt,
      from_address: input.fromAddress,
      to_address: input.toAddress,
      subject: input.subject,
      spf_pass: input.spfPass ? 1 : 0,
      dkim_pass: input.dkimPass ? 1 : 0,
      attachment_r2_key: null,
      attachment_sha256: null,
      attachment_content_type: null,
      attachment_size_bytes: null,
      attachment_filename: null,
      status: "pending_triage",
      reject_reason: "no attachment",
      promoted_receipt_id: null,
      raw_headers_json: input.rawHeadersJson,
      body_text: input.bodyText,
      body_html: input.bodyHtml,
      body_truncated: input.bodyTruncated ? 1 : 0,
    });
  } else {
    for (const att of input.attachments) {
      const verdict = classifyAttachment(att);
      const id = newUuid();

      if (verdict.valid) {
        // Valid → R2 put (intake key, NO retention metadata — this is not a
        // tax record) + full metadata row.
        const key = generateIntakeR2Key(id, att.filename, input.receivedAt);
        await bucket.put(key, att.data, {
          httpMetadata: { contentType: att.contentType },
        });
        rowsToInsert.push({
          id,
          received_at: input.receivedAt,
          from_address: input.fromAddress,
          to_address: input.toAddress,
          subject: input.subject,
          spf_pass: input.spfPass ? 1 : 0,
          dkim_pass: input.dkimPass ? 1 : 0,
          attachment_r2_key: key,
          attachment_sha256: await sha256Hex(att.data),
          attachment_content_type: att.contentType,
          attachment_size_bytes: att.sizeBytes,
          attachment_filename: att.filename,
          status: "pending_triage",
          reject_reason: null,
          promoted_receipt_id: null,
          raw_headers_json: input.rawHeadersJson,
          body_text: input.bodyText,
          body_html: input.bodyHtml,
          body_truncated: input.bodyTruncated ? 1 : 0,
        });
      } else {
        // Invalid → still recorded, NULL r2_key, reason visible, stays
        // pending_triage (NOT auto-rejected) per ADR 0011.
        rowsToInsert.push({
          id,
          received_at: input.receivedAt,
          from_address: input.fromAddress,
          to_address: input.toAddress,
          subject: input.subject,
          spf_pass: input.spfPass ? 1 : 0,
          dkim_pass: input.dkimPass ? 1 : 0,
          attachment_r2_key: null,
          attachment_sha256: null,
          attachment_content_type: att.contentType,
          attachment_size_bytes: att.sizeBytes,
          attachment_filename: att.filename,
          status: "pending_triage",
          reject_reason: verdict.rejectReason,
          promoted_receipt_id: null,
          raw_headers_json: input.rawHeadersJson,
          body_text: input.bodyText,
          body_html: input.bodyHtml,
          body_truncated: input.bodyTruncated ? 1 : 0,
        });
      }
    }
  }

  for (const row of rowsToInsert) {
    await db
      .prepare(
        `INSERT INTO email_receipt_intake
          (id, received_at, from_address, subject, spf_pass, dkim_pass,
           attachment_r2_key, attachment_sha256, attachment_content_type,
           attachment_size_bytes, attachment_filename, status, reject_reason,
           promoted_receipt_id, raw_headers_json, created_at, to_address,
           body_text, body_html, body_truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.received_at,
        row.from_address,
        row.subject,
        row.spf_pass,
        row.dkim_pass,
        row.attachment_r2_key,
        row.attachment_sha256,
        row.attachment_content_type,
        row.attachment_size_bytes,
        row.attachment_filename,
        row.status,
        row.reject_reason,
        row.promoted_receipt_id,
        row.raw_headers_json,
        now,
        row.to_address,
        row.body_text,
        row.body_html,
        row.body_truncated,
      )
      .run();
    createdIds.push(row.id);
  }

  return createdIds;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Consumer: reads + triage actions ───────────────────────────────────────

export async function getIntake(
  db: D1Database,
  id: string,
): Promise<EmailReceiptIntake | null> {
  return db
    .prepare(`SELECT * FROM email_receipt_intake WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<EmailReceiptIntake>();
}

export async function listPendingIntake(
  db: D1Database,
  limit = 200,
): Promise<EmailReceiptIntake[]> {
  const result = await db
    .prepare(
      `SELECT * FROM email_receipt_intake
       WHERE status = 'pending_triage'
       ORDER BY received_at DESC
       LIMIT ?`,
    )
    .bind(Math.min(limit, 500))
    .all<EmailReceiptIntake>();
  return result.results ?? [];
}

/**
 * Build the createReceiptRecord input for a promotable intake row. Pure —
 * extracted so the source/sourceType/status decisions are unit-testable
 * without D1/R2. paymentPath/expenseType are deliberately omitted so
 * createReceiptRecord's "UNKNOWN" defaults apply (email intake never carries
 * them). originalR2Key starts as the INTAKE key and is patched to the standard
 * receipts/... key after the object is copied (see promoteIntake).
 */
export function buildPromoteReceiptInput(intake: EmailReceiptIntake): CreateReceiptInput {
  return {
    capturedBy: intake.from_address,
    source: "email",
    sourceType: "email_attachment",
    status: "captured",
    originalR2Key: intake.attachment_r2_key as string,
    originalSha256: intake.attachment_sha256 as string,
    originalContentType: (intake.attachment_content_type ?? "application/octet-stream") as string,
    originalSizeBytes: (intake.attachment_size_bytes ?? 0) as number,
    originalFilename: intake.attachment_filename ?? undefined,
  };
}

/**
 * Refuse promotion for rows that have nothing to promote or are no longer
 * pending. Throws a plain Error whose message is safe to surface as 409 body.
 * Mirrored as a disabled state in the inbox UI (Promote disabled when
 * attachment_r2_key is NULL) — this is the server authority.
 */
export function assertPromotable(intake: EmailReceiptIntake): void {
  if (intake.status !== "pending_triage") {
    throw new Error(
      `Intake ${intake.id} is already ${intake.status} (only pending_triage may be promoted).`,
    );
  }
  if (!intake.attachment_r2_key) {
    throw new Error(
      `Intake ${intake.id} has no promotable attachment${intake.reject_reason ? ` (${intake.reject_reason})` : ""}.`,
    );
  }
}

/**
 * Promote a triaged intake row into a real receipt.
 *
 * Reuses createReceiptRecord (the single existing insert path; ADR 0011).
 * The promoted receipt then flows through the normal extraction queue → Mac
 * MLX → review pipeline exactly like a mobile capture.
 *
 * R2 handoff (ADR 0011 §2, preferred "copy to standard key" path): the intake
 * object is COPIED to a standard receipts/{y}/{m}/{receiptId}/{uuid}-{filename}
 * key and receipt_records.original_r2_key is patched to point at it, so the
 * intake key pattern never leaks into receipt_records invariants. The intake
 * object is then deleted (move semantics) and the intake row's
 * attachment_r2_key is nulled; the row is kept for audit history at status
 * 'promoted'. createReceiptRecord is "reused, not modified" (ADR), so the
 * copy happens AFTER it returns the new receipt id — the row briefly holds the
 * intake key within this single request, then is patched.
 *
 * Atomicity: consistent with how createReceiptRecord itself handles its own
 * writes (separate awaits for insert/audit, not one batch). The intake status
 * flip carries a `WHERE status = 'pending_triage'` idempotency guard. Residual
 * crash window between createReceiptRecord and the flip is documented in ADR
 * 0011 — a retry in that window would create a duplicate receipt; a future
 * hardening (unique partial index on promoted_receipt_id, or letting
 * createReceiptRecord accept an external batch) closes it.
 */
export async function promoteIntake(
  id: string,
  actor: string,
): Promise<string> {
  const db = getReceiptsDb();
  const bucket = getReceiptsBucket();

  const intake = await getIntake(db, id);
  if (!intake) throw new Error(`Intake ${id} not found.`);
  assertPromotable(intake);

  // Read the intake object so we can copy it to the standard key.
  const originalIntakeKey = intake.attachment_r2_key as string;
  const obj = await bucket.get(originalIntakeKey);
  if (!obj) {
    throw new Error(
      `Intake ${id} attachment object is missing from R2 (key ${originalIntakeKey}).`,
    );
  }
  const bytes = await obj.arrayBuffer();

  // 1. Create the receipt via the canonical path. originalR2Key is the intake
  //    key for now; patched below once we know the standard key.
  const receiptId = await createReceiptRecord(buildPromoteReceiptInput(intake), actor);

  // 2. Copy the object to the standard receipts/... key (retention metadata
  //    IS correct here — this is now a tax record). generateR2Key embeds the
  //    receipt id, matching the rest of the system's key convention.
  const now = nowIso();
  const standardKey = generateR2Key(
    receiptId,
    intake.attachment_filename ?? "attachment",
    now,
  );
  await uploadOriginal(
    standardKey,
    bytes,
    intake.attachment_content_type ?? "application/octet-stream",
  );

  // 3. Patch the receipt's original_r2_key to the standard key.
  await db
    .prepare(
      `UPDATE receipt_records SET original_r2_key = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(standardKey, now, receiptId)
    .run();

  // 4. Flip the intake row (idempotent guard on status). Null the intake key —
  //    the object was moved to the standard key.
  await db
    .prepare(
      `UPDATE email_receipt_intake
         SET status = 'promoted',
             promoted_receipt_id = ?,
             attachment_r2_key = NULL
       WHERE id = ? AND status = 'pending_triage'`,
    )
    .bind(receiptId, id)
    .run();

  // 5. Delete the now-moved intake object. Best-effort: a failure here leaves
  //    a redundant intake object that the 30-day cleanup reaps; it must not
  //    fail the promotion.
  try {
    await bucket.delete(originalIntakeKey);
  } catch (err) {
    console.error("[promoteIntake] failed to delete intake R2 object", {
      key: originalIntakeKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 6. Audit with SPF/DKIM verdicts preserved — "who let this unauthenticated
  //    sender in" stays answerable.
  await createAuditEntry(db, {
    actor,
    action: "email_intake.promoted",
    objectType: "email_intake",
    objectId: id,
    newValueJson: stringifyJson({
      receiptId,
      from_address: intake.from_address,
      subject: intake.subject,
      spf_pass: intake.spf_pass,
      dkim_pass: intake.dkim_pass,
    }),
  });

  return receiptId;
}

/**
 * Reject a pending intake row with a required reason. Does NOT touch
 * receipt_records and does NOT delete the R2 object immediately (the 30-day
 * cleanup handles that; the row is kept for audit history at status 'rejected'
 * with a nulled key after cleanup). Idempotency guard on status.
 */
export async function rejectIntake(
  db: D1Database,
  id: string,
  reason: string,
  actor: string,
): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new Error("reject_reason is required and must be non-empty.");
  }

  const intake = await getIntake(db, id);
  if (!intake) throw new Error(`Intake ${id} not found.`);
  if (intake.status !== "pending_triage") {
    throw new Error(
      `Intake ${id} is already ${intake.status} (only pending_triage may be rejected).`,
    );
  }

  await db
    .prepare(
      `UPDATE email_receipt_intake
         SET status = 'rejected', reject_reason = ?
       WHERE id = ? AND status = 'pending_triage'`,
    )
    .bind(trimmed, id)
    .run();

  await createAuditEntry(db, {
    actor,
    action: "email_intake.rejected",
    objectType: "email_intake",
    objectId: id,
    newValueJson: stringifyJson({
      reason: trimmed,
      from_address: intake.from_address,
      subject: intake.subject,
      spf_pass: intake.spf_pass,
      dkim_pass: intake.dkim_pass,
    }),
  });
}
