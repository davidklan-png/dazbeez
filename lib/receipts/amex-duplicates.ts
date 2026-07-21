// Non-destructive AMEX possible-duplicate detection for the Reconcile screen.
//
// The existing CASH/DIGITAL duplicate warning (lib/receipts/blockers.ts
// computeDuplicateReceiptWarnings) is intentionally UNCHANGED — it gates on
// CASH/DIGITAL and drives the month-close warning card. This module is a
// SEPARATE AMEX helper that surfaces re-capture candidates among AMEX receipts
// as a non-blocking badge/link in Reconcile. It never auto-deletes,
// auto-matches, or suppresses a candidate — the operator decides.
//
// Why AMEX needs its own surface: every duplicate cluster found in the
// 2026-07-21 audit was AMEX, and the AMEX path had no duplicate detection at
// all, so re-captures showed up as plain "orphan" receipts instead of being
// flagged. See AGENTS.md backlog #8.
//
// Candidate strength:
//   • strong — canonical merchant + currency + amount + transaction date.
//              (canonicalizeMerchant folds OCR-garbled conbini-chain variants.)
//   • near   — same currency + amount, transaction date within ±1 day (default),
//              AND normalized merchant text DIFFERS (descriptor vs legal name,
//              OCR drift). Same-merchant ±1-day pairs are deliberately NOT
//              flagged: a legitimate round-trip (two tickets at one venue, one
//              day apart) shares merchant text and must not be mislabeled.
//
// Pure + client-safe. The caller (reconcile page) supplies the pool
// (orphans + matched/other in-window receipts) and the set of receipt ids
// already claimed by an AMEX line — the authoritative "is this matched" signal,
// never receipt.status (which can drift).

import { canonicalizeMerchant } from "@/lib/receipts/merchant";
import type { ReceiptRecord, ReceiptStatus } from "@/lib/receipts/types";

export type AmexDuplicateStrength = "strong" | "near";

export interface AmexDuplicateCandidate {
  otherReceiptId: string;
  strength: AmexDuplicateStrength;
  /** True when the partner is already claimed by an AMEX line — drives the
   *  "compare with matched receipt" badge wording. Authoritative source is the
   *  AMEX line relationship (matchedReceiptIds), not receipt.status. */
  otherMatched: boolean;
  otherStatus: ReceiptStatus;
  reasons: string[];
}

export interface FindAmexDuplicatesOptions {
  /** Maximum transaction-date delta (days) for a "near" candidate. Default 1. */
  nearDayWindow?: number;
}

const DAY_MS = 86_400_000;

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;
}

/** Normalize merchant text for the near-candidate "merchant differs" test. */
function normMerchant(m: string | null | undefined): string {
  return (m ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * For each orphan receipt, find possible re-capture candidates in the pool.
 *
 * @param orphanReceipts receipts currently shown as orphans (the subjects).
 * @param poolReceipts   receipts to compare against — orphans AND already
 *   matched/other in-window receipts. A matched receipt is a valid PARTNER
 *   (the "compare with matched receipt" case).
 * @param matchedReceiptIds receipt ids already claimed by an AMEX line
 *   (any month). Authoritative "is matched" signal; receipt.status is not used.
 * @returns map from orphan receipt id → its candidate list (only orphans that
 *   have ≥1 candidate appear as keys). Never mutates input.
 */
export function findAmexDuplicateCandidates(
  orphanReceipts: ReceiptRecord[],
  poolReceipts: ReceiptRecord[],
  matchedReceiptIds: Set<string>,
  opts: FindAmexDuplicatesOptions = {},
): Map<string, AmexDuplicateCandidate[]> {
  const nearWindow = opts.nearDayWindow ?? 1;
  const out = new Map<string, AmexDuplicateCandidate[]>();

  // Index dated, non-deleted pool receipts by currency|amount for O(n) lookup.
  type IndexEntry = {
    r: ReceiptRecord;
    canon: string;
    norm: string;
    date: string;
  };
  const byAmount = new Map<string, IndexEntry[]>();
  for (const r of poolReceipts) {
    if (r.deleted_at) continue;
    if (r.amount_minor == null || !r.currency || !r.transaction_date || !r.merchant) continue;
    const key = `${r.currency.toUpperCase()}|${r.amount_minor}`;
    const arr = byAmount.get(key) ?? [];
    arr.push({
      r,
      canon: canonicalizeMerchant(r.merchant),
      norm: normMerchant(r.merchant),
      date: r.transaction_date,
    });
    byAmount.set(key, arr);
  }

  for (const orphan of orphanReceipts) {
    if (orphan.deleted_at) continue;
    if (
      orphan.amount_minor == null ||
      !orphan.currency ||
      !orphan.transaction_date ||
      !orphan.merchant
    ) {
      continue;
    }
    const key = `${orphan.currency.toUpperCase()}|${orphan.amount_minor}`;
    const candidates = byAmount.get(key) ?? [];
    const oCanon = canonicalizeMerchant(orphan.merchant);
    const oNorm = normMerchant(orphan.merchant);
    const found: AmexDuplicateCandidate[] = [];

    for (const c of candidates) {
      if (c.r.id === orphan.id) continue;
      const sameCanon = c.canon === oCanon;
      const sameDate = c.date === orphan.transaction_date;
      const merchantDiffers = c.norm !== oNorm;
      const deltaDays = daysBetween(c.date, orphan.transaction_date!);

      if (sameCanon && sameDate) {
        found.push({
          otherReceiptId: c.r.id,
          strength: "strong",
          otherMatched: matchedReceiptIds.has(c.r.id),
          otherStatus: c.r.status,
          reasons: ["same merchant + amount + date"],
        });
      } else if (merchantDiffers && deltaDays <= nearWindow) {
        // Near: differing merchant text within the date window. Same-merchant
        // ±1-day pairs (round-trips) are excluded — merchantDiffers is false.
        found.push({
          otherReceiptId: c.r.id,
          strength: "near",
          otherMatched: matchedReceiptIds.has(c.r.id),
          otherStatus: c.r.status,
          reasons: [`same amount, ${deltaDays}d apart, merchant text differs`],
        });
      }
    }

    if (found.length > 0) out.set(orphan.id, found);
  }

  return out;
}
