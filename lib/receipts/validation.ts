import type { ImportAmexLineInput } from "@/lib/receipts/types";

export const ALLOWED_RECEIPT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "application/pdf",
];

export const ALLOWED_RECEIPT_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
  ".pdf",
];

export const MAX_RECEIPT_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB

export const ALLOWED_CURRENCIES = ["JPY", "USD", "EUR", "GBP", "AUD", "CNY"];

export function validateReceiptFile(file: File): string | null {
  if (file.size > MAX_RECEIPT_FILE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return `File is too large (${mb} MB). Maximum allowed size is 10 MB.`;
  }

  const ext = `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`;
  const mimeOk = ALLOWED_RECEIPT_MIME_TYPES.includes(file.type);
  const extOk = ALLOWED_RECEIPT_EXTENSIONS.includes(ext);

  if (!mimeOk && !extOk) {
    return `File type not allowed. Accepted: JPEG, PNG, HEIC, PDF.`;
  }

  return null;
}

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

// ─── Legacy simple AMEX CSV parser (kept for backward compat) ─────────────

export function parseAmexCsv(
  text: string,
  statementMonth: string,
): ImportAmexLineInput[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return [];

  // Skip header row
  const rows = lines.slice(1);
  const results: ImportAmexLineInput[] = [];

  for (const line of rows) {
    const fields = parseCsvLine(line);
    if (fields.length < 3) continue;

    let transactionDateRaw: string;
    let postDateRaw: string | undefined;
    let merchantRaw: string;
    let amountRaw: string;

    const field0IsDate = parseAmexDate(fields[0] ?? "") !== null;
    const field1IsDate = parseAmexDate(fields[1] ?? "") !== null;

    if (field0IsDate && field1IsDate) {
      transactionDateRaw = fields[0] ?? "";
      postDateRaw = fields[1];
      merchantRaw = fields[2] ?? "";
      amountRaw = fields[3] ?? "";
    } else {
      transactionDateRaw = fields[0] ?? "";
      merchantRaw = fields[1] ?? "";
      amountRaw = fields[2] ?? "";
    }

    const transactionDate = parseAmexDate(transactionDateRaw);
    if (!transactionDate) continue;

    const postingDate = postDateRaw ? parseAmexDate(postDateRaw) ?? undefined : undefined;

    const merchant = merchantRaw.trim();
    if (!merchant) continue;

    const amountFloat = parseFloat(amountRaw.replace(/[^0-9.-]/g, ""));
    if (isNaN(amountFloat)) continue;

    const amountMinor = Math.round(Math.abs(amountFloat) * 100);

    results.push({
      statementMonth,
      transactionDate,
      postingDate,
      merchant,
      amountMinor,
      rawJson: JSON.stringify({ fields }),
    });
  }

  return results;
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
  rawFields: string[];
}

export interface NetanswerParseResult {
  metadata: NetanswerMetadata;
  lines: NetanswerParsedLine[];
  validationErrors: string[];
  parsedTotalCents: number;
  rowCount: number;
}

function decodeAmexBuffer(buffer: ArrayBuffer): { text: string; encoding: string } {
  // Try UTF-8 first (fatal: true throws on invalid byte sequences)
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    // Strip UTF-8 BOM if present
    return { text: text.replace(/^﻿/, ""), encoding: "utf-8" };
  } catch {
    // fall through
  }
  // Try Shift-JIS (CP932-compatible for Netアンサー files)
  try {
    const text = new TextDecoder("shift_jis", { fatal: true }).decode(buffer);
    return { text, encoding: "shift_jis" };
  } catch {
    // fall through
  }
  throw new Error(
    "Could not read this CSV. Netアンサー files are usually CP932/Shift-JIS. Please upload the original CSV file.",
  );
}

// Known outside-Tokyo location signals
const OUTSIDE_TOKYO_SIGNALS = [
  "神奈川", "横浜", "大阪", "京都", "福岡", "札幌", "名古屋", "仙台", "広島",
  "埼玉", "千葉", "兵庫", "神戸", "奈良", "滋賀", "岡山", "北海道", "静岡",
  "愛知", "栃木", "群馬", "茨城", "宮城", "新潟", "富山", "金沢", "石川",
  "Hiroshima", "Osaka", "Kyoto", "Yokohama", "Kanagawa", "Nagoya", "Sapporo",
  "Sendai", "Fukuoka", "KANAGAWA", "OSAKA", "KYOTO", "HIROSHIMA",
];

