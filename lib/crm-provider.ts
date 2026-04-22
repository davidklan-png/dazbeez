import { getAiBinding } from "@/lib/cloudflare-runtime";
import { extractJsonBlock } from "@/lib/crm-json";
import type {
  CardDetectionCandidate,
  EnrichmentFactInput,
  ExtractedCardPayload,
} from "@/lib/crm-types";

const DEFAULT_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const DEFAULT_TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function assertAiBinding(): Ai {
  const ai = getAiBinding();
  if (!ai) {
    throw new Error("Cloudflare AI binding is not configured.");
  }

  return ai;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeDetectionCandidates(value: unknown): CardDetectionCandidate[] {
  if (!value || typeof value !== "object" || !("cards" in value)) {
    return [];
  }

  const cards = Array.isArray((value as { cards?: unknown[] }).cards)
    ? ((value as { cards?: unknown[] }).cards ?? [])
    : [];

  const normalized = cards
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const card = entry as Record<string, unknown>;
      const polygon = card.polygon as Record<string, Record<string, number>> | undefined;
      if (!polygon) {
        return null;
      }

      const points = {
        topLeft: polygon.topLeft,
        topRight: polygon.topRight,
        bottomRight: polygon.bottomRight,
        bottomLeft: polygon.bottomLeft,
      };
      if (!points.topLeft || !points.topRight || !points.bottomRight || !points.bottomLeft) {
        return null;
      }

      const candidate: CardDetectionCandidate = {
        label: typeof card.label === "string" ? card.label : `card_${index + 1}`,
        confidence:
          typeof card.confidence === "number" ? Math.max(0, Math.min(1, card.confidence)) : 0.6,
        polygon: {
          topLeft: {
            x: clamp01(Number(points.topLeft.x ?? 0)),
            y: clamp01(Number(points.topLeft.y ?? 0)),
          },
          topRight: {
            x: clamp01(Number(points.topRight.x ?? 0)),
            y: clamp01(Number(points.topRight.y ?? 0)),
          },
          bottomRight: {
            x: clamp01(Number(points.bottomRight.x ?? 0)),
            y: clamp01(Number(points.bottomRight.y ?? 0)),
          },
          bottomLeft: {
            x: clamp01(Number(points.bottomLeft.x ?? 0)),
            y: clamp01(Number(points.bottomLeft.y ?? 0)),
          },
        },
        rotationDegrees:
          typeof card.rotationDegrees === "number" ? Number(card.rotationDegrees) : undefined,
      };

      return candidate;
    })
    .filter((entry): entry is CardDetectionCandidate => Boolean(entry))
    .sort((left, right) => {
      const leftMinY = Math.min(left.polygon.topLeft.y, left.polygon.topRight.y);
      const rightMinY = Math.min(right.polygon.topLeft.y, right.polygon.topRight.y);
      if (Math.abs(leftMinY - rightMinY) > 0.04) {
        return leftMinY - rightMinY;
      }

      const leftMinX = Math.min(left.polygon.topLeft.x, left.polygon.bottomLeft.x);
      const rightMinX = Math.min(right.polygon.topLeft.x, right.polygon.bottomLeft.x);
      return leftMinX - rightMinX;
    });

  return normalized;
}

export async function detectBusinessCardsFromImage(args: {
  imageDataUrl: string;
  expectedCount?: number;
}): Promise<CardDetectionCandidate[]> {
  const ai = assertAiBinding();
  const response = await ai.run(DEFAULT_VISION_MODEL, {
    prompt: [
      "You detect paper business cards in a single composite photo.",
      "Return only JSON with this shape:",
      '{"cards":[{"label":"card_1","confidence":0.95,"rotationDegrees":-2,"polygon":{"topLeft":{"x":0.1,"y":0.1},"topRight":{"x":0.4,"y":0.1},"bottomRight":{"x":0.4,"y":0.3},"bottomLeft":{"x":0.1,"y":0.3}}}]}',
      "Rules:",
      "- coordinates must be normalized from 0 to 1",
      "- include every clearly visible rectangular business card",
      "- polygons should follow the card corners clockwise",
      "- do not invent cards that are not visible",
      `- expected count is about ${args.expectedCount ?? 9}`,
    ].join("\n"),
    image: args.imageDataUrl,
    max_tokens: 1400,
    temperature: 0.1,
  });

  const rawText =
    typeof response === "object" && response && "response" in response
      ? String(response.response ?? "")
      : "";

  return normalizeDetectionCandidates(extractJsonBlock(rawText, { cards: [] }));
}

