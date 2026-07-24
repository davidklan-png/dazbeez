// Client-safe closing-attention codes + labels.
//
// Pure data — no db / server imports — so the client-side queue-rail
// (components/receipts/review/queue-rail.tsx, a "use client" component) can
// render a per-row badge from the reason map produced by the closing-attention
// authority (lib/receipts/review-attention.ts) WITHOUT dragging
// @/lib/cloudflare-runtime into the browser bundle.
//
// The `import type` below is erased at compile time (isolatedModules), so
// referencing AmexLineSignoffCode as a TYPE adds neither reconciliation-signoff.ts
// nor any of its imports to the client bundle. (reconciliation-signoff.ts has no
// server-runtime imports today anyway, but the type-only import is what keeps
// this contract future-proof if that ever changes.)

import type { AmexLineSignoffCode } from "@/lib/receipts/reconciliation-signoff";

/**
 * The reason(s) one receipt needs closing attention. Emitted in canonical
 * check order (1)→(9) by {@link computeClosingAttentionReasons}. The `amex_*`
 * codes mirror {@link AmexLineSignoffCode} one-for-one (provenance kept) plus
 * `amex_total_mismatch` for a consolidated-line total mismatch.
 */
export type ClosingAttentionCode =
  | "extraction_pending" // check (1): pending / stuck extraction
  | "extraction_failed" // check (1): extraction_state === 'failed'
  | "unreviewed" // check (2)
  | "unknown_path" // check (3)
  | "missing_date" // check (4) gates, one code per gate
  | "missing_merchant"
  | "missing_amount"
  | "missing_category"
  | "attendees_missing"
  | "attendee_unresolved"
  | "missing_proof_file"
  | "compliance_open" // check (5)
  | `amex_${AmexLineSignoffCode}` // check (6): line sign-off, provenance kept
  | "amex_total_mismatch" // check (6): consolidated mismatch
  | "cross_month_ambiguous" // check (7)
  | "possible_duplicate" // check (8)
  | "ic_topup_candidate"; // check (9)

/** Short operator-facing labels for the rail badge + tooltip (render at 10px). */
export const CLOSING_ATTENTION_LABELS: Record<ClosingAttentionCode, string> = {
  extraction_pending: "processing",
  extraction_failed: "extraction failed",
  unreviewed: "unreviewed",
  unknown_path: "unknown payment path",
  missing_date: "no date",
  missing_merchant: "no merchant",
  missing_amount: "no amount",
  missing_category: "no category",
  attendees_missing: "attendees missing",
  attendee_unresolved: "attendee not in directory",
  missing_proof_file: "no proof file",
  compliance_open: "compliance check",
  amex_unresolved_match: "AMEX match unresolved",
  amex_missing_category: "AMEX category missing",
  amex_matched_not_confirmed: "AMEX match unconfirmed",
  amex_missing_reason: "AMEX reason missing",
  amex_attendees_required: "AMEX attendees required",
  amex_attendee_unresolved: "AMEX attendee unresolved",
  amex_business_trip_candidate: "business-trip candidate",
  amex_re_review_needed: "re-review",
  amex_total_mismatch: "AMEX total mismatch",
  cross_month_ambiguous: "cross-month match",
  possible_duplicate: "possible duplicate",
  ic_topup_candidate: "IC top-up?",
};
