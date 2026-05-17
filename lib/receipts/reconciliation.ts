import type {
  AmexStatementLine,
  ReconciliationMatch,
  ReceiptRecord,
} from "@/lib/receipts/types";

export function normalizeDescription(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  return Math.abs((a - b) / (1000 * 60 * 60 * 24));
}

function descriptionContains(amexDesc: string, receiptMerchant: string): boolean {
  const normalizedDesc = normalizeDescription(amexDesc);
  const normalizedMerchant = normalizeDescription(receiptMerchant);

  if (!normalizedMerchant) return false;

  // Check if all words in the merchant name appear in the AMEX description
  const merchantWords = normalizedMerchant.split(" ").filter((w) => w.length > 2);
  if (merchantWords.length === 0) return false;

  return merchantWords.some((word) => normalizedDesc.includes(word));
}

export function matchAmexToReceipts(
  amexLines: AmexStatementLine[],
  receipts: ReceiptRecord[],
): ReconciliationMatch[] {
  const eligibleReceipts = receipts.filter(
    (r) =>
      r.deleted_at === null &&
      r.status !== "archived" &&
      r.status !== "exported",
  );

  // Phase 1: compute best candidate per AMEX line
  const candidates: Array<{ match: ReconciliationMatch; dateDelta: number }> = [];

  for (const line of amexLines) {
    if (line.match_status === "confirmed" || line.match_status === "no_receipt") {
      continue;
    }

    let best: { match: ReconciliationMatch; dateDelta: number } | null = null;

    for (const receipt of eligibleReceipts) {
      if (receipt.payment_path !== "AMEX") continue;

      // Amount comparison only makes sense when both sides are denominated in
      // the same currency. amount_minor for JPY is yen units and for USD/EUR
      // is cents — comparing across currencies silently matches e.g. ¥500
      // (line.amount_minor 500) to $5.00 (receipt.amount_minor 500).
      if (
        line.currency.toUpperCase() !== receipt.currency.toUpperCase()
      ) {
        continue;
      }

      const reasons: string[] = [];
      let score = 0;
      let dateDelta = Infinity;

      const amexMinor = line.amount_minor;
      const receiptMinor = receipt.amount_minor;

      if (receiptMinor !== null && amexMinor === receiptMinor) {
        score += 0.5;
        reasons.push("exact amount");
      } else if (
        receiptMinor !== null &&
        // Use abs() on the reference value so the threshold works for refunds
        // (negative amount_minor) — otherwise `< negative` is always true and
        // any receipt would pass.
        Math.abs(amexMinor - receiptMinor) < Math.abs(amexMinor) * 0.01
      ) {
        score += 0.2;
        reasons.push("approximate amount");
      } else {
        continue; // Amount mismatch too large — not a candidate
      }

      // Date proximity
      if (receipt.transaction_date && line.transaction_date) {
        dateDelta = daysBetween(line.transaction_date, receipt.transaction_date);
        if (dateDelta === 0) {
          score += 0.35;
          reasons.push("same date");
        } else if (dateDelta <= 3) {
          score += 0.2;
          reasons.push(`${dateDelta}-day window`);
        } else {
          continue; // Too far apart — skip
        }
      }

      // Merchant name match
      if (receipt.merchant && line.merchant) {
        if (descriptionContains(line.merchant, receipt.merchant)) {
          score += 0.15;
          reasons.push("merchant match");
        }
      }

      if (score > 0 && (!best || score > best.match.confidenceScore)) {
        best = {
          match: {
            amexLineId: line.id,
            receiptId: receipt.id,
            confidenceScore: Math.min(score, 1),
            matchReasons: reasons,
          },
          dateDelta,
        };
      }
    }

    if (best) {
      candidates.push(best);
    }
  }

  // Phase 2: collision resolution — each receipt maps to at most one line and
  // each line to at most one receipt. Greedy by descending confidence; ties
  // broken by smaller date delta, then lexicographic line id.
  candidates.sort((a, b) => {
    const scoreDiff = b.match.confidenceScore - a.match.confidenceScore;
    if (scoreDiff !== 0) return scoreDiff;
    const deltaDiff = a.dateDelta - b.dateDelta;
    if (deltaDiff !== 0) return deltaDiff;
    return a.match.amexLineId.localeCompare(b.match.amexLineId);
  });

  const assignedReceipts = new Set<string>();
  const assignedLines = new Set<string>();
  const resolved: ReconciliationMatch[] = [];

  for (const { match } of candidates) {
    if (assignedReceipts.has(match.receiptId) || assignedLines.has(match.amexLineId)) {
      continue;
    }
    assignedReceipts.add(match.receiptId);
    assignedLines.add(match.amexLineId);
    resolved.push(match);
  }

  return resolved;
}
