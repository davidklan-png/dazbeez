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
 * is on the blocklist. Checks both identities against blocked_intake_senders.
 * On lookup failure, returns { matched: false } (falls back to normal triage
 * rather than falsely blocking).
 */
export async function resolveBlockedSenderIdentity(
  db: D1Database,
  headerFrom: string | null,
  envelopeFrom: string | null,
): Promise<BlockedIdentityResult> {
  const identities: Array<{ email: string; fromHeader: boolean }> = [];
  if (headerFrom) identities.push({ email: headerFrom, fromHeader: true });
  if (envelopeFrom) identities.push({ email: envelopeFrom, fromHeader: false });

  for (const { email, fromHeader } of identities) {
    try {
      const row = await db
        .prepare(`SELECT 1 FROM blocked_intake_senders WHERE email = ? LIMIT 1`)
        .bind(email)
        .first();
      if (row) return { matched: true, identity: email, fromHeader };
    } catch {
      // Lookup failure for this identity — log will happen at call site.
      // Continue to the next identity rather than falsely claiming a match.
    }
  }
  return { matched: false, identity: null, fromHeader: false };
}
