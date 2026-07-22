// Worker-side RFC From header parser using postal-mime's exported
// addressParser (robust RFC 5322 parsing). Used for the pre-raw block check
// so the blocklist is matched against the SAME identity the operator sees in
// the inbox, not just the SMTP envelope MAIL FROM.

import { addressParser } from "postal-mime";

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
