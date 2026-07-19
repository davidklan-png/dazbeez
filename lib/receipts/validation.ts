import type { ImportAmexLineInput } from "@/lib/receipts/types";
import {
  parseForeignCurrencyMemo,
  parseExchangeRateMemo,
  foreignAmountCrossCheckOk,
  type ForeignCurrencyParseStatus,
} from "@/lib/receipts/foreign-currency";

// Receipt file validation, accepted types, and size limits now live in the
// client-safe upload-policy module (shared with capture components so the UI
// contract and server enforcement can't drift). Re-exported here for existing
// callers/tests that import from "@/lib/receipts/validation".
export {
  validateReceiptFile,
  MAX_RECEIPT_FILE_BYTES,
  ALLOWED_RECEIPT_MIME_TYPES,
  ALLOWED_RECEIPT_EXTENSIONS,
} from "@/lib/receipts/upload-policy";

export const ALLOWED_CURRENCIES = ["JPY", "USD", "EUR", "GBP", "AUD", "CNY"];

export function validateReceiptDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value);
  if (isNaN(d.getTime())) return false;
  return d.getTime() <= Date.now();
}

export function validateAmountMinor(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export function validateCurrency(value: string): boolean {
  return ALLOWED_CURRENCIES.includes(value.toUpperCase());
}

// ─── Shared CSV helpers ────────────────────────────────────────────────────

export function parseAmexDate(raw: string): string | null {
  const cleaned = raw.trim();

  // YYYY/MM/DD or YYYY-MM-DD
  if (/^\d{4}[/-]\d{2}[/-]\d{2}$/.test(cleaned)) {
    return cleaned.replace(/\//g, "-");
  }

  // MM/DD/YYYY (US format)
  const mdy = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const [, mm, dd, yyyy] = mdy;
    return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
  }

  return null;
}

export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ─── Netアンサー CSV parser ────────────────────────────────────────────────

export interface NetanswerMetadata {
  cardName: string | null;
  paymentDueDate: string | null;
  statementTotalCents: number | null;
  encoding: string;
}

export interface NetanswerParsedLine {
  lineNumber: number;
  cardholderName: string | null;
  cardholderFlag: string | null;
  transactionDate: string;
  merchantName: string;
  paymentType: string | null;
  prepaymentFlag: string | null;
  amountCents: number;
  currency: string;
  memo: string | null;
  // Foreign-currency detail parsed from memo (migration 0026). For an
  // overseas-billed charge, amountCents/currency are the JPY-converted total
  // reported on the statement; these hold the original foreign amount parsed
  // off the 現地通貨額 memo so reconciliation can match a USD (etc.) receipt
  // against it. memoCurrencyParseStatus: null = no 現地通貨額 marker (ordinary
  // JPY line), "parsed" = extracted, "unparsed" = marker present but extraction
  // failed OR the FX-rate cross-check failed (rate attached from the trailing
  // continuation row below). foreignAmountMinor inherits the line's own sign
  // (negative for refunds); foreignExchangeRate is informational only.
  foreignAmountMinor: number | null;
  foreignCurrency: string | null;
  foreignExchangeRate: number | null;
  memoCurrencyParseStatus: ForeignCurrencyParseStatus | null;
  rawFields: string[];
  // True when this row had no 利用日 (usage date) in the CSV — e.g. an annual
  // card fee, late fee, or interest adjustment. These are real charges that
  // count toward the statement total but are billed on a fixed schedule
  // rather than tied to a purchase, so no receipt will ever exist for them.
  // transactionDate is backfilled with the statement's payment due date (or
  // the statement month) purely so the NOT NULL column has a sortable value.
  noReceiptRequired: boolean;
  noReceiptReason: string | null;
}

export interface SkippedLineInfo {
  lineNumber: number;
  reason: string;
  // True when the skip is known to carry no monetary value and requires no
  // operator action — e.g. the trailing no-date/no-amount annotation row
  // Netアンサー emits after an overseas-currency charge (the JPY amount and
  // 現地通貨額 detail are already captured on the preceding dated row's own
  // line/memo). False (default) means this may be a real parsing problem
  // the operator should look at.
  benign: boolean;
}

export interface NetanswerParseResult {
  metadata: NetanswerMetadata;
  lines: NetanswerParsedLine[];
  skippedLines: SkippedLineInfo[];
  validationErrors: string[];
  parsedTotalCents: number;
  rowCount: number;
}

export function decodeAmexBuffer(buffer: ArrayBuffer): { text: string; encoding: string } {
  const bytes = new Uint8Array(buffer);

  // Detect CP932/Shift-JIS by scanning for high-byte patterns that are
  // invalid in UTF-8 but valid in Shift-JIS:
  //   Lead bytes:  0x81–0x9F, 0xE0–0xFC  (followed by trail byte 0x40–0x7E or 0x80–0xFC)
  //   Katakana:    0xA1–0xDF  (standalone, these are UTF-8 continuation bytes → invalid standalone)
  // UTF-8 fatal mode can silently accept some CP932 sequences (producing mojibake),
  // so we must detect CP932 explicitly and decode with shift_jis FIRST.
  let looksLikeShiftJis = false;
  const scanLen = Math.min(bytes.length, 4096);

  for (let i = 0; i < scanLen; i++) {
    const b = bytes[i]!;
    if ((b >= 0x81 && b <= 0x9F) || (b >= 0xE0 && b <= 0xFC)) {
      if (i + 1 < bytes.length) {
        const t = bytes[i + 1]!;
        if ((t >= 0x40 && t <= 0x7E) || (t >= 0x80 && t <= 0xFC)) {
          looksLikeShiftJis = true;
          break;
        }
      }
    } else if (b >= 0xA1 && b <= 0xDF) {
      looksLikeShiftJis = true;
      break;
    }
  }

  if (looksLikeShiftJis) {
    try {
      const text = new TextDecoder("shift_jis", { fatal: true }).decode(buffer);
      return { text, encoding: "shift_jis" };
    } catch {
      // Fall through to UTF-8
    }
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    // Strip UTF-8 BOM if present
    return { text: text.replace(/^\uFEFF/, ""), encoding: "utf-8" };
  } catch {
    // fall through
  }

  // Last resort: try shift_jis even without byte-pattern match
  try {
    const text = new TextDecoder("shift_jis").decode(buffer);
    return { text, encoding: "shift_jis" };
  } catch {
    throw new Error(
      "Could not read this CSV. Netアンサー files are usually CP932/Shift-JIS. Please upload the original CSV file.",
    );
  }
}

// Known outside-homebase region signals (ADR 0010 D3: renamed from
// OUTSIDE_TOKYO_SIGNALS; contents unchanged). A merchant carrying one of these
// AND no homebase signal is a trip ANCHOR.
const REGION_SIGNALS = [
  "神奈川", "横浜", "大阪", "京都", "福岡", "札幌", "名古屋", "仙台", "広島",
  "埼玉", "千葉", "兵庫", "神戸", "奈良", "滋賀", "岡山", "北海道", "静岡",
  "愛知", "栃木", "群馬", "茨城", "宮城", "新潟", "富山", "金沢", "石川",
  "Hiroshima", "Osaka", "Kyoto", "Yokohama", "Kanagawa", "Nagoya", "Sapporo",
  "Sendai", "Fukuoka", "KANAGAWA", "OSAKA", "KYOTO", "HIROSHIMA",
];

// Default homebase signals — verbatim the former hardcoded TOKYO_SIGNALS list
// (ADR 0010 D3). Presence in a merchant means the charge is at homebase (NOT a
// trip anchor). Exported so ComplianceSettings can default to it and detection
// tests can reproduce today's behavior; the operator can override it in
// Settings → Compliance (stored under key `homebase_signals`).
export const DEFAULT_HOMEBASE_SIGNALS = [
  "東京都", "東京", "新宿", "渋谷", "中野", "東中野", "港区", "東京オペラシティ",
  "Tokyo", "TOKYO",
];

/** Does `merchant` carry a homebase signal (i.e. is it an at-homebase charge)? */
export function hasHomebaseSignal(
  merchant: string,
  homebaseSignals: string[],
): boolean {
  return homebaseSignals.some((sig) => merchant.includes(sig));
}

/**
 * Is `merchant` outside the homebase (a trip anchor)? True only when it carries
 * a region signal AND no homebase signal. ADR 0010 D3 renamed this from
 * isOutsideTokyo; `homebaseSignals` replaces the hardcoded TOKYO_SIGNALS list.
 */
export function isOutsideHomebase(
  merchant: string,
  homebaseSignals: string[],
): boolean {
  if (hasHomebaseSignal(merchant, homebaseSignals)) return false;
  return REGION_SIGNALS.some((sig) => merchant.includes(sig));
}

export function parseAmexNetanswer(
  buffer: ArrayBuffer,
  _statementMonth: string,
): NetanswerParseResult {
  const { text, encoding } = decodeAmexBuffer(buffer);
  const rawLines = text.split(/\r?\n/);

  const metadata: NetanswerMetadata = {
    cardName: null,
    paymentDueDate: null,
    statementTotalCents: null,
    encoding,
  };

  let currentCardholder: string | null = null;
  let currentCardholderFlag: string | null = null;
  const lines: NetanswerParsedLine[] = [];
  const skippedLines: SkippedLineInfo[] = [];
  const validationErrors: string[] = [];
  let headerFound = false;
  let totalRowCount = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    totalRowCount++;
    const fields = parseCsvLine(trimmed);

    // Metadata rows: identified by first column value
    const col0 = fields[0]?.trim() ?? "";

    if (col0 === "カード名称") {
      metadata.cardName = fields[1]?.trim() ?? null;
      continue;
    }
    if (col0 === "お支払日") {
      metadata.paymentDueDate = parseAmexDate(fields[1]?.trim() ?? "");
      continue;
    }
    if (col0 === "今回ご請求額") {
      // Total may contain comma thousands separators that split across fields
      const raw_amount = fields.slice(1).join("").replace(/[^0-9]/g, "");
      if (raw_amount) metadata.statementTotalCents = parseInt(raw_amount, 10);
      continue;
    }

    // Header row: first column is 利用日
    if (col0 === "利用日") {
      headerFound = true;
      continue;
    }

    const col1 = fields[1]?.trim() ?? "";

    // Cardholder section row: col1 starts with ご利用者名:
    if (col1.startsWith("ご利用者名:")) {
      const nameRaw = col1.replace("ご利用者名:", "").trim().replace(/様\s*$/, "").trim();
      currentCardholder = nameRaw || null;
      currentCardholderFlag = fields[2]?.trim() || null;
      continue;
    }

    // Skip subtotal / total rows
    if (col1 === "【小計】" || col1 === "【合計】") continue;

    // Transaction row: normally col0 is the 利用日 (usage date). Netアンサー
    // also emits real charge lines with NO date — annual card fees
    // (カード年会費) are the known case, but late fees / interest / other
    // fixed adjustments follow the same shape. These still count toward
    // 今回ご請求額 (the statement total), so treating "no date" as "not a
    // transaction" silently drops real money and breaks the total
    // reconciliation check below (see incident: ¥36,300 of annual fees
    // dropped from the 2026-07 Saison statement). Instead: any row here with
    // a description in col1 is a real charge; only fall back to skipping if
    // col1 is empty (blank/malformed row).
    const txDate = parseAmexDate(col0);
    const isUndatedChargeLine = !txDate;

    const merchantName = col1;
    if (!merchantName) {
      skippedLines.push({ lineNumber: i + 1, reason: "missing merchant", benign: false });
      continue;
    }

    const txCardholderFlag = fields[2]?.trim() || null;
    const paymentType = fields[3]?.trim() || null;
    const prepaymentFlag = fields[4]?.trim() || null;

    // Amount may span multiple fields if it contains comma thousands separators.
    // Expected layout (7 fields with trailing comma): date, merchant, flag, payment, prepay, amount, memo
    // With comma in amount (8+ fields): the amount is split across fields[5..n-1], memo is last field.
    let amountRaw: string;
    let memoField: string | null;

    if (fields.length > 7) {
      // Comma-formatted amount — rejoin
      amountRaw = fields.slice(5, -1).join("");
      memoField = fields[fields.length - 1]?.trim() || null;
    } else {
      amountRaw = fields[5] ?? "";
      memoField = fields[6]?.trim() || null;
    }

    const memo = memoField;

    // Capture sign before stripping non-digits. Netアンサー uses ASCII "-" and
    // sometimes the Japanese "△" / "▲" symbols to mark refunds; without this
    // they would be silently imported as positive charges and break the
    // statement-total reconciliation.
    const isNegative = /[-−△▲]/.test(amountRaw);
    const digits = amountRaw.replace(/[^0-9]/g, "");
    if (!digits) {
      // A row with a real 利用日 date but no amount is a genuine parsing
      // problem worth an operator's attention. A row with NO date and no
      // amount can never be a legitimate charge under this CSV format (real
      // undated charges — annual fees, etc. — always carry an amount, see
      // isUndatedChargeLine above); in practice this is the trailing
      // no-value annotation row Netアンサー emits after an overseas-currency
      // charge (現地通貨額 is already captured in the preceding dated row's
      // memo, e.g. line 20 above). Label it as benign so the UI doesn't
      // raise it as a warning.
      //
      // Foreign-charge continuation-row correlation (migration 0026): this
      // trailing row also carries the FX rate actually used
      // (円換算レート:M/D <rate>), which would otherwise vanish into
      // skippedLines unread. When the immediately preceding pushed line
      // parsed a 現地通貨額 foreign amount, rescue the rate off this row's
      // memo, attach it to that line, and run the rate × foreign-amount
      // cross-check — a mismatch downgrades the line to "unparsed" so a bad
      // parse can't silently drive a foreign-currency match. The row is still
      // skipped either way (it has no monetary value of its own).
      if (isUndatedChargeLine) {
        const prev = lines[lines.length - 1];
        if (prev && prev.memoCurrencyParseStatus === "parsed" && memo) {
          const rate = parseExchangeRateMemo(memo);
          if (rate != null) {
            prev.foreignExchangeRate = rate;
            if (
              prev.foreignAmountMinor != null &&
              prev.foreignCurrency &&
              !foreignAmountCrossCheckOk({
                foreignAmountMinor: prev.foreignAmountMinor,
                foreignCurrency: prev.foreignCurrency,
                jpyAmountMinorAbs: Math.abs(prev.amountCents),
                exchangeRate: rate,
              })
            ) {
              prev.memoCurrencyParseStatus = "unparsed";
            }
          }
        }
      }
      skippedLines.push({
        lineNumber: i + 1,
        reason: isUndatedChargeLine
          ? "no date, no amount — informational row, no monetary value (commonly the overseas-currency annotation line trailing a foreign-billed charge; see the memo on the transaction row above)"
          : "missing amount",
        benign: isUndatedChargeLine,
      });
      continue;
    }
    const magnitude = parseInt(digits, 10);
    if (isNaN(magnitude)) {
      skippedLines.push({
        lineNumber: i + 1,
        benign: false,
        reason: `unparseable amount: ${amountRaw.slice(0, 30)}`,
      });
      continue;
    }
    const amountCents = isNegative ? -magnitude : magnitude;

    // Undated charge lines (annual fees, etc.) have no 利用日 to store in the
    // NOT NULL transaction_date column. Fall back to the statement's payment
    // due date, then the statement month, so the row still sorts sensibly
    // and the true reason (no receipt exists / possible) is preserved.
    const effectiveDate =
      txDate ?? metadata.paymentDueDate ?? `${_statementMonth}-01`;

    // Foreign-currency parse (migration 0026). 現地通貨額 memo → original
    // foreign amount. The memo is a magnitude only, so inherit the line's own
    // sign (a refund line's foreign amount is negative too). foreignExchangeRate
    // starts null here and is attached from the trailing continuation row above
    // when one follows; the cross-check there may downgrade status to "unparsed".
    const foreign = parseForeignCurrencyMemo(memo);
    let foreignAmountMinor: number | null = null;
    let foreignCurrency: string | null = null;
    let memoCurrencyParseStatus: ForeignCurrencyParseStatus | null = null;
    if (foreign.status === "parsed") {
      foreignAmountMinor = isNegative ? -foreign.amountMinor : foreign.amountMinor;
      foreignCurrency = foreign.currency;
      memoCurrencyParseStatus = "parsed";
    } else if (foreign.status === "unparsed") {
      memoCurrencyParseStatus = "unparsed";
    }

    lines.push({
      lineNumber: i + 1,
      cardholderName: currentCardholder,
      cardholderFlag: txCardholderFlag || currentCardholderFlag,
      transactionDate: effectiveDate,
      merchantName,
      paymentType,
      prepaymentFlag,
      amountCents,
      currency: "JPY",
      memo: memo || null,
      foreignAmountMinor,
      foreignCurrency,
      foreignExchangeRate: null,
      memoCurrencyParseStatus,
      noReceiptRequired: isUndatedChargeLine,
      noReceiptReason: isUndatedChargeLine
        ? `No 利用日 (usage date) on statement for "${merchantName}" — fixed/recurring charge, no receipt applicable.`
        : null,
      rawFields: fields,
    });
  }

  if (!headerFound) {
    validationErrors.push(
      "Header row (利用日) not found. This may not be a Netアンサー CSV.",
    );
  }

  const parsedTotalCents = lines.reduce((s, l) => s + l.amountCents, 0);

  if (
    metadata.statementTotalCents !== null &&
    lines.length > 0 &&
    parsedTotalCents !== metadata.statementTotalCents
  ) {
    validationErrors.push(
      `The parsed total ¥${parsedTotalCents.toLocaleString()} does not match the statement total ¥${metadata.statementTotalCents.toLocaleString()}. No line items were imported.`,
    );
  }

  if (lines.length === 0 && validationErrors.length === 0) {
    validationErrors.push("No transaction rows found in this CSV.");
  }

  // Map to ImportAmexLineInput for DB insert (only if validation passes)
  return {
    metadata,
    lines,
    skippedLines,
    validationErrors,
    parsedTotalCents,
    rowCount: totalRowCount,
  };
}

