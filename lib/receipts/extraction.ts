import { getGoogleCloudVisionApiKey } from "@/lib/cloudflare-runtime";
import { ALLOWED_CURRENCIES } from "@/lib/receipts/validation";
import { normalizeRegistrationNumber } from "@/lib/receipts/invoice";
import type { ExtractionResult } from "@/lib/receipts/types";

interface ExtractionProvider {
  name: string;
  extract(imageBytes: Uint8Array, contentType: string): Promise<ExtractionResult>;
}

interface GoogleVisionError {
  code?: number;
  message?: string;
  status?: string;
}

interface GoogleVisionResponse {
  responses?: Array<{
    fullTextAnnotation?: { text?: string };
    error?: GoogleVisionError;
  }>;
  error?: GoogleVisionError;
}

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/tiff",
  "image/bmp",
]);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function normalizeContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function normalizeCurrency(rawText: string): string {
  const upper = rawText.toUpperCase();
  if (upper.includes("USD") || upper.includes("$")) return "USD";
  if (upper.includes("EUR") || upper.includes("€")) return "EUR";
  if (upper.includes("GBP") || upper.includes("£")) return "GBP";
  if (upper.includes("AUD")) return "AUD";
  if (upper.includes("CNY") || upper.includes("RMB")) return "CNY";
  return "JPY";
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

function parseTransactionDate(rawText: string): string | null {
  const normalized = rawText.replace(/[年月]/g, "/").replace(/[日]/g, "");

  const western = normalized.match(
    /(?:20\d{2})[./-]\s*(\d{1,2})[./-]\s*(\d{1,2})|(?:20\d{2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})/,
  );
  if (western) {
    const year = Number(western[0].match(/20\d{2}/)?.[0]);
    const month = Number(western[1] ?? western[3]);
    const day = Number(western[2] ?? western[4]);
    return toIsoDate(year, month, day);
  }

  const reiwa = rawText.match(/令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (reiwa) {
    const year = 2018 + Number(reiwa[1]);
    return toIsoDate(year, Number(reiwa[2]), Number(reiwa[3]));
  }

  const heisei = rawText.match(/平成\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (heisei) {
    const year = 1988 + Number(heisei[1]);
    return toIsoDate(year, Number(heisei[2]), Number(heisei[3]));
  }

  return null;
}

function parseMoneyCandidates(line: string): number[] {
  const matches = line.matchAll(
    /(?:[¥￥$€£]\s*)?(-?\d{1,3}(?:,\d{3})+|-?\d+)(?:\.(\d{1,2}))?(?:\s*円)?/g,
  );
  return Array.from(matches)
    .map((match) => Number(`${match[1]?.replace(/,/g, "")}${match[2] ? `.${match[2]}` : ""}`))
    .filter((value) => Number.isFinite(value) && Math.abs(value) > 0);
}

function hasMoneySignal(line: string): boolean {
  return /[¥￥$€£円]/.test(line) || /\d{1,3}(?:,\d{3})+/.test(line);
}

function parseAmountMinor(rawText: string, currency: string): number | null {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const totalKeywords = [
    "合計",
    "総合計",
    "お買上計",
    "お買上げ計",
    "お買上げ合計",
    "ご請求額",
    "請求額",
    "領収金額",
    "税込",
    "total",
    "amount due",
    "grand total",
  ];
  const skipKeywords = [
    "小計",
    "税",
    "消費税",
    "内税",
    "外税",
    "対象",
    "預り",
    "お預り",
    "釣",
    "お釣",
    "change",
    "cash",
    "subtotal",
    "tax",
    "points",
    "ポイント",
  ];

  const totalLineCandidates = lines
    .filter((line) => {
      const lower = line.toLowerCase();
      return (
        totalKeywords.some((keyword) => lower.includes(keyword.toLowerCase())) &&
        !skipKeywords.some((keyword) => lower.includes(keyword.toLowerCase()))
      );
    })
    .flatMap(parseMoneyCandidates);

  const fallbackCandidates = lines.filter(hasMoneySignal).flatMap(parseMoneyCandidates);
  const candidates = totalLineCandidates.length > 0 ? totalLineCandidates : fallbackCandidates;
  if (candidates.length === 0) return null;

  const amount = Math.max(...candidates.map(Math.abs));
  return currency === "JPY" ? Math.round(amount) : Math.round(amount * 100);
}

// Card-brand tokens that frequently top-print on receipts and were being
// mistaken for the merchant ("AMEX", "AMGX", "AMEX TULLY'S", ...).
const CARD_BRAND_RE =
  /\b(?:amex|amgx|american\s+express|visa|jcb|master(?:card)?|diners|union\s?pay)\b|アメックス|ダイナース/gi;

// Lines that are never the merchant: receipt labels, footer keywords, the
// cardholder/recipient line (様), addresses, money, dates, and capture noise.
const MERCHANT_NOISE_RE: RegExp[] = [
  /領収|レシート|receipt|tax\s*invoice|インボイス/i,
  /登録番号|電話|tel|fax|phone|☎|〒/i,
  /但し|として|上記正に|ご来店|お越し|ありがと|お待ち|印刷面|お預|お釣/,
  /^(?:様|担当|担当者|印|収入|印紙|リスト|会費|接待費|内訳|小計|合計|総計|税率|消費税|現金|釣|点数|番号|受付|テーブル|人数|no\.?|pos)/i,
  /^(?:東京都|北海道|大阪府|京都府|神奈川県|埼玉県|千葉県|愛知県|兵庫県|福岡県|.{1,3}[都道府県])/,
  /丁目|番地|\d-\d/, // address-style chome numbering
  /command|^fn$|^www|camer|あいう/i,
];

// Positive signal that a line is a business name.
const MERCHANT_NAME_HINT_RE =
  /店|本店|支店|酒場|居酒屋|食堂|珈琲|コーヒー|coffee|caf[eé]|cafe|\bbar\b|grill|lounge|\binn\b|hotel|tavern|kitchen|dining|株式会社|合同会社|有限会社|商店|屋$/i;

// Footer anchors — in a typical JP receipt the store name sits just above the
// phone / registration / postal block.
const MERCHANT_FOOTER_ANCHOR_RE = /電話|tel|fax|phone|☎|登録番号|〒/i;

function cleanMerchantLine(line: string): string {
  return line
    .replace(CARD_BRAND_RE, " ")
    .replace(/\s*様\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeMerchant(line: string): boolean {
  if (line.length < 2 || line.length > 60) return false;
  if (MERCHANT_NOISE_RE.some((re) => re.test(line))) return false;
  if (hasMoneySignal(line)) return false;
  if (parseTransactionDate(line)) return false;
  // punctuation / symbols / digits only
  if (/^[\d\s:.,/\-()%¥￥$€£円*★☆_、。・~＊]+$/.test(line)) return false;
  // must contain a letter, kana, or kanji of substance
  return /[A-Za-z぀-ヿ一-龯]/.test(line);
}

function parseMerchant(rawText: string): string | null {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const anchorIdx: number[] = [];
  lines.forEach((line, i) => {
    if (MERCHANT_FOOTER_ANCHOR_RE.test(line)) anchorIdx.push(i);
  });
  const distanceToAnchor = (i: number) =>
    anchorIdx.length ? Math.min(...anchorIdx.map((a) => Math.abs(a - i))) : 99;

  const candidates: { value: string; index: number }[] = [];
  lines.forEach((line, index) => {
    const cleaned = cleanMerchantLine(line);
    if (looksLikeMerchant(cleaned)) candidates.push({ value: cleaned, index });
  });
  if (candidates.length === 0) return null;

  // Score each candidate: a name hint dominates; otherwise proximity to the
  // footer block (store name usually printed just above phone/registration).
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    let score = 0;
    // A name hint dominates, but a bare 2-3 char suffix fragment (本店/支店)
    // should not outrank a full name.
    if (MERCHANT_NAME_HINT_RE.test(candidate.value)) score += candidate.value.length >= 4 ? 50 : 12;
    score += Math.max(0, 18 - distanceToAnchor(candidate.index) * 5);
    if (/[A-Za-z]/.test(candidate.value)) score += 4;
    if (/[一-龯]/.test(candidate.value)) score += 4;
    if (candidate.value.length <= 3) score -= 8;
    score -= candidate.index * 0.2; // mild tiebreak toward earlier lines
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best.value || null;
}

// ── Qualified-invoice (インボイス) registration number: literal T + 13 digits ──
function parseInvoiceRegistrationNumber(rawText: string): string | null {
  const match = rawText.match(/T\s?\d{13}/i);
  if (!match) return null;
  const { normalized, formatValid } = normalizeRegistrationNumber(
    match[0].replace(/\s/g, "").toUpperCase(),
  );
  return formatValid ? normalized : null;
}

// ── Consumption-tax amount + rate (内消費税 ¥xxx / 10% / 8%) ──────────────────
function parseTaxInfo(
  rawText: string,
  currency: string,
): { taxAmountMinor: number | null; taxRate: string | null } {
  const rateMatch = rawText.match(/\b(10|8)\s*%/);
  const taxRate = rateMatch ? `${rateMatch[1]}%` : null;

  // Capture the amount tied to a 消費税 token. Handles two layouts:
  //   inline  — "¥10,680- (内消費税等 ¥971-)"  -> 971 (not the gross total)
  //   wrapped — "(内消費税等" / "¥754)"        -> amount on the following line
  // Taxable-base lines (対象) are skipped.
  let taxAmountMinor: number | null = null;
  const taxKeyword = /(?:内)?消費税(?:等|額)?/;
  const inlineTax = /(?:内)?消費税(?:等|額)?[^0-9¥￥]*[¥￥]?\s*([\d,]+)/;
  const lines = rawText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/対象/.test(line) || !taxKeyword.test(line)) continue;

    let value: number | null = null;
    const inline = line.match(inlineTax);
    if (inline) {
      value = Number(inline[1].replace(/,/g, ""));
    } else {
      // amount printed on the next line (OCR wrap)
      const next = lines[i + 1] ?? "";
      if (!/対象/.test(next) && hasMoneySignal(next)) {
        const amounts = parseMoneyCandidates(next);
        if (amounts.length > 0) value = amounts[0];
      }
    }

    if (value != null && Number.isFinite(value) && value > 0) {
      taxAmountMinor = currency === "JPY" ? Math.round(value) : Math.round(value * 100);
      break;
    }
  }
  return { taxAmountMinor, taxRate };
}

export function parseReceiptOcrText(rawText: string): Omit<ExtractionResult, "rawText" | "provider"> {
  const currency = normalizeCurrency(rawText);
  const resolvedCurrency = ALLOWED_CURRENCIES.includes(currency) ? currency : "JPY";
  const { taxAmountMinor, taxRate } = parseTaxInfo(rawText, resolvedCurrency);

  return {
    transactionDate: parseTransactionDate(rawText),
    merchant: parseMerchant(rawText),
    amountMinor: parseAmountMinor(rawText, currency),
    currency: resolvedCurrency,
    // Expense type is intentionally NOT inferred from OCR: alcohol vs.
    // non-alcohol is a compliance judgment left to the reviewer (see test
    // "does not invent category or attendees from OCR text").
    expenseType: null,
    expenseCategoryCode: null,
    businessPurpose: null,
    attendeeNames: [],
    invoiceRegistrationNumber: parseInvoiceRegistrationNumber(rawText),
    taxAmountMinor,
    taxRate,
  };
}

class GoogleVisionOcrExtractionProvider implements ExtractionProvider {
  name = "google_vision_document_text_detection";

  async extract(imageBytes: Uint8Array, contentType: string): Promise<ExtractionResult> {
    const normalizedContentType = normalizeContentType(contentType);
    if (!SUPPORTED_IMAGE_TYPES.has(normalizedContentType)) {
      throw new Error(
        `Google Vision OCR supports receipt images, not ${contentType || "unknown content type"}.`,
      );
    }

    const apiKey = getGoogleCloudVisionApiKey();

    // Build the body, then drop our local references to the image bytes and
    // base64 string. The fetch+JSON.parse round-trip is hundreds of ms of
    // network wait — without this, the original Uint8Array (~3-5 MB), the
    // base64 string (~4-7 MB), and the JSON body (~4-7 MB) all stay pinned
    // through the entire round-trip and through `response.json()`, which is
    // exactly the heap pressure that trips Worker 1102 after a few requests.
    let bodyImage: string | null = bytesToBase64(imageBytes);
    const body = JSON.stringify({
      requests: [
        {
          image: { content: bodyImage },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          imageContext: { languageHints: ["ja", "en"] },
        },
      ],
    });
    bodyImage = null;
    // The caller's Uint8Array is still alive in the route handler, but our
    // local reference (and the base64 string above) are now free to collect.

    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
    );

    const payload = (await response.json().catch(() => ({}))) as GoogleVisionResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Google Vision OCR failed with HTTP ${response.status}.`);
    }

    const annotation = payload.responses?.[0];
    if (annotation?.error) {
      throw new Error(annotation.error.message ?? "Google Vision OCR failed.");
    }

    // DOCUMENT_TEXT_DETECTION populates fullTextAnnotation.text whenever it
    // returns anything at all — the per-word textAnnotations array is large
    // and never needed for our parse.
    const rawText = annotation?.fullTextAnnotation?.text ?? "";
    const parsed = parseReceiptOcrText(rawText);

    return {
      ...parsed,
      rawText,
      provider: this.name,
    };
  }
}

function getExtractionProvider(): ExtractionProvider {
  return new GoogleVisionOcrExtractionProvider();
}

export async function extractReceiptData(
  imageBytes: Uint8Array,
  contentType: string,
): Promise<ExtractionResult> {
  const provider = getExtractionProvider();
  return provider.extract(imageBytes, contentType);
}
