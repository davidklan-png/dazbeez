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
import { createAuditEntry } from "@/lib/receipts/audit";
import { captureReceipt } from "@/lib/receipts/capture";
import { nowIso, newUuid, stringifyJson } from "@/lib/receipts/db-utils";
import { sanitizeFilenameForR2, computeSha256Hex } from "@/lib/receipts/storage";
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

// Bounded subject limit for blocked-delivery metadata rows. Keeps D1 rows
// small; the full subject is attacker-controlled and unnecessary for the
// operator's "who tried to send" visibility.
export const BLOCKED_SUBJECT_MAX_CHARS = 200;

/**
 * Record a single minimal REJECTED intake row for a blocked sender. Stores
 * ONLY: sender, recipient, received time, SPF/DKIM, and a bounded subject.
 * Stores NO raw headers, body, attachment metadata/content, or R2 object.
 *
 * This is the blocked-delivery path (ADR 0011 follow-up 2026-07-22). Called
 * by the Email Worker BEFORE reading/parsing message.raw — the caller passes
 * only metadata already available from the ForwardableEmailMessage object.
 *
 * Returns the created row id.
 */
export async function recordBlockedIntake(
  db: D1Database,
  input: {
    receivedAt: string;
    fromAddress: string;
    toAddress: string | null;
    subject: string | null;
    spfPass: boolean;
    dkimPass: boolean;
    /** The exact normalized blocklist key that matched (RFC From or envelope). */
    blockedSenderEmail: string;
  },
): Promise<string> {
  // Normalize the policy identity — reject malformed/empty.
  const normalizedBlocked = input.blockedSenderEmail?.trim().toLowerCase();
  if (!normalizedBlocked || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedBlocked)) {
    throw new Error("recordBlockedIntake requires a valid normalized blockedSenderEmail.");
  }

  const id = newUuid();
  const now = nowIso();
  const auditId = newUuid();
  const boundedSubject = input.subject
    ? input.subject.slice(0, BLOCKED_SUBJECT_MAX_CHARS)
    : null;

  const auditJson = stringifyJson({
    reason: "blocked_sender",
    from_address: input.fromAddress,
    subject: boundedSubject,
    spf_pass: input.spfPass,
    dkim_pass: input.dkimPass,
    blocked_sender_email: normalizedBlocked,
  });

  // Atomic: row insert + audit insert in ONE D1 batch. If either fails, the
  // entire batch rolls back — no row without audit, no audit without row.
  await db.batch([
    db
      .prepare(
        `INSERT INTO email_receipt_intake
          (id, received_at, from_address, subject, spf_pass, dkim_pass,
           attachment_r2_key, attachment_sha256, attachment_content_type,
           attachment_size_bytes, attachment_filename, status, reject_reason,
           promoted_receipt_id, raw_headers_json, created_at, to_address,
           body_text, body_html, body_truncated, blocked_sender_email)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 'rejected', 'blocked_sender', NULL, NULL, ?, ?, NULL, NULL, 0, ?)`,
      )
      .bind(
        id,
        input.receivedAt,
        input.fromAddress,
        boundedSubject,
        input.spfPass ? 1 : 0,
        input.dkimPass ? 1 : 0,
        now,
        input.toAddress,
        normalizedBlocked,
      ),
    db
      .prepare(
        `INSERT INTO receipt_audit_log
          (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
         VALUES (?, 'email-worker', 'email_intake.rejected', 'email_intake', ?, NULL, ?, ?)`,
      )
      .bind(auditId, id, auditJson, now),
  ]);

  return id;
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
 * ADR 0011 Phase B: a body-only row (no attachment, but a captured text/html
 * body) is ALSO promotable — the body becomes the receipt's true original and
 * enters the render pipeline. Mirrored as the enabled Promote button in the
 * inbox UI; this is the server authority.
 */
export function assertPromotable(intake: EmailReceiptIntake): void {
  if (intake.status !== "pending_triage") {
    throw new Error(
      `Intake ${intake.id} is already ${intake.status} (only pending_triage may be promoted).`,
    );
  }
  const hasAttachment = !!intake.attachment_r2_key;
  const hasBody = !!(intake.body_text || intake.body_html);
  if (!hasAttachment && !hasBody) {
    throw new Error(
      `Intake ${intake.id} has nothing promotable (no valid attachment and no captured body).`,
    );
  }
}

/** True for a Phase B body-only intake (no attachment, but a text/html body). */
export function isBodyOnlyIntake(intake: EmailReceiptIntake): boolean {
  return !intake.attachment_r2_key && (!!intake.body_text || !!intake.body_html);
}

