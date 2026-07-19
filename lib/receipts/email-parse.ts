// Pure helpers for the receipts-email-intake Worker (ADR 0011 §2/§3).
//
// Deliberately dependency-free: no `@/` aliases, no Worker bindings, no
// postal-mime import. That keeps this file trivially portable into the
// standalone worker's bundle AND unit-testable from the main repo's test
// suite (tests/receipts/email-parse.test.ts). The Worker's src/index.ts owns
// the binding/IO glue (readRaw, PostalMime.parse, R2/D1) and calls these.
//
// SPF/DKIM reality (ADR 0011 §0.3): whether Cloudflare Email Routing reliably
// stamps an Authentication-Results header on the ForwardableEmailMessage is
// NOT verified against live mail in this pass (no Email Routing wiring exists
// yet — operator step). extractAuthVerdicts parses that header DEFENSIVELY:
// if present it reports the verdict, otherwise it returns {false,false}. Do
// not treat a false here as "failed auth" — it may simply mean "header not
// provided by the transport."

// ─── Message size ceiling ───────────────────────────────────────────────────

/** True when the raw MIME message is within the pre-parse byte ceiling. */
export function withinMessageSizeCeiling(rawSize: number, ceiling: number): boolean {
  return Number.isFinite(rawSize) && rawSize >= 0 && rawSize <= ceiling;
}

// ─── Attachment mapping (postal-mime → ParsedEmailAttachment) ───────────────

export interface PostalAttachmentInput {
  filename: string | null;
  mimeType: string;
  content: ArrayBuffer | Uint8Array;
}

export interface MappedAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  data: ArrayBuffer;
}

/**
 * Map postal-mime's parsed attachments into the shape recordIntake expects.
 * `content` (ArrayBuffer under attachmentEncoding:"arraybuffer") is normalized
 * to a standalone ArrayBuffer (a Uint8Array view over a larger buffer would
 * otherwise leak bytes outside the attachment's range).
 */
export function mapPostalAttachments(
  atts: readonly PostalAttachmentInput[],
): MappedAttachment[] {
  return atts.map((a) => {
    const data = toArrayBuffer(a.content);
    return {
      filename: (a.filename ?? "attachment").trim() || "attachment",
      contentType: a.mimeType && a.mimeType.length > 0 ? a.mimeType : "application/octet-stream",
      sizeBytes: data.byteLength,
      data,
    };
  });
}

function toArrayBuffer(content: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (content instanceof ArrayBuffer) return content;
  // Uint8Array: copy just this view's range into a fresh ArrayBuffer so a
  // subarray/view over a larger backing buffer doesn't carry extra bytes.
  const copy = new Uint8Array(content.byteLength);
  copy.set(content);
  return copy.buffer;
}

// ─── SPF / DKIM verdicts from Authentication-Results ────────────────────────

export interface AuthVerdicts {
  spf: boolean;
  dkim: boolean;
}

/**
 * Parse an Authentication-Results header (RFC 8601) for spf/dkim `pass`.
 * Conservative: ONLY `pass` → true; fail/softfail/temperror/permerror/none/
 * missing → false. Returns {false,false} when the header is absent (per §0.3
 * this is the expected case until live-mail verification confirms CF stamps it).
 *
 * Example header value:
 *   "mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com"
 */
export function extractAuthVerdicts(authResults: string | null | undefined): AuthVerdicts {
  if (!authResults) return { spf: false, dkim: false };
  // Lowercase, semicolon/comma/whitespace-tolerant. Match "spf=pass" / "dkim=pass"
  // as whole token boundaries so e.g. "spf=passfail" doesn't false-positive.
  const lower = ` ${authResults.toLowerCase()} `;
  return {
    spf: /[^a-z]spf=pass[^a-z]/.test(lower),
    dkim: /[^a-z]dkim=pass[^a-z]/.test(lower),
  };
}

// ─── Raw header subset (audit-friendly, bounded) ────────────────────────────

/**
 * Pick a bounded, audit-useful header subset rather than dumping the entire
 * (potentially large) header set into raw_headers_json. `getHeader` is the
 * Worker's case-insensitive `message.headers.get(name)`; values are returned
 * verbatim (trimmed of trailing whitespace).
 */
export function pickRawHeadersSubset(
  getHeader: (name: string) => string | null,
): Record<string, string> {
  const names = [
    "from",
    "to",
    "cc",
    "subject",
    "date",
    "message-id",
    "reply-to",
    "return-path",
    "sender",
    "authentication-results",
    "received-spf",
    "dkim-signature",
  ];
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = getHeader(name);
    if (v !== null && v.trim().length > 0) out[name] = v.trim();
  }
  return out;
}

// ─── Scheduled cleanup ──────────────────────────────────────────────────────

/**
 * ISO timestamp of the stale cutoff: rows with received_at older than this are
 * eligible for R2 cleanup. Pure given `nowMs` (Worker passes Date.now()) so the
 * boundary is unit-testable without a clock.
 */
export function staleCutoffIso(nowMs: number, days: number): string {
  return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
}