export function netanswerLinesToImportInputs(
  lines: NetanswerParsedLine[],
  statementMonth: string,
  artifactId: string,
  sha256: string,
): ImportAmexLineInput[] {
  return lines.map((l) => ({
    statementMonth,
    transactionDate: l.transactionDate,
    merchant: l.merchantName,
    amountMinor: l.amountCents,
    currency: l.currency,
    rawJson: JSON.stringify({ fields: l.rawFields, lineNumber: l.lineNumber }),
    statementArtifactId: artifactId,
    cardholderName: l.cardholderName ?? undefined,
    cardholderFlag: l.cardholderFlag ?? undefined,
    paymentType: l.paymentType ?? undefined,
    prepaymentFlag: l.prepaymentFlag ?? undefined,
    memo: l.memo ?? undefined,
    foreignAmountMinor: l.foreignAmountMinor ?? undefined,
    foreignCurrency: l.foreignCurrency ?? undefined,
    foreignExchangeRate: l.foreignExchangeRate ?? undefined,
    memoCurrencyParseStatus: l.memoCurrencyParseStatus ?? undefined,
    rawCsvLineNumber: l.lineNumber,
    sourceFileSha256: sha256,
    receiptStatus: l.noReceiptRequired ? "no_receipt_required" : undefined,
    receiptMissingReason: l.noReceiptReason ?? undefined,
  }));
}

