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
    (r) => r.status !== "archived" && r.status !== "exported",
  );

  const matches: ReconciliationMatch[] = [];

  for (const line of amexLines) {
    if (line.match_status === "confirmed" || line.match_status === "no_receipt") {
      continue;
    }

    let bestMatch: ReconciliationMatch | null = null;

    for (const receipt of eligibleReceipts) {
      if (receipt.payment_path !== "AMEX") continue;

      const reasons: string[] = [];
      let score = 0;

      // Exact amount match (receipt and AMEX store amounts differently)
      // AMEX amount_minor is in cents (amount * 100), receipt amount_minor is in native units
      // For JPY both are the same integer; for USD/EUR both are * 100
      const amexMinor = line.amount_minor;
      const receiptMinor = receipt.amount_minor;

      if (receiptMinor !== null && amexMinor === receiptMinor) {
        score += 0.5;
        reasons.push("exact amount");
      } else if (
        receiptMinor !== null &&
        Math.abs(amexMinor - receiptMinor) < amexMinor * 0.01
      ) {
        score += 0.2;
        reasons.push("approximate amount");
      } else {
        continue; // Amount mismatch too large — not a candidate
      }

      // Date proximity
      if (receipt.transaction_date && line.transaction_date) {
        const days = daysBetween(line.transaction_date, receipt.transaction_date);
        if (days === 0) {
          score += 0.35;
          reasons.push("same date");
        } else if (days <= 3) {
          score += 0.2;
          reasons.push(`${days}-day window`);
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

      if (score > 0 && (!bestMatch || score > bestMatch.confidenceScore)) {
        bestMatch = {
          amexLineId: line.id,
          receiptId: receipt.id,
          confidenceScore: Math.min(score, 1),
          matchReasons: reasons,
        };
      }
    }

    if (bestMatch) {
      matches.push(bestMatch);
    }
  }

  return matches;
}