// Tokyo signals — presence means NOT outside Tokyo
const TOKYO_SIGNALS = [
  "東京都", "東京", "新宿", "渋谷", "中野", "東中野", "港区", "東京オペラシティ",
  "Tokyo", "TOKYO",
];

export function isOutsideTokyo(merchantName: string): boolean {
  // If it contains a Tokyo signal, it's in Tokyo
  for (const sig of TOKYO_SIGNALS) {
    if (merchantName.includes(sig)) return false;
  }
  // If it contains an outside-Tokyo signal, it's outside Tokyo
  for (const sig of OUTSIDE_TOKYO_SIGNALS) {
    if (merchantName.includes(sig)) return true;
  }
  return false;
}

export function parseAmexNetanswer(
  buffer: ArrayBuffer,
  statementMonth: string,
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
      const raw_amount = (fields[1] ?? "").trim().replace(/[^0-9]/g, "");
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

    // Transaction row: col0 matches date
    const txDate = parseAmexDate(col0);
    if (!txDate) continue;

    const merchantName = col1;
    if (!merchantName) continue;

    const txCardholderFlag = fields[2]?.trim() || null;
    const paymentType = fields[3]?.trim() || null;
    const prepaymentFlag = fields[4]?.trim() || null;
    const amountRaw = (fields[5] ?? "").replace(/[^0-9]/g, "");
    const memo = fields[6]?.trim() || null;

    if (!amountRaw) continue;
    const amountCents = parseInt(amountRaw, 10);
    if (isNaN(amountCents) || amountCents < 0) continue;

    lines.push({
      lineNumber: i + 1,
      cardholderName: currentCardholder,
      cardholderFlag: txCardholderFlag || currentCardholderFlag,
      transactionDate: txDate,
      merchantName,
      paymentType,
      prepaymentFlag,
      amountCents,
      currency: "JPY",
      memo: memo || null,
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
    rawCsvLineNumber: l.lineNumber,
    sourceFileSha256: sha256,
  }));
}

// ─── Business trip candidate detection ────────────────────────────────────

import type { BusinessTripCandidate } from "@/lib/receipts/types";

interface TripableAmexLine {
  id: string;
  cardholderName: string | null;
  transactionDate: string;
  merchant: string;
}

export function detectBusinessTripCandidates(
  lines: TripableAmexLine[],
  windowDays = 7,
): BusinessTripCandidate[] {
  // Only consider lines that are outside Tokyo
  const outsideLines = lines.filter(
    (l) => l.cardholderName && isOutsideTokyo(l.merchant),
  );

  if (outsideLines.length < 2) return [];

  // Group by cardholder
  const byCardholder = new Map<string, typeof outsideLines>();
  for (const line of outsideLines) {
    const ch = line.cardholderName!;
    if (!byCardholder.has(ch)) byCardholder.set(ch, []);
    byCardholder.get(ch)!.push(line);
  }

  const candidates: BusinessTripCandidate[] = [];

  for (const [cardholder, chLines] of byCardholder) {
    // Sort by date
    const sorted = [...chLines].sort((a, b) =>
      a.transactionDate.localeCompare(b.transactionDate),
    );

    // Cluster: group lines where adjacent dates are within windowDays
    let cluster: typeof sorted = [sorted[0]!];
    for (let i = 1; i < sorted.length; i++) {
      const prev = cluster[cluster.length - 1]!;
      const dayDiff = dateDiffDays(prev.transactionDate, sorted[i]!.transactionDate);
      if (dayDiff <= windowDays) {
        cluster.push(sorted[i]!);
      } else {
        if (cluster.length >= 2) {
          candidates.push(buildCandidate(cardholder, cluster));
        }
        cluster = [sorted[i]!];
      }
    }
    if (cluster.length >= 2) {
      candidates.push(buildCandidate(cardholder, cluster));
    }
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
  // Extract location signal from first outside-Tokyo merchant
  const locationSignal = extractLocationSignal(cluster[0]!.merchant);
  return {
    cardholderName,
    startDate: dates[0]!,
    endDate: dates[dates.length - 1]!,
    primaryLocation: locationSignal,
    lineIds: cluster.map((l) => l.id),
  };
}

function extractLocationSignal(merchant: string): string {
  for (const sig of OUTSIDE_TOKYO_SIGNALS) {
    if (merchant.includes(sig)) return sig;
  }
  return merchant.slice(0, 20);
}
