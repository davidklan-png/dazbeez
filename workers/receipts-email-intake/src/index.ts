// dazbeez-receipts-email-intake — standalone Cloudflare Worker for inbound
// receipt email at receipts@dazbeez.com (ADR 0011 §2 + §6).
//
// Why a separate worker (not the main dazbeez OpenNext worker): OpenNext's
// generated worker exports only `fetch`, and @opennextjs/cloudflare's override
// surface has no `email`/`scheduled` hook. This worker mirrors the existing
// workers/email-reply-capture pattern (own wrangler/package/tsconfig, postal-mime,
// readRaw + ctx.waitUntil) but, unlike reply-capture, it KEEPS the message
// (intake, not a forward passthrough) and also runs the daily cleanup cron.
//
// All intake/cleanup LOGIC lives in lib/receipts/{email-intake,email-parse}.ts;
// this file is the thin binding/IO glue.

import PostalMime from "postal-mime";
import {
  recordIntake,
  recordBlockedIntake,
  INTAKE_MAX_MESSAGE_BYTES,
  INTAKE_STALE_DAYS,
  INTAKE_BODY_TEXT_MAX_BYTES,
  INTAKE_BODY_HTML_MAX_BYTES,
} from "../../../lib/receipts/email-intake";
import {
  withinMessageSizeCeiling,
  mapPostalAttachments,
  extractAuthVerdicts,
  pickRawHeadersSubset,
  staleCutoffIso,
  capBody,
} from "../../../lib/receipts/email-parse";
import { isBlockedSender } from "../../../lib/receipts/blocked-senders";

interface Env {
  RECEIPTS_DB: D1Database;
  RECEIPTS_BUCKET: R2Bucket;
}

const CLEANUP_BATCH_LIMIT = 200;

