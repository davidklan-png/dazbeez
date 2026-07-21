// Duplicate-resolution retention policy — pure + client-safe.
//
// Given the members of a possible-duplicate cluster, recommend which receipt to
// RETAIN (and which are purge candidates) using ONLY meaningful accounting
// signal. The same module drives the comparison modal's preselect (client) and
// is re-run server-side as a non-authoritative hint (the server re-validates
// everything from D1 — never trust client scores).
//
// Scoring counts accounting parameters only. Timestamps, UUIDs, internal queue
// fields, and empty/default values do NOT count as completeness. A default
// qualified_invoice_status of "not_checked" is not "complete"; the meaningful
// artifact is the invoice registration number.
//
// Audit 2026-07-21 duplicate-resolution workflow (architect-approved spec A).

import type {
  ExtractionState,
  QualifiedInvoiceStatus,
  ReceiptStatus,
} from "@/lib/receipts/types";

export type ProtectionTier = "protected" | "registered" | "unregistered";

/** Meaningful-accounting + registration input for one cluster member. The caller
 *  supplies the registration/protection signals and file presence (server:
 *  authoritative from D1; client: best-known for preselect). */
export interface DuplicateMemberInput {
  id: string;
  captured_at: string;
  updated_at: string;
  status: ReceiptStatus;
  /** status 'exported' OR present in receipt_export_items. */
  exported: boolean;
  archived: boolean;
  /** referenced by a matched/confirmed AMEX line (any month). */
  claimedByConfirmedAmexLine: boolean;
  /** linked via business_trip_report_receipts. */
  businessTripLinked: boolean;
  /** promoted from an email_receipt_intake row. */
  emailIntakePromoted: boolean;
  // ── accounting fields ──
  transaction_date: string | null;
  merchant: string | null;
  amount_minor: number | null;
  currency: string;
  expense_category_code: string | null;
  business_purpose: string | null;
  tax_amount_minor: number | null;
  tax_rate: string | null;
  invoice_registration_number: string | null;
  qualified_invoice_status: QualifiedInvoiceStatus | null;
  counterparty_name: string | null;
  attendeesRequired: boolean;
  attendeesCount: number;
  extractionState: ExtractionState | null;
  hasOriginalFile: boolean;
  hasProofFile: boolean;
}

/** The accounting completeness parameters (rule A.2). Order is stable for
 *  display; none of these are timestamps/UUIDs/internal-queue fields. */
export const SCORE_FIELDS = [
  "transaction_date",
  "merchant",
  "amount",
  "category",
  "business_purpose",
  "tax",
  "invoice_number",
  "counterparty",
  "attendees",
  "extraction",
  "files",
] as const;
export type ScoreField = (typeof SCORE_FIELDS)[number];

export interface CompletenessResult {
  score: number;
  completed: ScoreField[];
  missing: ScoreField[];
}

/** A field is "completed" only when its meaningful accounting value is present
 *  (never an empty/default/queue value). Pure. */
export function fieldCompleted(
  field: ScoreField,
  m: DuplicateMemberInput,
): boolean {
  switch (field) {
    case "transaction_date":
      return !!m.transaction_date;
    case "merchant":
      return !!m.merchant && m.merchant.trim().length > 0;
    case "amount":
      return m.amount_minor != null;
    case "category":
      return !!m.expense_category_code;
    case "business_purpose":
      return !!m.business_purpose && m.business_purpose.trim().length > 0;
    case "tax":
      return m.tax_amount_minor != null || (!!m.tax_rate && m.tax_rate.trim().length > 0);
    case "invoice_number":
      // The registration NUMBER is the accounting artifact. A status alone
      // (e.g. "not_checked"/"unregistered_counterparty") without a number is not
      // "complete" data.
      return !!m.invoice_registration_number && m.invoice_registration_number.trim().length > 0;
    case "counterparty":
      return !!m.counterparty_name && m.counterparty_name.trim().length > 0;
    case "attendees":
      // Not required by the category → trivially satisfied (no gap). Required →
      // satisfied only when attendees are present.
      return !m.attendeesRequired || m.attendeesCount > 0;
    case "extraction":
      // "processed" = structured extraction landed. queued/processing/failed
      // have no usable structured data.
      return m.extractionState === "processed";
    case "files":
      // Original is the accounting record; a proof copy alone is not.
      return m.hasOriginalFile;
  }
}

