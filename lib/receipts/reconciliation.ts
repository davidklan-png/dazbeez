import type {
  AmexStatementLine,
  ReconciliationMatch,
  ReceiptRecord,
} from "@/lib/receipts/types";

export function normalizeDescription(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      // Split at Latin/digit ↔ CJK script boundaries: statements print
      // "HUB 東京オペラシティ店" while receipts OCR as "HUB東京オペラシティ店" —
      // without segmentation the two tokenize differently and never match.
      .replace(/([a-z0-9])([぀-ヿ一-龯])/g, "$1 $2")
      .replace(/([぀-ヿ一-龯])([a-z0-9])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim()
  );
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

// Last-resort merchant bridge: the statement brand printed ON the receipt.
// Franchised operators issue receipts under their legal name (ENEOS station →
// 株式会社豊島屋) but the brand mark is in the OCR text. A statement-merchant
// token of ≥4 chars found in the receipt's normalized raw text counts as a
// merchant signal. Length ≥4 keeps short/generic tokens from false-matching.
function rawTextMentionsMerchant(
  rawTextNorm: string | null,
  lineMerchant: string,
): boolean {
  if (!rawTextNorm) return false;
  const tokens = normalizeDescription(lineMerchant)
    .split(" ")
    .filter((t) => t.length >= 4);
  return tokens.some((t) => rawTextNorm.includes(t));
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

  // Normalized raw OCR text per receipt, parsed lazily at most once — used by
  // the brand-on-receipt merchant fallback in the 1:1 bonus and phase-3 gate.
  const rawTextNormCache = new Map<string, string | null>();
  const rawTextOf = (receipt: ReceiptRecord): string | null => {
    let cached = rawTextNormCache.get(receipt.id);
    if (cached === undefined) {
      cached = null;
      if (receipt.extraction_json) {
        try {
          const parsed = JSON.parse(receipt.extraction_json) as { rawText?: string };
          cached = normalizeDescription(parsed.rawText ?? "") || null;
        } catch {
          /* malformed extraction JSON — no raw text available */
        }
      }
      rawTextNormCache.set(receipt.id, cached);
    }
    return cached;
  };

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
        } else if (rawTextMentionsMerchant(rawTextOf(receipt), line.merchant)) {
          score += 0.15;
          reasons.push("brand found on receipt text");
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
  // Runs only over lines left unmatched by the 1:1 phases. Policy
  // (deliberately narrow): the same-merchant unmatched lines within the date
  // window must sum EXACTLY to the receipt's REMAINING amount (total minus
  // any lines already confirmed against it), with at least two lines in the
  // full group. No subset search — an exact sum is explainable in an audit;
  // combinatorial subset picks are not. Confidence is capped below the
  // auto-confirm band so a human confirms every consolidated group.
  //
  // Already-confirmed siblings matter here (Codex review P2, 2026-07-08):
  // confirming the first line of a group promotes the receipt to
  // 'reconciled', which the 1:1 eligibility filter excludes — so the
  // remaining lines must be grouped against a wider receipt set, with the
  // confirmed lines' sum subtracted from the target.
  const confirmedSumByReceipt = new Map<string, { sum: number; count: number }>();
  for (const line of amexLines) {
    if (line.match_status !== "confirmed" || !line.matched_receipt_id) continue;
    const entry = confirmedSumByReceipt.get(line.matched_receipt_id) ?? { sum: 0, count: 0 };
    entry.sum += line.amount_minor;
    entry.count += 1;
    confirmedSumByReceipt.set(line.matched_receipt_id, entry);
  }

  const consolidationReceipts = receipts.filter((r) => {
    if (r.deleted_at !== null || r.status === "archived" || r.status === "exported") {
      return false;
    }
    // 'reconciled' receipts are only group-eligible when the claim comes from
    // this month's own confirmed lines — a receipt fully claimed elsewhere
    // must not be re-offered.
    if (r.status === "reconciled" && !confirmedSumByReceipt.has(r.id)) return false;
    return r.payment_path === "AMEX";
  });

  for (const receipt of consolidationReceipts) {
    if (assignedReceipts.has(receipt.id)) continue;
    if (receipt.amount_minor === null || !receipt.merchant) continue;
    if (!receipt.transaction_date) continue;

    const confirmed = confirmedSumByReceipt.get(receipt.id) ?? { sum: 0, count: 0 };
    const remaining = receipt.amount_minor - confirmed.sum;
    if (remaining <= 0) continue; // fully claimed (or over-claimed — a sign-off blocker)

    const group = amexLines.filter(
      (line) =>
        !assignedLines.has(line.id) &&
        line.match_status !== "confirmed" &&
        line.match_status !== "no_receipt" &&
        line.currency.toUpperCase() === receipt.currency.toUpperCase() &&
        !!line.merchant &&
        (descriptionContains(line.merchant, receipt.merchant!) ||
          merchantAliasMatch(line.merchant, receipt.merchant!) ||
          rawTextMentionsMerchant(rawTextOf(receipt), line.merchant)) &&
        !!line.transaction_date &&
        daysBetween(line.transaction_date, receipt.transaction_date!) <= 7,
    );
    const totalGroupSize = group.length + confirmed.count;
    if (group.length < 1 || totalGroupSize < 2) continue;

    const groupSum = group.reduce((sum, line) => sum + line.amount_minor, 0);
    if (groupSum !== remaining) continue;

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
          confirmed.count > 0
            ? `consolidated receipt: ${group.length} remaining line(s) sum to the unclaimed balance (${confirmed.count} already confirmed)`
            : `consolidated receipt: ${group.length} lines sum to total`,
          "merchant match",
          `${dateDelta}-day window`,
        ],
        consolidatedGroupSize: totalGroupSize,
      });
    }
    assignedReceipts.add(receipt.id);
  }

  return resolved;
}