// ─── Business trip candidate detection (ADR 0010 D3) ───────────────────────

import type { BusinessTripCandidate } from "@/lib/receipts/types";
import { isBusinessTripEligible } from "@/lib/receipts/categories";

interface TripableAmexLine {
  id: string;
  cardholderName: string | null;
  transactionDate: string;
  merchant: string;
  /**
   * Resolved expense category code for the category-boost rule (ADR 0010 D3).
   * Optional so legacy callers/fixtures without a category still work — an
   * absent/null category is simply never boost-eligible (today's behavior).
   */
  expenseCategoryCode?: string | null;
}

/**
 * Detect business-trip candidate clusters from a set of AMEX lines.
 *
 * ANCHORS: lines with a location signal outside homebase (as before).
 * BOOST: lines whose expense category is trip-eligible AND whose merchant
 * carries no homebase signal (e.g. Ekinet / airline / hotel-chain charges
 * that bill without a region string) join a cluster when within `windowDays`
 * of a member line. A cluster ships as a candidate only if it contains ≥1
 * anchor AND ≥2 lines total — boost lines never form a cluster alone.
 *
 * `homebaseSignals` replaces the former hardcoded TOKYO_SIGNALS list; default
 * `DEFAULT_HOMEBASE_SIGNALS` reproduces today's behavior exactly on lines with
 * no category code (the boost set is empty, so only anchors cluster, as today).
 */
