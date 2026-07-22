// Worker-side RFC From header parser + block-identity resolver using
// postal-mime's exported addressParser (robust RFC 5322 parsing). Used for the
// pre-raw block check so the blocklist is matched against the SAME identity the
// operator sees in the inbox, not just the SMTP envelope MAIL FROM.

import { addressParser } from "postal-mime";
import type { D1Database } from "@cloudflare/workers-types";

/**
 * Parse the first valid RFC 5322 mailbox from a From header value WITHOUT
 * reading message.raw. Handles quoted display names, comments, encoded words,
 * commas in quoted strings, and multiple addresses (uses the first valid).
 * Returns the LOWERCASED mailbox, or null if the header is missing/malformed.
 */
export function parseRfcFromMailbox(
  fromHeader: string | null | undefined,
): string | null {
  if (!fromHeader || typeof fromHeader !== "string") return null;
  try {
    const addresses = addressParser(fromHeader);
    for (const addr of addresses) {
      if (
        addr?.address &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr.address)
      ) {
        return addr.address.toLowerCase();
      }
    }
    return null;
  } catch {
    return null;
  }
}

export interface BlockedIdentityResult {
  matched: boolean;
  identity: string | null;
  /** Whether the match came from the RFC From header (vs envelope). */
  fromHeader: boolean;
}

/**
 * Resolve whether EITHER the RFC From header mailbox OR the envelope MAIL FROM
 * is on the blocklist.
 *
 * Normalizes (trim + lowercase) and deduplicates both identities, then issues
 * a SINGLE D1 query. Priority is applied in TypeScript after the query:
 * RFC From wins when two distinct identities are both blocked.
 *
 * If the D1 query fails, the error PROPAGATES — the caller must catch it,
 * log visibly, and continue to normal triage. This resolver never silently
 * swallows a lookup error.
 */
export async function resolveBlockedSenderIdentity(
  db: D1Database,
  headerFrom: string | null,
  envelopeFrom: string | null,
): Promise<BlockedIdentityResult> {
  // Normalize each non-empty identity: trim + lowercase.
  const norm = (s: string | null): string | null => {
    if (!s) return null;
    const v = s.trim().toLowerCase();
    return v || null;
  };

  // Build deduplicated, priority-ordered list: RFC From first, then envelope.
  const ordered: Array<{ email: string; fromHeader: boolean }> = [];
  const seen = new Set<string>();

  const hdr = norm(headerFrom);
  const env = norm(envelopeFrom);

  if (hdr) {
    ordered.push({ email: hdr, fromHeader: true });
    seen.add(hdr);
  }
  if (env && !seen.has(env)) {
    ordered.push({ email: env, fromHeader: false });
    seen.add(env);
  }

  if (ordered.length === 0) {
    return { matched: false, identity: null, fromHeader: false };
  }

  // Single query for all identities using IN (?, ...). No ORDER BY —
  // priority is applied in TypeScript after the query returns.
  const placeholders = ordered.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT email FROM blocked_intake_senders WHERE email IN (${placeholders})`,
    )
    .bind(...ordered.map((o) => o.email))
    .all<{ email: string }>();

  const blockedSet = new Set((result.results ?? []).map((r) => r.email));

  // Select the first ordered identity present in the blocked set.
  // RFC From is first in `ordered`, so it wins when both are blocked.
  for (const { email, fromHeader } of ordered) {
    if (blockedSet.has(email)) {
      return { matched: true, identity: email, fromHeader };
    }
  }

  return { matched: false, identity: null, fromHeader: false };
}
