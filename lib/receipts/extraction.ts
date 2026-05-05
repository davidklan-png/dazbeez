import { getAiBinding } from "@/lib/cloudflare-runtime";
import { isCanonicalCode, mapLegacyCategory } from "@/lib/receipts/categories";
import type { ExtractionResult, ExpenseType } from "@/lib/receipts/types";

// ─── Provider interface ───────────────────────────────────────────────────────

interface ExtractionProvider {
  name: string;
  extract(imageBytes: Uint8Array, contentType: string): Promise<ExtractionResult>;
}

// ─── JSON extraction helper ───────────────────────────────────────────────────

function extractJsonBlock(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseAmountToMinor(raw: unknown, currency: string): number | null {
  if (raw === null || raw === undefined) return null;
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  if (isNaN(n)) return null;
  return currency === "JPY" ? Math.round(n) : Math.round(n * 100);
}

const KNOWN_EXPENSE_TYPES = new Set<ExpenseType>([
  "meeting-no-alcohol",
  "entertainment-alcohol",
  "transportation",
  "books",
  "research",
  "insurance",
  "misc",
]);

function normalizeExpenseType(raw: unknown): ExpenseType | null {
  if (typeof raw !== "string") return null;
  const lower = raw.toLowerCase().replace(/\s+/g, "-");
  if (KNOWN_EXPENSE_TYPES.has(lower as ExpenseType)) return lower as ExpenseType;
  if (lower.includes("transport") || lower.includes("taxi") || lower.includes("train")) return "transportation";
  if (lower.includes("meal") || lower.includes("restaurant") || lower.includes("dining")) return "entertainment-alcohol";
  if (lower.includes("book")) return "books";
  return "misc";
}

function normalizeExpenseCategoryCode(
  rawCategory: unknown,
  expenseType: ExpenseType | null,
): string | null {
  if (typeof rawCategory === "string") {
    if (isCanonicalCode(rawCategory)) return rawCategory;
    return mapLegacyCategory(rawCategory).code;
  }

  if (!expenseType) return null;
  return mapLegacyCategory(expenseType).code;
}

// ─── Cloudflare AI provider ───────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a receipt data extractor. Analyze the receipt image and extract structured data.

Return ONLY valid JSON with this exact shape:
{
  "transaction_date": "YYYY-MM-DD or null",
  "merchant": "string or null",
  "amount": "number as string (e.g. '1500') or null",
  "currency": "JPY or USD or EUR or null",
  "expense_type": "transportation|books|research|insurance|misc|meeting-no-alcohol|entertainment-alcohol or null",
  "business_purpose": "string or null",
  "attendees": ["name1", "name2"],
  "raw_text": "full text visible on the receipt"
}

Rules:
- Set null for any field you cannot determine from the image.
- amount must be the total charge (not subtotal, not tax separately).
- For JPY, return whole yen (no decimal).
- attendees should only be extracted if names are visible on the receipt.
- Do not guess. Only return data you can read from the image.`;

class CloudflareAiExtractionProvider implements ExtractionProvider {
  name = "cloudflare_ai";

  async extract(imageBytes: Uint8Array, _contentType: string): Promise<ExtractionResult> {
    const ai = getAiBinding();
    if (!ai) throw new Error("Cloudflare AI binding is not available.");

    const response = await (ai as unknown as Record<string, Function>)["run"](
      "@cf/meta/llama-3.2-11b-vision-instruct",
      {
        prompt: EXTRACTION_PROMPT,
        image: Array.from(imageBytes),
        max_tokens: 800,
        temperature: 0.1,
      },
    ) as { response?: string } | string;

    const rawText =
      typeof response === "string"
        ? response
        : (response as { response?: string }).response ?? "";

    const parsed = extractJsonBlock(rawText);
    const currency = (parsed.currency as string | null) ?? "JPY";
    const expenseType = normalizeExpenseType(parsed.expense_type);

    return {
      transactionDate:
        typeof parsed.transaction_date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(parsed.transaction_date)
          ? parsed.transaction_date
          : null,
      merchant: typeof parsed.merchant === "string" ? parsed.merchant : null,
      amountMinor: parseAmountToMinor(parsed.amount, currency),
      currency,
      expenseType,
      expenseCategoryCode: normalizeExpenseCategoryCode(
        parsed.expense_category_code,
        expenseType,
      ),
      businessPurpose:
        typeof parsed.business_purpose === "string"
          ? parsed.business_purpose
          : null,
      attendeeNames: Array.isArray(parsed.attendees)
        ? (parsed.attendees as unknown[])
            .filter((a): a is string => typeof a === "string")
        : [],
      rawText: typeof parsed.raw_text === "string" ? parsed.raw_text : rawText,
      provider: this.name,
    };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

function getExtractionProvider(): ExtractionProvider {
  return new CloudflareAiExtractionProvider();
}

export async function extractReceiptData(
  imageBytes: Uint8Array,
  contentType: string,
): Promise<ExtractionResult> {
  const provider = getExtractionProvider();
  return provider.extract(imageBytes, contentType);
}
