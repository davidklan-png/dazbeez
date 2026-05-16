import { getGoogleCloudVisionApiKey } from "@/lib/cloudflare-runtime";
import { ALLOWED_CURRENCIES } from "@/lib/receipts/validation";
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
    textAnnotations?: Array<{ description?: string }>;
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

function parseMerchant(rawText: string): string | null {
  const noise = [
    "領収書",
    "レシート",
    "receipt",
    "tax invoice",
    "登録番号",
    "電話",
    "tel",
    "〒",
  ];

  for (const line of rawText.split(/\r?\n/)) {
    const value = line.trim();
    if (value.length < 2 || value.length > 80) continue;

    const lower = value.toLowerCase();
    if (noise.some((keyword) => lower.includes(keyword.toLowerCase()))) continue;
    if (hasMoneySignal(value)) continue;
    if (parseTransactionDate(value)) continue;
    if (/^\d[\d\s:./-]*$/.test(value)) continue;

    return value;
  }

  return null;
}

export function parseReceiptOcrText(rawText: string): Omit<ExtractionResult, "rawText" | "provider"> {
  const currency = normalizeCurrency(rawText);

  return {
    transactionDate: parseTransactionDate(rawText),
    merchant: parseMerchant(rawText),
    amountMinor: parseAmountMinor(rawText, currency),
    currency: ALLOWED_CURRENCIES.includes(currency) ? currency : "JPY",
    expenseType: null,
    expenseCategoryCode: null,
    businessPurpose: null,
    attendeeNames: [],
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
    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              image: { content: bytesToBase64(imageBytes) },
              features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
              imageContext: { languageHints: ["ja", "en"] },
            },
          ],
        }),
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

    const rawText =
      annotation?.fullTextAnnotation?.text ??
      annotation?.textAnnotations?.[0]?.description ??
      "";
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
