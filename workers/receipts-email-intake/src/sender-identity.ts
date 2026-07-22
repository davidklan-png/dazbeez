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
 * Implementation:
 *   - Normalizes and deduplicates the non-null identities (header takes
 *     priority).
 *   - Issues a SINGLE D1 query for all identities.
 *   - Let a D1 failure PROPAGATE — the caller must catch it, log visibly,
 *     and continue to normal triage. This resolver never silently swallows
 *     a lookup error.
 */
export async function resolveBlockedSenderIdentity(
  db: D1Database,
  headerFrom: string | null,
  envelopeFrom: string | null,
): Promise<BlockedIdentityResult> {
  // Build a deduplicated, priority-ordered list: RFC From first, then envelope.
  const ordered: Array<{ email: string; fromHeader: boolean }> = [];
  const seen = new Set<string>();
  if (headerFrom) {
    ordered.push({ email: headerFrom, fromHeader: true });
    seen.add(headerFrom);
  }
  if (envelopeFrom && !seen.has(envelopeFrom)) {
    ordered.push({ email: envelopeFrom, fromHeader: false });
    seen.add(envelopeFrom);
  }

  if (ordered.length === 0) {
    return { matched: false, identity: null, fromHeader: false };
  }

  // Single query for all identities. If this throws, the error propagates
  // to the caller — never silently swallowed.
  if (ordered.length === 1) {
    const row = await db
      .prepare(`SELECT 1 FROM blocked_intake_senders WHERE email = ? LIMIT 1`)
      .bind(ordered[0]!.email)
      .first();
    if (row) {
      return { matched: true, identity: ordered[0]!.email, fromHeader: ordered[0]!.fromHeader };
    }
    return { matched: false, identity: null, fromHeader: false };
  }

  // Two distinct identities: one query with IN (...).
  const placeholders = ordered.map(() => "?").join(",");
  const row = await db
    .prepare(
      `SELECT email FROM blocked_intake_senders WHERE email IN (${placeholders}) ORDER BY CASE email`,
    )
    .bind(...ordered.map((o) => o.email))
    .first<{ email: string }>();

  if (!row) {
    return { matched: false, identity: null, fromHeader: false };
  }

  // Preserve header priority: if the header identity is the one that matched,
  // return it with fromHeader=true.
  const matchedEntry = ordered.find((o) => o.email === row.email);
  return {
    matched: true,
    identity: row.email,
    fromHeader: matchedEntry?.fromHeader ?? false,
  };
}
