import type {
  AmexStatementLine,
  ReconciliationMatch,
  ReceiptRecord,
} from "@/lib/receipts/types";

export function normalizeDescription(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns true when the AMEX merchant should overwrite the receipt merchant.
 * Both must be non-null and their normalized forms must differ.
 */
export function shouldOverwriteMerchant(
  amexMerchant: string | null | undefined,
  receiptMerchant: string | null | undefined,
): boolean {
  if (!amexMerchant || !receiptMerchant) return false;
  return normalizeDescription(amexMerchant) !== normalizeDescription(receiptMerchant);
}

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  return Math.abs((a - b) / (1000 * 60 * 60 * 24));
}

// Known descriptor ↔ legal-name pairs. JP card statements often print a
// booking-service brand while the receipt carries the operator's registered
// company name, so token matching can never connect them. Each group lists
// patterns that all refer to the same merchant; a line and a receipt matching
// any two patterns in one group count as a merchant match. Extend this table
// as new descriptor mismatches surface in review.
const MERCHANT_ALIAS_GROUPS: RegExp[][] = [
  // えきねっと (JR East's booking site) charges appear as the brand; the
  // 領収書 is issued by 東日本旅客鉄道株式会社.
  [/えきねっと|エキネット|EKI-?NET/i, /東日本旅客鉄道|JR\s*東日本|JR\s*EAST/i],
];

// Consolidated-group suggestions never reach the "obvious" (auto-confirm)
// band — 0.92 in lib/receipts/confidence.ts. A wrong grouping is the
// costliest reconciliation mistake, so a human confirms each group line.
const CONSOLIDATED_CONFIDENCE_CAP = 0.9;

function merchantAliasMatch(a: string, b: string): boolean {
  return MERCHANT_ALIAS_GROUPS.some(
    (group) => group.some((re) => re.test(a)) && group.some((re) => re.test(b)),
  );
}

function descriptionContains(amexDesc: string, receiptMerchant: string): boolean {
  const normalizedDesc = normalizeDescription(amexDesc);
  const normalizedMerchant = normalizeDescription(receiptMerchant);

  if (!normalizedDesc || !normalizedMerchant) return false;

  const descTokens = normalizedDesc.split(" ").filter((w) => w.length > 2);
  const merchantTokens = normalizedMerchant.split(" ").filter((w) => w.length > 2);

  if (descTokens.length === 0 || merchantTokens.length === 0) return false;

  // Rule A: both sides have ≥2 significant tokens and share ≥2 of them.
  if (descTokens.length >= 2 && merchantTokens.length >= 2) {
    const merchantSet = new Set(merchantTokens);
    if (descTokens.filter((t) => merchantSet.has(t)).length >= 2) return true;
  }

  // Rule B: one side has a single token (len ≥4) that is an exact token on
  // the other side. Covers "AMAZON" ↔ "AMAZON MARKETPLACE" but rejects
  // "STAR" ↔ "STARBUCKS" (not an exact token match).
  if (merchantTokens.length === 1 && merchantTokens[0]!.length >= 4) {
    if (descTokens.includes(merchantTokens[0]!)) return true;
  }
  if (descTokens.length === 1 && descTokens[0]!.length >= 4) {
    if (merchantTokens.includes(descTokens[0]!)) return true;
  }

  // Rule C: both sides have exactly 1 token; the shorter (len ≥5) is a
  // substring of the longer. Covers "セブンイレブン" ↔ "セブンイレブン渋谷"
  // but rejects "STAR" ↔ "STARBUCKS" (shorter len=4 < 5).
  if (descTokens.length === 1 && merchantTokens.length === 1) {
    const [a] = descTokens;
    const [m] = merchantTokens;
    const shorter = a!.length <= m!.length ? a! : m!;
    const longer = a!.length <= m!.length ? m! : a!;
    if (shorter.length >= 5 && longer.includes(shorter)) return true;
  }

  return false;
}

export function matchAmexToReceipts(
  amexLines: AmexStatementLine[],
  receipts: ReceiptRecord[],
): ReconciliationMatch[] {
  const eligibleReceipts = receipts.filter(
    (r) =>
      r.deleted_at === null &&
      r.status !== "archived" &&
      r.status !== "exported" &&
      r.status !== "reconciled",
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

      // Date proximity — linear gradient: max(0, 0.35 - 0.05 × days) for days ≤ 7
      let dateCap = 1;
      if (receipt.transaction_date && line.transaction_date) {
        dateDelta = daysBetween(line.transaction_date, receipt.transaction_date);
        if (dateDelta > 7) {
          continue; // Too far apart — skip
        }
        score += Math.max(0, 0.35 - 0.05 * dateDelta);
        reasons.push(`${dateDelta}-day window`);
      } else {
        score -= 0.2;
        reasons.push("no date on receipt");
        dateCap = 0.5;
      }

      // Merchant name match
      if (receipt.merchant && line.merchant) {
        if (descriptionContains(line.merchant, receipt.merchant)) {
          score += 0.15;
          reasons.push("merchant match");
        } else if (merchantAliasMatch(line.merchant, receipt.merchant)) {
          score += 0.15;
          reasons.push("known merchant alias");
        }
      }

      if (score > 0 && (!best || score > best.match.confidenceScore)) {
        best = {
          match: {
            amexLineId: line.id,
            receiptId: receipt.id,
            confidenceScore: Math.min(score, dateCap),
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

  // Phase 3: consolidated receipts (領収書 covering several card charges).
  // Runs only over lines and receipts left unmatched by the 1:1 phases.
  // Policy (deliberately narrow): ALL same-merchant unmatched lines within the
  // date window must sum EXACTLY to the receipt total, with at least two
  // lines. No subset search — an exact full-group sum is explainable in an
  // audit; combinatorial subset picks are not. Confidence is capped below the
  // auto-confirm band so a human confirms every consolidated group.
  for (const receipt of eligibleReceipts) {
    if (assignedReceipts.has(receipt.id)) continue;
    if (receipt.amount_minor === null || !receipt.merchant) continue;
    if (!receipt.transaction_date) continue;

    const group = amexLines.filter(
      (line) =>
        !assignedLines.has(line.id) &&
        line.match_status !== "confirmed" &&
        line.match_status !== "no_receipt" &&
        line.currency.toUpperCase() === receipt.currency.toUpperCase() &&
        !!line.merchant &&
        (descriptionContains(line.merchant, receipt.merchant!) ||
          merchantAliasMatch(line.merchant, receipt.merchant!)) &&
        !!line.transaction_date &&
        daysBetween(line.transaction_date, receipt.transaction_date!) <= 7,
    );
    if (group.length < 2) continue;

    const groupSum = group.reduce((sum, line) => sum + line.amount_minor, 0);
    if (groupSum !== receipt.amount_minor) continue;

    for (const line of group) {
      const dateDelta = daysBetween(line.transaction_date!, receipt.transaction_date);
      const score = Math.min(
        0.5 + Math.max(0, 0.35 - 0.05 * dateDelta) + 0.15,
        CONSOLIDATED_CONFIDENCE_CAP,
      );
      assignedLines.add(line.id);
      resolved.push({
        amexLineId: line.id,
        receiptId: receipt.id,
        confidenceScore: score,
        matchReasons: [
          `consolidated receipt: ${group.length} lines sum to total`,
          "merchant match",
          `${dateDelta}-day window`,
        ],
        consolidatedGroupSize: group.length,
      });
    }
    assignedReceipts.add(receipt.id);
  }

  return resolved;
}
