import type { ExtractedContactFields } from "@/lib/crm-types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

export function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized && EMAIL_RE.test(normalized) ? normalized : null;
}

export function normalizeUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    if (!url.hostname) {
      return null;
    }

    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function normalizeLinkedInUrl(value: string | null | undefined): string | null {
  const normalized = normalizeUrl(value);
  if (!normalized) {
    return null;
  }

  try {
    const url = new URL(normalized);
    const host = url.hostname.replace(/^www\./, "");
    if (!host.includes("linkedin.com")) {
      return null;
    }

    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function normalizePhone(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const leadingPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 7) {
    return null;
  }

  return `${leadingPlus ? "+" : ""}${digits}`;
}

export function inferDomainFromUrl(value: string | null | undefined): string | null {
  const normalized = normalizeUrl(value);
  if (!normalized) {
    return null;
  }

  try {
    const url = new URL(normalized);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function inferDomainFromEmail(value: string | null | undefined): string | null {
  const normalized = normalizeEmail(value);
  if (!normalized) {
    return null;
  }

  return normalized.split("@")[1] ?? null;
}

export function splitFullName(fullName: string | null | undefined): {
  firstName: string | null;
  lastName: string | null;
} {
  if (!fullName) {
    return { firstName: null, lastName: null };
  }

  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { firstName: null, lastName: null };
  }

  if (parts.length === 1) {
    return { firstName: parts[0], lastName: null };
  }

  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.at(-1) ?? null,
  };
}

export function normalizeExtractedFields(fields: ExtractedContactFields): ExtractedContactFields {
  const nameParts = splitFullName(fields.full_name);
  const website = normalizeUrl(fields.website);
  const linkedin = normalizeLinkedInUrl(fields.linkedin_url);
  const email = normalizeEmail(fields.email);
  const mobile = normalizePhone(fields.mobile);
  const phone = normalizePhone(fields.phone);

  return {
    ...fields,
    full_name: fields.full_name?.trim() || null,
    first_name: fields.first_name?.trim() || nameParts.firstName,
    last_name: fields.last_name?.trim() || nameParts.lastName,
    full_name_native: fields.full_name_native?.trim() || null,
    job_title: fields.job_title?.trim() || null,
    department: fields.department?.trim() || null,
    company_name: fields.company_name?.trim() || null,
    company_name_native: fields.company_name_native?.trim() || null,
    email,
    phone,
    mobile,
    website,
    linkedin_url: linkedin,
    address: fields.address?.trim() || null,
    postal_code: fields.postal_code?.trim() || null,
    city: fields.city?.trim() || null,
    state_prefecture: fields.state_prefecture?.trim() || null,
    country: fields.country?.trim() || null,
    notes_from_card: fields.notes_from_card?.trim() || null,
    raw_ocr_text: fields.raw_ocr_text?.trim() || "",
    pronouns: fields.pronouns?.trim() || null,
    furigana: fields.furigana?.trim() || null,
    emails: (fields.emails ?? [])
      .map((entry) => normalizeEmail(entry))
      .filter((entry): entry is string => Boolean(entry)),
    phone_numbers: (fields.phone_numbers ?? [])
      .map((entry) => normalizePhone(entry))
      .filter((entry): entry is string => Boolean(entry)),
  };
}
