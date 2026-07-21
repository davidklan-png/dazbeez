import {
  missingPreservationFields,
  preservationFieldPopulated,
  PRESERVATION_FIELDS,
  type DuplicateMemberInput,
  type PreservationField,
} from "@/lib/receipts/duplicate-resolution-policy";

export interface ResolutionSourceOption {
  receiptId: string;
  value: unknown;
  displayValue: string;
}

export interface ResolutionNeed {
  field: PreservationField;
  kind: "missing" | "conflict";
  required: boolean;
  retainedValue: string;
  sources: ResolutionSourceOption[];
}

export const FIELD_LABELS: Record<PreservationField, string> = {
  transaction_date: "Transaction date",
  merchant: "Merchant",
  amount: "Amount and currency",
  category: "Expense category",
  business_purpose: "Business purpose",
  alcohol_present: "Alcohol present",
  tax_amount: "Consumption tax amount",
  tax_rate: "Tax rate",
  invoice_number: "Invoice registration number",
  counterparty: "Counterparty",
  attendees: "Attendees",
};

export function preservationValue(member: DuplicateMemberInput, field: PreservationField): unknown {
  switch (field) {
    case "transaction_date": return member.transaction_date;
    case "merchant": return member.merchant;
    case "amount": return member.amount_minor == null ? null : { amountMinor: member.amount_minor, currency: member.currency };
    case "category": return member.expense_category_code;
    case "business_purpose": return member.business_purpose;
    case "alcohol_present": return member.alcoholPresent ? true : null;
    case "tax_amount": return member.tax_amount_minor;
    case "tax_rate": return member.tax_rate;
    case "invoice_number": return member.invoice_registration_number;
    case "counterparty": return member.counterparty_name;
    case "attendees": return member.attendeeNames.length ? member.attendeeNames : null;
  }
}

export function displayPreservationValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    const amount = value as { amountMinor?: unknown; currency?: unknown };
    return `${String(amount.currency ?? "")} ${String(amount.amountMinor ?? "")}`.trim();
  }
  return String(value);
}

function comparisonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((v) => String(v).normalize("NFKC").toLocaleLowerCase().trim()).sort());
  }
  return JSON.stringify(value);
}

/** One aggregated row per accounting field, even if several purge targets have
 * it. Missing target-only data is required; populated disagreement is offered
 * as an optional explicit conflict resolution. */
export function buildResolutionNeeds(
  members: DuplicateMemberInput[],
  retainedId: string,
  targetIds: string[],
): ResolutionNeed[] {
  const retained = members.find((member) => member.id === retainedId);
  if (!retained) return [];
  const targets = targetIds
    .map((id) => members.find((member) => member.id === id))
    .filter((member): member is DuplicateMemberInput => Boolean(member));
  const required = new Set(targets.flatMap((target) => missingPreservationFields(target, retained)));
  const needs: ResolutionNeed[] = [];
  for (const field of PRESERVATION_FIELDS) {
    const sources = targets
      .filter((target) => preservationFieldPopulated(field, target))
      .map((target) => {
        const value = preservationValue(target, field);
        return { receiptId: target.id, value, displayValue: displayPreservationValue(value) };
      });
    const populatedValues = [retained, ...targets]
      .filter((member) => preservationFieldPopulated(field, member))
      .map((member) => comparisonValue(preservationValue(member, field)));
    const conflict = populatedValues.length > 1 && new Set(populatedValues).size > 1;
    if (!required.has(field) && !conflict) continue;
    needs.push({
      field,
      kind: required.has(field) ? "missing" : "conflict",
      required: required.has(field),
      retainedValue: displayPreservationValue(preservationValue(retained, field)),
      sources,
    });
  }
  return needs;
}