function createExtractionFallback(): ExtractedCardPayload {
  return {
    fields: {
      full_name: null,
      first_name: null,
      last_name: null,
      full_name_native: null,
      job_title: null,
      department: null,
      company_name: null,
      company_name_native: null,
      email: null,
      phone: null,
      mobile: null,
      website: null,
      linkedin_url: null,
      address: null,
      postal_code: null,
      city: null,
      state_prefecture: null,
      country: null,
      notes_from_card: null,
      raw_ocr_text: "",
      pronouns: null,
      furigana: null,
      emails: [],
      phone_numbers: [],
    },
    confidence: {},
    languageHint: null,
  };
}

export async function extractBusinessCardDetails(args: {
  imageDataUrl: string;
  eventContext?: string | null;
}): Promise<ExtractedCardPayload> {
  const ai = assertAiBinding();
  const response = await ai.run(DEFAULT_VISION_MODEL, {
    prompt: [
      "You are extracting a bilingual business card into structured JSON.",
      "Return only JSON with keys fields, confidence, languageHint.",
      "fields must include:",
      "full_name, first_name, last_name, full_name_native, job_title, department, company_name, company_name_native, email, phone, mobile, website, linkedin_url, address, postal_code, city, state_prefecture, country, notes_from_card, raw_ocr_text, pronouns, furigana, emails, phone_numbers",
      "confidence must be an object keyed by field name with 0-1 values.",
      "Preserve Japanese text when present. Prefer null over guessing.",
      `Event context: ${args.eventContext ?? "none"}`,
    ].join("\n"),
    image: args.imageDataUrl,
    max_tokens: 2200,
    temperature: 0.1,
  });

  const rawText =
    typeof response === "object" && response && "response" in response
      ? String(response.response ?? "")
      : "";

  return extractJsonBlock(rawText, createExtractionFallback());
}

export async function extractEnrichmentFactsFromWebsite(args: {
  url: string;
  pageTitle: string;
  pageText: string;
  companyName?: string | null;
  contactName?: string | null;
}): Promise<EnrichmentFactInput[]> {
  const ai = assertAiBinding();
  const response = await ai.run(DEFAULT_TEXT_MODEL, {
    prompt: [
      "You convert public company website text into compliant enrichment facts.",
      "Return only JSON as an array of objects with keys:",
      'factType, label, value, normalizedValue, sourceUrl, sourceTitle, sourceSnippet, evidenceStrength, retrievedAt',
      "Rules:",
      "- use only facts directly supported by the supplied page text",
      "- no speculation or inferred funding/headcount",
      "- evidenceStrength must be low, medium, or high",
      `Source URL: ${args.url}`,
      `Page title: ${args.pageTitle}`,
      `Company: ${args.companyName ?? "unknown"}`,
      `Person: ${args.contactName ?? "unknown"}`,
      "Page text:",
      args.pageText.slice(0, 9000),
    ].join("\n"),
    max_tokens: 1800,
    temperature: 0.1,
  });

  const rawText =
    typeof response === "string"
      ? response
      : typeof response === "object" && response && "response" in response
        ? String(response.response ?? "")
        : "";

  const pageTextLower = args.pageText.toLowerCase();

  return extractJsonBlock<EnrichmentFactInput[]>(rawText, [])
    .filter((fact) => {
      const value = fact.value?.trim() ?? "";
      if (!value || value.length <= 6) {
        return true;
      }

      return pageTextLower.includes(value.toLowerCase());
    })
    .map((fact) => ({
      ...fact,
      sourceUrl: fact.sourceUrl || args.url,
      sourceTitle: fact.sourceTitle || args.pageTitle,
      retrievedAt: fact.retrievedAt || new Date().toISOString(),
      evidenceStrength: fact.evidenceStrength || "medium",
    }));
}
