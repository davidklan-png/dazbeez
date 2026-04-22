import { inferDomainFromEmail, inferDomainFromUrl, normalizeEmail, normalizeLinkedInUrl, normalizePhone } from "@/lib/crm-normalization";
import type { DuplicateCandidate, ExtractedContactFields } from "@/lib/crm-types";

export interface DedupeComparableContact {
  id: number;
  companyId: number | null;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  linkedinUrl: string | null;
  website: string | null;
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return normalized || null;
}

function diceCoefficient(left: string | null, right: string | null): number {
  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  const pairs = (value: string) => {
    const result = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index += 1) {
      const pair = value.slice(index, index + 2);
      result.set(pair, (result.get(pair) ?? 0) + 1);
    }
    return result;
  };

  const leftPairs = pairs(left);
  const rightPairs = pairs(right);
  let overlap = 0;

  for (const [pair, count] of leftPairs) {
    overlap += Math.min(count, rightPairs.get(pair) ?? 0);
  }

  return (2 * overlap) / (Math.max(left.length - 1, 0) + Math.max(right.length - 1, 0));
}

export function buildDuplicateCandidates(
  extracted: ExtractedContactFields,
  existingContacts: DedupeComparableContact[],
): DuplicateCandidate[] {
  const extractedEmail = normalizeEmail(extracted.email);
  const extractedPhone = normalizePhone(extracted.phone);
  const extractedMobile = normalizePhone(extracted.mobile);
  const extractedLinkedIn = normalizeLinkedInUrl(extracted.linkedin_url);
  const extractedDomain = inferDomainFromUrl(extracted.website) ?? inferDomainFromEmail(extracted.email);
  const extractedName = normalizeText(extracted.full_name);
  const extractedCompany = normalizeText(extracted.company_name);

  return existingContacts
    .map((contact) => {
      const reasons: string[] = [];
      let score = 0;

      const contactEmail = normalizeEmail(contact.email);
      const contactPhone = normalizePhone(contact.phone);
      const contactMobile = normalizePhone(contact.mobile);
      const contactLinkedIn = normalizeLinkedInUrl(contact.linkedinUrl);
      const contactDomain = inferDomainFromUrl(contact.website) ?? inferDomainFromEmail(contact.email);
      const contactName = normalizeText(contact.name);
      const contactCompany = normalizeText(contact.company);

      if (extractedEmail && contactEmail && extractedEmail === contactEmail) {
        score = Math.max(score, 0.99);
        reasons.push("Exact email match");
      }

      if (
        (extractedPhone && contactPhone && extractedPhone === contactPhone) ||
        (extractedMobile && contactMobile && extractedMobile === contactMobile)
      ) {
        score = Math.max(score, 0.93);
        reasons.push("Exact phone match");
      }

      if (extractedLinkedIn && contactLinkedIn && extractedLinkedIn === contactLinkedIn) {
        score = Math.max(score, 0.96);
        reasons.push("Exact LinkedIn URL match");
      }

      const nameScore = diceCoefficient(extractedName, contactName);
      const companyScore = diceCoefficient(extractedCompany, contactCompany);
      if (nameScore >= 0.9 && companyScore >= 0.85) {
        score = Math.max(score, 0.87);
        reasons.push("Strong name + company match");
      } else if (nameScore >= 0.9) {
        score = Math.max(score, 0.73);
        reasons.push("Strong name match");
      }

      if (extractedDomain && contactDomain && extractedDomain === contactDomain) {
        score = Math.max(score, 0.72);
        reasons.push("Matching company domain");
      }

      if (reasons.length === 0 || score < 0.55) {
        return null;
      }

      return {
        contactId: contact.id,
        companyId: contact.companyId,
        confidence: Number(score.toFixed(2)),
        reasons,
      } satisfies DuplicateCandidate;
    })
    .filter((candidate): candidate is DuplicateCandidate => Boolean(candidate))
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 5);
}
