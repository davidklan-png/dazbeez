import { extractEnrichmentFactsFromWebsite } from "@/lib/crm-provider";
import { normalizeUrl } from "@/lib/crm-normalization";
import type { EnrichmentFactInput } from "@/lib/crm-types";

const MAX_RAW_HTML_BYTES = 64 * 1024;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWebsiteDocument(url: string): Promise<{
  url: string;
  title: string;
  text: string;
} | null> {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "https:") {
      return null;
    }

    // TODO: respect robots.txt before indexing company pages.
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Dazbeez CRM Enrichment Bot",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("text/")) {
      return null;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return null;
    }

    const decoder = new TextDecoder();
    let bytesRead = 0;
    let html = "";

    while (bytesRead < MAX_RAW_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }

      const remainingBytes = MAX_RAW_HTML_BYTES - bytesRead;
      const chunk = value.byteLength > remainingBytes ? value.subarray(0, remainingBytes) : value;
      bytesRead += chunk.byteLength;
      html += decoder.decode(chunk, { stream: true });

      if (value.byteLength > remainingBytes) {
        await reader.cancel();
        break;
      }
    }

    html += decoder.decode();
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    return {
      url: response.url,
      title: titleMatch?.[1]?.trim() || response.url,
      text: stripHtml(html).slice(0, 12000),
    };
  } catch {
    return null;
  }
}

export async function enrichFromOfficialWebsite(args: {
  website: string | null;
  companyName?: string | null;
  contactName?: string | null;
  roleSummary?: string | null;
}): Promise<EnrichmentFactInput[]> {
  const normalizedWebsite = normalizeUrl(args.website);
  if (!normalizedWebsite) {
    return [];
  }

  const homepage = await fetchWebsiteDocument(normalizedWebsite);
  if (!homepage || !homepage.text) {
    return [];
  }

  const facts = await extractEnrichmentFactsFromWebsite({
    url: homepage.url,
    pageTitle: homepage.title,
    pageText: homepage.text,
    companyName: args.companyName,
    contactName: args.contactName,
  });

  if (args.roleSummary?.trim()) {
    facts.push({
      factType: "role_summary",
      label: "Observed role summary",
      value: args.roleSummary.trim(),
      normalizedValue: args.roleSummary.trim().toLowerCase(),
      sourceUrl: homepage.url,
      sourceTitle: homepage.title,
      sourceSnippet: args.roleSummary.trim(),
      evidenceStrength: "medium",
      retrievedAt: new Date().toISOString(),
    });
  }

  return facts;
}