/**
 * Promote a BODY-ONLY intake row into a real receipt (ADR 0011 Phase B). The
 * shared core for both the manual Promote button and the auto-promote path.
 *
 * The raw body (prefer html else text) becomes the receipt's TRUE original:
 * written to R2, referenced by receipt_records.original_r2_key AND an
 * is_original receipt_files row whose content_type is text/* (never image/*),
 * so compliance's electronic_transaction_missing_original screenshot-proxy
 * check stays quiet (compliance.ts only fires it for image/* originals). The
 * Mac-rendered derivative is a SEPARATE is_original=false receipt_files row
 * deposited later by /render, and original_r2_key is never repointed at it.
 *
 * The receipt is created at sourceType 'email_body'; createReceiptRecord seeds
 * needs_render=1 from the source type, so it is NOT enqueued for MLX extraction
 * yet — it waits for the Mac render. No second insert path: this calls the same
 * createReceiptRecord every other capture path uses.
 */
async function promoteBodyIntake(
  intake: EmailReceiptIntake,
  actor: string,
): Promise<string> {
  const db = getReceiptsDb();
  const bucket = getReceiptsBucket();

  const useHtml = !!intake.body_html;
  const bodyStr = (useHtml ? intake.body_html : intake.body_text) ?? "";
  if (!bodyStr) {
    throw new Error(`Intake ${intake.id} has no body to promote.`);
  }
  const contentType = useHtml ? "text/html" : "text/plain";
  const filename = useHtml ? "email-body.html" : "email-body.txt";

  const encoded = new TextEncoder().encode(bodyStr);
  const bodyBytes = encoded.buffer.slice(0, encoded.byteLength) as ArrayBuffer;
  const sha256 = await computeSha256Hex(bodyBytes);

  // Staging key: captureReceipt (intake-copy) needs an object to read + move,
  // and createReceiptRecord's original_r2_key is NOT NULL. Write the body to a
  // staging key; captureReceipt copies it to the standard key.
  const stagingKey = `receipts-render-staging/${intake.id}/${newUuid()}-${sanitizeFilenameForR2(filename)}`;
  await bucket.put(stagingKey, bodyBytes, {
    httpMetadata: { contentType },
  });

  // captureReceipt (backlog #18 single door): create (staging key) → copy
  // staging→standard → patch original_r2_key → is_original manifest row. enqueue
  // is FALSE: sourceType 'email_body' seeds needs_render=1, so /render enqueues
  // later (the body is rendered to PDF/image on the Mac before MLX extraction).
  const { receiptId } = await captureReceipt({
    record: {
      capturedBy: intake.from_address,
      source: "email",
      sourceType: "email_body",
      status: "captured",
      originalR2Key: stagingKey,
      originalSha256: sha256,
      originalContentType: contentType,
      originalSizeBytes: bodyBytes.byteLength,
      originalFilename: filename,
    },
    file: { sha256, sizeBytes: bodyBytes.byteLength, contentType, filename },
    r2Strategy: { kind: "intake-copy", intakeKey: stagingKey },
    enqueue: false,
    actor,
  });

  // Flip the intake row (idempotent guard on status). attachment_r2_key is
  // already NULL for a body-only row.
  await db
    .prepare(
      `UPDATE email_receipt_intake
         SET status = 'promoted', promoted_receipt_id = ?
       WHERE id = ? AND status = 'pending_triage'`,
    )
    .bind(receiptId, intake.id)
    .run();

  // Delete the now-moved staging object (best-effort).
  try {
    await bucket.delete(stagingKey);
  } catch (err) {
    console.error("[promoteBodyIntake] failed to delete staging R2 object", {
      key: stagingKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await createAuditEntry(db, {
    actor,
    action: "email_intake.promoted",
    objectType: "email_intake",
    objectId: intake.id,
    newValueJson: stringifyJson({
      receiptId,
      from_address: intake.from_address,
      subject: intake.subject,
      spf_pass: intake.spf_pass,
      dkim_pass: intake.dkim_pass,
      sourceType: "email_body",
      via: actor.includes("auto") ? "auto" : "manual",
    }),
  });

  return receiptId;
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

  // ADR 0011 Phase B: body-only intakes take the render-pipeline path (raw
  // body → receipt original → Mac render → MLX extraction). Attachment intakes
  // use the existing copy-to-standard-key path below.
  if (isBodyOnlyIntake(intake)) {
    return promoteBodyIntake(intake, actor);
  }

  // captureReceipt (backlog #18 single door): create (intake key) → copy
  // intake→standard → patch original_r2_key → is_original manifest (standard) →
  // enqueue (standard). It reads + moves the intake object itself; a missing
  // object or a manifest-write failure throws (LOUD — compensating delete) and
  // the enqueue is best-effort, per the contract. Leaves the intake row
  // pending_triage on any failure (the flip below hasn't run) so it's
  // re-promotable.
  const originalIntakeKey = intake.attachment_r2_key as string;
  const { receiptId } = await captureReceipt({
    record: buildPromoteReceiptInput(intake),
    file: {
      sha256: intake.attachment_sha256 as string,
      sizeBytes: intake.attachment_size_bytes ?? 0,
      contentType: intake.attachment_content_type ?? "application/octet-stream",
      filename: intake.attachment_filename ?? "attachment",
    },
    r2Strategy: { kind: "intake-copy", intakeKey: originalIntakeKey },
    enqueue: true,
    actor,
  });

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