const worker = {
  // ─── Inbound mail → email_receipt_intake ──────────────────────────────────
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Hard pre-parse size ceiling (ADR 0011 "Negative"). Check the declared
    // rawSize BEFORE reading/parsing anything. If it exceeds the ceiling, drop
    // (do not process) and log. We deliberately do NOT call message.setReject:
    // its bounce semantics aren't specified in the ADR and guessing wrong could
    // bounce legitimate mail to a real sender.
    if (!withinMessageSizeCeiling(message.rawSize, INTAKE_MAX_MESSAGE_BYTES)) {
      console.warn("[receipts-email-intake] message exceeds size ceiling, dropping", {
        from: message.from,
        to: message.to,
        rawSize: message.rawSize,
        ceiling: INTAKE_MAX_MESSAGE_BYTES,
      });
      return;
    }

    // ADR 0011 follow-up (2026-07-22): check the blocklist BEFORE reading or
    // parsing message.raw. If the envelope sender is blocked, record one
    // minimal rejected row (metadata only — no body/headers/attachment/R2)
    // and return without processing. If the lookup fails, log visibly and
    // continue into ordinary pending triage (the promote route's policy gate
    // is the final safety net).
    const envelopeFrom = (message.from ?? "").trim().toLowerCase();
    if (envelopeFrom) {
      let blocked = false;
      try {
        blocked = await isBlockedSender(env.RECEIPTS_DB, envelopeFrom);
      } catch (err) {
        console.error("[receipts-email-intake] blocked-sender lookup failed; continuing to normal triage", {
          from: envelopeFrom,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (blocked) {
        try {
          const { spf, dkim } = extractAuthVerdicts(message.headers.get("authentication-results"));
          const subject = message.headers.get("subject");
          await recordBlockedIntake(env.RECEIPTS_DB, {
            receivedAt: new Date().toISOString(),
            fromAddress: envelopeFrom,
            toAddress: message.to ?? null,
            subject,
            spfPass: spf,
            dkimPass: dkim,
          });
          console.log("[receipts-email-intake] blocked delivery recorded (metadata only)", {
            from: envelopeFrom,
          });
        } catch (err) {
          console.error("[receipts-email-intake] blocked delivery recording failed; mail NOT processed", {
            from: envelopeFrom,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return; // never read/parse the raw MIME for a blocked sender
      }
    }

    let rawBytes: Uint8Array | null = null;
    try {
      rawBytes = await readRaw(message.raw, message.rawSize);
    } catch (err) {
      console.error("[receipts-email-intake] failed to read raw message", {
        from: message.from,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!rawBytes) return;

    // Defense against a rawSize that understated the real stream length.
    if (!withinMessageSizeCeiling(rawBytes.byteLength, INTAKE_MAX_MESSAGE_BYTES)) {
      console.warn("[receipts-email-intake] read bytes exceed ceiling, dropping", {
        from: message.from,
        bytes: rawBytes.byteLength,
      });
      return;
    }

    // Process out-of-band so email() resolves promptly. IMPORTANT control-flow
    // fact for the error posture below: the intake work is BACKGROUNDED —
    // email() has already returned by the time processMessage runs, so a thrown
    // error there is an INVISIBLE BACKGROUND REJECTION, not a bounce to the
    // sender. (A real bounce would require awaiting processMessage synchronously
    // before returning — a bigger restructure, deliberately not taken: a bounce
    // on a transient D1/R2 hiccup would reject a legitimate sender for something
    // they can't fix, and bounce behavior leaks a little info to an unauthenticated
    // endpoint.)
    //
    // So processMessage fails safe (log + swallow): a failed intake is visible
    // ONLY in Worker logs — no row lands in /receipts/inbox. Logged-only failure
    // is the accepted v1 gap, same posture as the "no monitoring in v1" call in
    // ADR 0011. If intake reliability later matters more than sender UX, revisit
    // by awaiting synchronously AND adding a dead-letter signal (not by throwing
    // inside this backgrounded task, which buys nothing).
    ctx.waitUntil(processMessage(env, message, rawBytes));
  },

  // ─── Daily cleanup cron (03:00 UTC) ───────────────────────────────────────
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(cleanupStaleIntake(env));
  },
};

export default worker;

// ─── email() helpers ────────────────────────────────────────────────────────

async function processMessage(
  env: Env,
  message: ForwardableEmailMessage,
  rawBytes: Uint8Array,
): Promise<void> {
  try {
    // arraybuffer encoding → attachment.content is an ArrayBuffer (no base64).
    const parsed = await PostalMime.parse(rawBytes, {
      attachmentEncoding: "arraybuffer",
    });

    const fromAddress = parsed.from?.address ?? message.from ?? "";
    const subject = parsed.subject ?? null;
    const receivedAt = parsed.date
      ? new Date(parsed.date).toISOString()
      : new Date().toISOString();

    const getHeader = (name: string): string | null =>
      message.headers.get(name) ?? null;

    // SPF/DKIM (ADR 0011 §0.3): parsed DEFENSIVELY from Authentication-Results.
    // If Cloudflare's transport doesn't stamp it, this yields {false,false} —
    // not a "fail", just "unavailable". The verdicts are surfaced in the inbox
    // and audit log; they never gate intake.
    const { spf, dkim } = extractAuthVerdicts(getHeader("authentication-results"));
    const rawHeadersJson = JSON.stringify(pickRawHeadersSubset(getHeader));

    const attachments = mapPostalAttachments(
      (parsed.attachments ?? []).map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        content: a.content as ArrayBuffer | Uint8Array,
      })),
    );

    // ADR 0011 Phase A: capture the parsed text/html body, byte-capped. The
    // flag is set if EITHER part was cut, so /receipts/inbox can surface
    // "body truncated at capture" rather than look silently incomplete.
    const textCap = capBody(parsed.text ?? null, INTAKE_BODY_TEXT_MAX_BYTES);
    const htmlCap = capBody(parsed.html ?? null, INTAKE_BODY_HTML_MAX_BYTES);
    const bodyTruncated = textCap.truncated || htmlCap.truncated;

    const ids = await recordIntake(env.RECEIPTS_DB, env.RECEIPTS_BUCKET, {
      receivedAt,
      fromAddress,
      toAddress: message.to ?? null,
      subject,
      spfPass: spf,
      dkimPass: dkim,
      rawHeadersJson,
      bodyText: textCap.value,
      bodyHtml: htmlCap.value,
      bodyTruncated,
      attachments,
    });

    console.log("[receipts-email-intake] recorded", {
      from: fromAddress,
      subject,
      attachments: attachments.length,
      rows: ids.length,
    });
  } catch (err) {
    console.error("[receipts-email-intake] intake failed", {
      from: message.from,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Read a ReadableStream<Uint8Array> into a single Uint8Array. Same pattern as
// workers/email-reply-capture (kept consistent so behavior is identical).
async function readRaw(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(expectedSize || total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return offset === out.byteLength ? out : out.subarray(0, offset);
}

// ─── scheduled() cleanup ────────────────────────────────────────────────────
//
// ADR 0011 §6: delete the R2 object (the disposable part) for intake rows that
// are rejected OR stale pending_triage (> INTAKE_STALE_DAYS old). The ROW is
// kept for audit history with attachment_r2_key nulled. We do NOT auto-flip
// stale pending_triage → rejected: the ADR only deletes the object, and a stale
// row with a null key is already functionally unpromotable (assertPromotable
// refuses it), so a status change would be redundant. Batched to keep the query
// bounded (cron runs daily; a backlog drains over a few days).

async function cleanupStaleIntake(env: Env): Promise<void> {
  const db = env.RECEIPTS_DB;
  const bucket = env.RECEIPTS_BUCKET;
  const cutoff = staleCutoffIso(Date.now(), INTAKE_STALE_DAYS);

  const result = await db
    .prepare(
      `SELECT id, attachment_r2_key
         FROM email_receipt_intake
        WHERE attachment_r2_key IS NOT NULL
          AND (
            status = 'rejected'
            OR (status = 'pending_triage' AND received_at < ?)
          )
        ORDER BY received_at ASC
        LIMIT ?`,
    )
    .bind(cutoff, CLEANUP_BATCH_LIMIT)
    .all<{ id: string; attachment_r2_key: string }>();

  const rows = result.results ?? [];
  let deleted = 0;
  for (const row of rows) {
    // Best-effort R2 delete: a failure here must not block nulling the key
    // (otherwise the cron retries the same object forever). Log and continue.
    try {
      await bucket.delete(row.attachment_r2_key);
      deleted += 1;
    } catch (err) {
      console.error("[receipts-email-intake] R2 delete failed", {
        key: row.attachment_r2_key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await db
        .prepare(
          `UPDATE email_receipt_intake SET attachment_r2_key = NULL WHERE id = ?`,
        )
        .bind(row.id)
        .run();
    } catch (err) {
      console.error("[receipts-email-intake] intake row update failed", {
        id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log("[receipts-email-intake] cleanup done", {
    cutoff,
    candidates: rows.length,
    r2Deleted: deleted,
  });
}