export function completeness(m: DuplicateMemberInput): CompletenessResult {
  const completed: ScoreField[] = [];
  const missing: ScoreField[] = [];
  for (const f of SCORE_FIELDS) {
    (fieldCompleted(f, m) ? completed : missing).push(f);
  }
  return { score: completed.length, completed, missing };
}

/**
 * Protection/registration tier (rule A.1). A PROTECTED receipt can never be
 * purged; REGISTERED (business-trip / email-intake linkage) is purgeable only
 * with provenance transfer to the retained receipt; UNREGISTERED is freely
 * purgeable. A reconciled receipt is protected (it carries a confirmed AMEX
 * claim; defense-in-depth alongside claimedByConfirmedAmexLine).
 */
export function protectionTier(m: DuplicateMemberInput): {
  tier: ProtectionTier;
  rank: number;
} {
  const protected_ =
    m.exported || m.archived || m.claimedByConfirmedAmexLine || m.status === "reconciled";
  if (protected_) return { tier: "protected", rank: 3 };
  if (m.businessTripLinked || m.emailIntakePromoted) return { tier: "registered", rank: 2 };
  return { tier: "unregistered", rank: 1 };
}

export function canPurge(m: DuplicateMemberInput): boolean {
  return protectionTier(m).tier !== "protected";
}

export interface MemberAssessment {
  id: string;
  tier: ProtectionTier;
  tierRank: number;
  completeness: CompletenessResult;
  canPurge: boolean;
  isRetained: boolean;
}

export interface FieldConflict {
  field: ScoreField | "currency";
  values: Array<{ id: string; value: string | number | null }>;
}

/** A populated accounting field on a purge target that is MISSING on the retained
 *  receipt — must be copied/resolved before purge (rule A.6). */
export interface RequiredTransfer {
  fromId: string;
  fields: ScoreField[];
}

export interface RetentionRecommendation {
  members: DuplicateMemberInput[];
  retainedId: string;
  assessments: Map<string, MemberAssessment>;
  /** Why the retained receipt was chosen (display labels). */
  retainedReasons: string[];
  /** Populated accounting fields where members disagree (rule A.7). */
  conflicts: FieldConflict[];
  /** Rule A.6: populated-on-target / missing-on-retained fields. When non-empty
   *  the purge is BLOCKED until these are copied to the retained receipt. */
  requiredTransfers: RequiredTransfer[];
  blocked: boolean;
  blockReasons: string[];
}

/** Singular value for a field (for conflict detection), or null if unpopulated. */
function populatedValue(
  field: ScoreField | "currency",
  m: DuplicateMemberInput,
): string | number | null {
  switch (field) {
    case "transaction_date":
      return m.transaction_date ?? null;
    case "merchant":
      return m.merchant && m.merchant.trim() ? m.merchant.trim() : null;
    case "amount":
      return m.amount_minor;
    case "currency":
      return m.currency || null;
    case "category":
      return m.expense_category_code ?? null;
    case "tax":
      return m.tax_amount_minor != null ? m.tax_amount_minor : m.tax_rate && m.tax_rate.trim() ? m.tax_rate.trim() : null;
    case "invoice_number":
      return m.invoice_registration_number && m.invoice_registration_number.trim()
        ? m.invoice_registration_number.trim()
        : null;
    case "counterparty":
      return m.counterparty_name && m.counterparty_name.trim() ? m.counterparty_name.trim() : null;
    default:
      // attendees/extraction/files are boolean-ish completeness flags, not
      // conflict-display values.
      return null;
  }
}

const CONFLICT_FIELDS: Array<ScoreField | "currency"> = [
  "transaction_date",
  "merchant",
  "amount",
  "currency",
  "category",
  "tax",
  "invoice_number",
  "counterparty",
];

/**
 * Recommend a single retained receipt for a duplicate cluster (2+ members).
 * Precedence (rules A.1–A.3):
 *   1. higher protection/registration tier (protected > registered > unregistered);
 *   2. higher accounting completeness;
 *   3. earliest capture (tie-break = original record).
 * Then compute conflicts (A.7) and required field transfers (A.6 block).
 *
 * The recommendation is advisory — image legibility is the operator's call.
 * If two or more PROTECTED receipts are present, none can be purged; the
 * retained pick is still named but `blocked` reflects that purge is impossible
 * for the protected targets (the operator must keep both / resolve manually).
 */
