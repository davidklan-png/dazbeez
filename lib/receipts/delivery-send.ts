// Pack delivery send orchestration (Phase B; D1/D3 + boundary checks B-1..B-5).
//
// This module is the boundary layer between a sealed export and Resend. Every
// value that crosses the boundary is checked HERE, as it is written — not
// deferred to review (the PR #160 lesson): the attachment size before base64,
// the attachment filename's charset, the idempotency key on the request. The
// email content (subject/body/recipients) is supplied by the caller from the
// sealed record (B-5 — never a live lookup); one-message-two-surfaces assembly
// lives in Change 4.

import { sendDeliveryViaResend } from "@/lib/receipts/notify";

/**
 * Raw (pre-base64) byte ceiling for a delivered pack ZIP.
 *
 * Resend's ~40 MB per-request payload limit is NOT the binding constraint
 * (base64 inflates ~33%, so 40 MB post-base64 ≈ 30 MB raw — above this). The
 * binding constraint is the recipient's mail gateway and safeAttach's inbound
 * size limit, both UNKNOWN and potentially far lower than Resend's. 20 MB raw
 * (≈26.7 MB post-base64) keeps headroom under Resend while staying conservative
 * against a tight recipient gateway. June is ~6 MB / 33 receipts, so the
 * headroom is real but finite. Phase C may surface this in Settings.
 *
 * Checked BEFORE base64 encoding (B-1) — fail loud with the real numbers
 * rather than truncate or silently fall back to a link.
 */
export const MAX_DELIVERY_ZIP_BYTES = 20 * 1024 * 1024;

/**
 * B-1: throw with the real numbers if the pack exceeds the ceiling. Throws
 * (does not return a result) so the send endpoint maps it to a 422 and the
 * delivery row records the failure — never a silent degradation.
 */
export function assertDeliverySize(zipBytes: number): void {
  if (zipBytes > MAX_DELIVERY_ZIP_BYTES) {
    throw new Error(
      `Pack ZIP is ${zipBytes.toLocaleString()} bytes, exceeds the ` +
        `${MAX_DELIVERY_ZIP_BYTES.toLocaleString()}-byte ` +
        `(${MAX_DELIVERY_ZIP_BYTES / (1024 * 1024)} MiB) delivery ceiling. ` +
        `Re-export the month under the limit; do not retry blindly.`,
    );
  }
}

/**
 * B-4: the attachment filename is the pack container name — ASCII by design
 * (`202606_Dazbeez_Monthly_Expense_Report.zip`). Non-ASCII would re-introduce
 * the Content-Disposition / ByteString hazard from PR #160 in a new place, and
 * risk the recipient's gateway mangling the attachment. Fail if it ever is not.
 */
export function assertDeliveryZipNameAscii(filename: string): void {
  if (!/^[\x20-\x7E]+$/.test(filename)) {
    throw new Error(
      `Delivery ZIP filename must be pure ASCII (pack container name); got: ${filename}`,
    );
  }
}

/**
 * Base64-encode raw bytes for Resend's `attachments[].content`. Chunked so a
 * ~6 MB pack does not overflow the call stack with a single fromCharCode.
 * `btoa` is available in the Workers runtime. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Send a sealed pack via Resend, checking every boundary constraint first.
 *
 * Order matters and is deliberate: the ASCII filename + raw size are checked
 * BEFORE the (memory-doubling) base64 encode — B-1 says fail before the inflate.
 * The idempotency key travels on the request header (B-3); the caller derives
 * it from the attempt_id.
 *
 * Returns the provider message id on success (recorded on the delivery row) or
 * an error string on failure. Never throws across the boundary — the caller
 * decides the delivery-row state transition from the result.
 */
export async function performDelivery(opts: {
  fetchImpl?: typeof fetch;
  apiKey: string;
  from: string;
  to: string;
  cc: string | null;
  subject: string;
  text: string;
  html: string;
  zipFilename: string;
  zipBytes: Uint8Array;
  idempotencyKey: string;
}): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  assertDeliveryZipNameAscii(opts.zipFilename);
  assertDeliverySize(opts.zipBytes.byteLength);
  const contentBase64 = bytesToBase64(opts.zipBytes);
  return sendDeliveryViaResend(
    opts.fetchImpl ?? fetch,
    opts.apiKey,
    opts.from,
    opts.to,
    opts.cc,
    opts.subject,
    opts.text,
    opts.html,
    { filename: opts.zipFilename, contentBase64 },
    opts.idempotencyKey,
  );
}