export function detectBusinessTripCandidates(
  lines: TripableAmexLine[],
  homebaseSignals: string[] = DEFAULT_HOMEBASE_SIGNALS,
  windowDays = 7,
): BusinessTripCandidate[] {
  // Partition into anchors and boost-eligible lines (both require a cardholder).
  type L = (typeof lines)[number];
  const anchors: L[] = [];
  const boosts: L[] = [];
  for (const line of lines) {
    if (!line.cardholderName) continue;
    if (isOutsideHomebase(line.merchant, homebaseSignals)) {
      anchors.push(line);
    } else if (
      isBusinessTripEligible(line.expenseCategoryCode) &&
      !hasHomebaseSignal(line.merchant, homebaseSignals)
    ) {
      boosts.push(line);
    }
  }

  // Need at least one anchor anywhere to form any candidate.
  if (anchors.length === 0) return [];

  // Group anchors + boost lines by cardholder.
  const byCardholder = new Map<string, L[]>();
  const push = (ch: string, line: L) => {
    const arr = byCardholder.get(ch);
    if (arr) arr.push(line);
    else byCardholder.set(ch, [line]);
  };
  for (const line of anchors) push(line.cardholderName!, line);
  for (const line of boosts) push(line.cardholderName!, line);

  const candidates: BusinessTripCandidate[] = [];

  for (const [cardholder, chLines] of byCardholder) {
    // A cardholder with only boost lines (no anchor) can't form a candidate.
    if (!chLines.some((l) => isOutsideHomebase(l.merchant, homebaseSignals))) {
      continue;
    }
    const sorted = [...chLines].sort((a, b) =>
      a.transactionDate.localeCompare(b.transactionDate),
    );

    // Cluster: group lines where adjacent dates are within windowDays.
    let cluster: typeof sorted = [sorted[0]!];
    const flush = () => {
      // ≥2 lines AND ≥1 anchor (boost-never-alone).
      const hasAnchor = cluster.some((l) =>
        isOutsideHomebase(l.merchant, homebaseSignals),
      );
      if (cluster.length >= 2 && hasAnchor) {
        candidates.push(buildCandidate(cardholder, cluster));
      }
    };
    for (let i = 1; i < sorted.length; i++) {
      const prev = cluster[cluster.length - 1]!;
      const dayDiff = dateDiffDays(prev.transactionDate, sorted[i]!.transactionDate);
      if (dayDiff <= windowDays) {
        cluster.push(sorted[i]!);
      } else {
        flush();
        cluster = [sorted[i]!];
      }
    }
    flush();
  }

  return candidates;
}

function dateDiffDays(a: string, b: string): number {
  const msPerDay = 86_400_000;
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / msPerDay;
}

function buildCandidate(
  cardholderName: string,
  cluster: Array<{ id: string; transactionDate: string; merchant: string }>,
): BusinessTripCandidate {
  const dates = cluster.map((l) => l.transactionDate).sort();
  // Extract a location signal from the first anchor merchant in the cluster
  // (the cluster is guaranteed ≥1 anchor by the caller).
  const anchorMerchant =
    cluster.find((l) => REGION_SIGNALS.some((sig) => l.merchant.includes(sig)))?.merchant ??
    cluster[0]!.merchant;
  const locationSignal = extractLocationSignal(anchorMerchant);
  return {
    cardholderName,
    startDate: dates[0]!,
    endDate: dates[dates.length - 1]!,
    primaryLocation: locationSignal,
    lineIds: cluster.map((l) => l.id),
  };
}

function extractLocationSignal(merchant: string): string {
  for (const sig of REGION_SIGNALS) {
    if (merchant.includes(sig)) return sig;
  }
  return merchant.slice(0, 20);
}
