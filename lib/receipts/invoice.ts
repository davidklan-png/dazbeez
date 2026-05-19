// 適格請求書発行事業者の登録番号 (Qualified Invoice Issuer Registration Number)
//
// Format: literal "T" + 13 digits. National Tax Agency (NTA) issues these
// numbers. Real-time lookup against NTA is intentionally NOT performed here
// (network round-trip from the upload path is undesirable and the public
// API has rate limits); format validation is treated as sufficient for the
// preservation layer. A future worker can periodically batch-confirm.

import type {
  InvoiceRegistrationStatus,
  QualifiedInvoiceStatus,
} from "@/lib/receipts/types";

const REGISTRATION_NUMBER_PATTERN = /^T\d{13}$/;

export interface NormalizedRegistrationNumber {
  normalized: string;
  formatValid: boolean;
}

/** Strip whitespace, hyphens, and normalize Japanese fullwidth digits. */
export function normalizeRegistrationNumber(
  raw: string | null | undefined,
): NormalizedRegistrationNumber {
  if (!raw) return { normalized: "", formatValid: false };
  // NFKC handles fullwidth → halfwidth digit/Latin conversion.
  const normalized = raw
    .normalize("NFKC")
    .replace(/[\s\-‐‒–—―ー−]/g, "")
    .toUpperCase();
  return {
    normalized,
    formatValid: REGISTRATION_NUMBER_PATTERN.test(normalized),
  };
}

export function isValidRegistrationNumberFormat(
  raw: string | null | undefined,
): boolean {
  return normalizeRegistrationNumber(raw).formatValid;
}

export interface InvoiceValidationResult {
  registrationStatus: InvoiceRegistrationStatus;
  qualifiedInvoiceStatus: QualifiedInvoiceStatus;
  normalizedNumber: string | null;
  message: string | null;
}

/**
 * Validate a registration number purely on format. Returns the persisted
 * statuses to write back to receipt_records. Network lookup against the
 * NTA registry is left as a future hook — see file header.
 */
export function validateInvoiceRegistrationNumber(
  raw: string | null | undefined,
  opts?: { counterpartyKnownUnregistered?: boolean },
): InvoiceValidationResult {
  if (!raw || raw.trim() === "") {
    return {
      registrationStatus: "unchecked",
      qualifiedInvoiceStatus: opts?.counterpartyKnownUnregistered
        ? "unregistered_counterparty"
        : "missing_registration_number",
      normalizedNumber: null,
      message: null,
    };
  }

  const { normalized, formatValid } = normalizeRegistrationNumber(raw);
  if (!formatValid) {
    return {
      registrationStatus: "format_invalid",
      qualifiedInvoiceStatus: "invalid",
      normalizedNumber: normalized || null,
      message:
        'Registration number must match "T" followed by 13 digits (e.g. T1234567890123).',
    };
  }

  return {
    registrationStatus: "format_valid",
    qualifiedInvoiceStatus: "valid",
    normalizedNumber: normalized,
    message: null,
  };
}