export function recommendRetention(
  members: DuplicateMemberInput[],
): RetentionRecommendation {
  if (members.length < 2) {
    throw new Error("recommendRetention requires at least 2 cluster members.");
  }

  const assessments = new Map<string, MemberAssessment>();
  for (const m of members) {
    const comp = completeness(m);
    const { tier, rank } = protectionTier(m);
    assessments.set(m.id, {
      id: m.id,
      tier,
      tierRank: rank,
      completeness: comp,
      canPurge: canPurge(m),
      isRetained: false,
    });
  }

  // Sort: tier desc → completeness desc → earliest capture asc.
  const ranked = members.slice().sort((a, b) => {
    const ta = assessments.get(a.id)!;
    const tb = assessments.get(b.id)!;
    if (tb.tierRank !== ta.tierRank) return tb.tierRank - ta.tierRank;
    if (tb.completeness.score !== ta.completeness.score)
      return tb.completeness.score - ta.completeness.score;
    // earliest capture first (ISO strings compare chronologically).
    return (a.captured_at < b.captured_at ? -1 : a.captured_at > b.captured_at ? 1 : 0);
  });
  const retained = ranked[0]!;
  assessments.get(retained.id)!.isRetained = true;

  // Retained reasons (display labels).
  const retainedAssessment = assessments.get(retained.id)!;
  const retainedReasons: string[] = [];
  if (retainedAssessment.tier === "protected") retainedReasons.push("Protected — cannot purge");
  if (retainedAssessment.tier === "registered") retainedReasons.push("Registered linkage");
  const tierGroups = new Set(members.map((m) => assessments.get(m.id)!.tierRank));
  // "More complete record" only when it actually won on completeness among its tier.
  const sameTier = members.filter((m) => assessments.get(m.id)!.tierRank === retainedAssessment.tierRank);
  if (sameTier.length > 1 && retainedAssessment.completeness.score === Math.max(...sameTier.map((m) => assessments.get(m.id)!.completeness.score))) {
    retainedReasons.push("More complete record");
  }
  // tie-break by earliest capture?
  const topTierTopScore = sameTier.filter(
    (m) => assessments.get(m.id)!.completeness.score === retainedAssessment.completeness.score,
  );
  if (topTierTopScore.length > 1) retainedReasons.push("Earliest capture (original record)");

  // Conflicts (A.7): populated values that differ across members.
  const conflicts: FieldConflict[] = [];
  for (const field of CONFLICT_FIELDS) {
    const populated = members
      .map((m) => ({ id: m.id, value: populatedValue(field, m) }))
      .filter((v) => v.value != null && v.value !== "");
    const distinct = new Set(populated.map((v) => String(v.value)));
    if (populated.length >= 2 && distinct.size >= 2) {
      conflicts.push({ field, values: populated });
    }
  }

  // Required transfers (A.6): populated on a purge target, missing on retained.
  const retainedCompleted = new Set<ScoreField>(retainedAssessment.completeness.completed);
  const requiredTransfers: RequiredTransfer[] = [];
  for (const m of members) {
    if (m.id === retained.id) continue;
    const targetCompleted = assessments.get(m.id)!.completeness.completed;
    const missingFromRetained = targetCompleted.filter((f) => !retainedCompleted.has(f));
    if (missingFromRetained.length > 0) {
      requiredTransfers.push({ fromId: m.id, fields: missingFromRetained });
    }
  }

  const blockReasons: string[] = [];
  if (requiredTransfers.length > 0) {
    blockReasons.push(
      "Purge blocked: a target has populated accounting field(s) missing from the retained receipt. Copy/resolve them first: " +
        requiredTransfers
          .map((t) => `${t.fromId.slice(0, 8)}{${t.fields.join(",")}}`)
          .join("; "),
    );
  }
  // Multiple protected members → cannot purge the protected loser.
  const protectedCount = members.filter((m) => assessments.get(m.id)!.tier === "protected").length;
  if (protectedCount >= 2) {
    blockReasons.push(
      "Two or more members are protected (exported/AMEX/archived) — none can be purged. Keep both or resolve manually.",
    );
  }

  return {
    members,
    retainedId: retained.id,
    assessments,
    retainedReasons,
    conflicts,
    requiredTransfers,
    blocked: blockReasons.length > 0,
    blockReasons,
  };
}
