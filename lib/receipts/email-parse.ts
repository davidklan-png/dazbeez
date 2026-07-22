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

// ─── RFC From header mailbox extraction (pre-raw block check) ────────────────

/**
 * Extract the first valid mailbox address from an RFC 5322 `From` header value
 * WITHOUT reading/parsing the raw MIME body. Handles:
 *   - "Name <email@example.com>" → email@example.com
 *   - "email@example.com" → email@example.com
 *   - malformed/missing → null
 * Returns the LOWERCASED mailbox (matching the normalization used by the policy
 * tables). Pure — safe to call in the Worker's email() handler before message.raw.
 */
export function extractMailboxFromHeader(fromHeader: string | null | undefined): string | null {
  if (!fromHeader || typeof fromHeader !== "string") return null;
  // Try angle-bracket form first: "Name <email@domain>"
  const angleMatch = fromHeader.match(/<([^<>]+)>/);
  const candidate = (angleMatch ? angleMatch[1] : fromHeader).trim().toLowerCase();
  // Validate it looks like an email (same shape as policy tables).
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) return candidate;
  return null;
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

// ─── Body capture: cap + link extraction (ADR 0011 Phase A) ──────────────────

/**
 * Cap a parsed body part to a UTF-8 byte ceiling. Returns the (possibly
 * truncated) string and whether it was cut; null passes through unchanged.
 *
 * Byte-accurate: encode to UTF-8, slice to maxBytes, decode with a non-fatal
 * decoder so a multibyte sequence split at the boundary becomes a replacement
 * char rather than throwing. Called from the Worker BEFORE recordIntake so the
 * stored body is already bounded and recordIntake stays a thin writer.
 *
 * TextEncoder/TextDecoder are platform globals (Node + Workers), so this stays
 * dependency-free per this file's header contract (no `@/`, no bindings).
 */
export function capBody(
  body: string | null,
  maxBytes: number,
): { value: string | null; truncated: boolean } {
  if (body === null) return { value: null, truncated: false };
  const encoded = new TextEncoder().encode(body);
  if (encoded.byteLength <= maxBytes) return { value: body, truncated: false };
  const sliced = encoded.subarray(0, maxBytes);
  const value = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
  return { value, truncated: true };
}

/**
 * Extract deduped http(s) URLs from the text and html bodies, preserving
 * first-seen order, capped at `maxLinks` (default 20 — a body stuffed with
 * tracking-pixel URLs shouldn't produce a wall of links). Used to surface
 * verification links (e.g. the Gmail forwarding confirmation) as a clickable
 * list in /receipts/inbox.
 *
 * Scans text and html TOGETHER: bare URLs in text, `href="…"` URLs in html,
 * and bare URLs in html text nodes are all caught by the same regex (it stops
 * at whitespace, angle brackets, and quotes). This is simpler and more complete
 * than tag-stripping, which would drop URLs living inside attributes (the
 * `<[^>]*>` match spans the entire opening tag, href URL included). Pure; no
 * network, no DOM.
 */
export function extractLinks(
  text: string | null,
  html: string | null,
  maxLinks = 20,
): string[] {
  const combined = `${text ?? ""}\n${html ?? ""}`;
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /https?:\/\/[^\s<>"']+/g;
  let m: RegExpExecArray | null;
  while (out.length < maxLinks && (m = re.exec(combined)) !== null) {
    const url = m[0].replace(/[.,;:!)?]+$/, ""); // trim trailing punctuation
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

// ─── Auto-promote gating (ADR 0011 Phase B) ─────────────────────────────────

/**
 * Parse a comma-separated TRUSTED_INTAKE_SENDERS value (Worker/consumer env or
 * secret) into a normalized lowercased list. Tolerant of whitespace/empties.
 * Pure so the gating decision is unit-testable without bindings.
 */
export function parseTrustedIntakeSenders(
  raw: string | null | undefined,
): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Whether a body-only intake should be auto-promoted into a real receipt with
 * NO operator click. The compensating control for receipts@ being a public,
 * unauthenticated address: only an allowlisted sender with passing SPF AND
 * DKIM gets auto-promoted; everyone else stays pending_triage (visible per
 * Phase A, manual Promote). Pure — the call site passes the verdicts and the
 * parsed allowlist.
 *
 * ADR 0011 follow-up (2026-07-22):
 * - Prospective trust: auto-promotion requires intake.received_at >= the
 *   sender's trust row created_at. Mail received BEFORE the sender was trusted
 *   stays pending (explicit human Promote still works).
 * - Blocked sender defense: blocked senders are never auto-promoted, even if
 *   they are somehow also in the trusted set.
 * - Malformed timestamps (either received_at or trusted_created_at) →
 *   ineligible (safe default).
 */
export function isAutoPromoteEligible(args: {
  fromAddress: string;
  spfPass: boolean;
  dkimPass: boolean;
  /** true if the email has at least one VALID receipt attachment. */
  hasValidAttachment: boolean;
  trustedSenders: readonly string[];
  /** Blocked sender set (normalized lowercase). */
  blockedSenders?: readonly string[];
  /** ISO timestamp of the intake's received_at. */
  receivedAt?: string;
  /** ISO timestamp of the matched trusted sender's created_at (prospective gate). */
  trustedCreatedAt?: string | null;
}): boolean {
  const normalized = args.fromAddress.trim().toLowerCase();

  // Blocked wins defensively (mutual-exclusion safety net).
  if (args.blockedSenders?.includes(normalized)) return false;

  // Attachments use the normal manual triage path regardless of sender.
  if (args.hasValidAttachment) return false;
  if (!args.spfPass || !args.dkimPass) return false;
  if (!args.trustedSenders.includes(normalized)) return false;

  // Prospective trust: received_at AND trusted_created_at are MANDATORY for
  // automatic promotion. Missing, null, malformed, or timezone-incompatible
  // timestamps are ineligible (safe default).
  if (!args.receivedAt || !args.trustedCreatedAt) return false;
  const receivedMs = parseIsoMs(args.receivedAt);
  const trustedMs = parseIsoMs(args.trustedCreatedAt);
  if (receivedMs === null || trustedMs === null) return false;
  if (receivedMs < trustedMs) return false; // older than trust → ineligible

  return true;
}

/**
 * Parse an ISO-8601 timestamp to epoch-ms, returning null if malformed.
 * Uses Date.parse (UTC-aware for ISO strings with 'Z'). Avoids locale
 * formatting issues.
 */
function parseIsoMs(iso: string): number | null {
  if (!iso || typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}
