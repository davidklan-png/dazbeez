import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";
import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";
import { evaluateAttendeeRequirement } from "@/lib/receipts/attendee-requirement";
import { resolveLineCategory } from "@/lib/receipts/line-classification";
import { isUncategorizedLine } from "@/lib/receipts/blockers";

function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const MANIFEST_HEADERS = [
  "line_id",
  "transaction_date",
  "merchant_amex",
  "merchant_receipt",
  "amount",
  "currency",
  "match_status",
  "receipt_status",
  "receipt_id",
  "receipt_sha256",
  "no_receipt_reason",
  "expense_category_code",
  "cardholder_name",
  "source_file_sha256",
  "attendees_amex",
  "attendees_receipt",
  "business_trip_status",
  "business_trip_id",
  "re_review_needed",
  "invoice_registration_number",
];

export function buildReconciliationManifestCsv(
  lines: AmexStatementLine[],
  receipts: ReceiptRecord[],
  amexAttendeeMap: Record<string, string[]>,
  receiptAttendeeMap: Record<string, string[]>,
): string {
  const receiptMap = new Map(receipts.map((r) => [r.id, r]));

  const rows: string[] = [MANIFEST_HEADERS.join(",")];

  for (const line of lines) {
    const receipt = line.matched_receipt_id
      ? receiptMap.get(line.matched_receipt_id)
      : null;

    const amount = line.currency === "JPY"
      ? String(line.amount_minor)
      : (line.amount_minor / 100).toFixed(2);

    const amexAtts = amexAttendeeMap[line.id] ?? [];
    const receiptAtts = receipt?.id
      ? (receiptAttendeeMap[receipt.id] ?? [])
      : [];

    rows.push(
      [
        csvEscape(line.id),
        csvEscape(line.transaction_date),
        csvEscape(line.merchant),
        csvEscape(receipt?.merchant),
        csvEscape(amount),
        csvEscape(line.currency),
        csvEscape(line.match_status),
        csvEscape(line.receipt_status),
        csvEscape(line.matched_receipt_id),
        csvEscape(receipt?.original_sha256),
        csvEscape(line.receipt_missing_reason),
        // Manifest category column = resolved value (receipt when matched,
        // line otherwise). Column layout is unchanged.
        csvEscape(resolveLineCategory(line, receipt)),
        csvEscape(line.cardholder_name),
        csvEscape(line.source_file_sha256),
        csvEscape(amexAtts.join("; ")),
        csvEscape(receiptAtts.join("; ")),
        csvEscape(line.business_trip_status),
        csvEscape(line.business_trip_id),
        csvEscape(String(line.re_review_needed)),
        // 適格請求書 registration number (T-number) from the linked receipt;
        // empty when no receipt is linked or the receipt carries none.
        csvEscape(receipt?.invoice_registration_number),
      ].join(","),
    );
  }

  return rows.join("\n");
}

// ─── Shared structured sign-off predicates ─────────────────────────────────
//
// The per-line sign-off rules live here as PURE predicates so two consumers
// cannot drift:
//   - validateAmexLinesForSignoff (the finalize-gate authority, returns the
//     exact human-readable blocker strings the API ships to the client), and
//   - the review-queue closing-attention collector (returns the set of
//     matched receipt ids implicated by any rule).
//
// Codes are emitted in the canonical order the gate has always pushed its
// strings, so formatting them preserves the gate's wording AND ordering.

export type AmexLineSignoffCode =
  | "unresolved_match"
  | "missing_category"
  | "matched_not_confirmed"
  | "missing_reason"
  | "attendees_required"
  | "attendee_unresolved"
  | "business_trip_candidate"
  | "re_review_needed";

export interface AmexLineSignoffResult {
  /** Canonical codes firing for this line (may be empty). */
  codes: AmexLineSignoffCode[];
  /** For attendee_unresolved: the directory-unresolved names. The string
   *  formatter emits one blocker per name; structured consumers read membership
   *  from codes alone. */
  unresolvedAttendeeNames: string[];
}

/**
 * Evaluate every per-line sign-off rule for one AMEX line, returning the
 * canonical codes that fire. Pure — no I/O. Shared by the finalize-gate string
 * authority and the closing-attention collector so the two cannot drift.
 *
 * `receipt` is the matched receipt resolved by the caller (undefined when the
 * line is unmatched or its receipt was deleted out-of-band — the category then
 * falls back to the line, matching the gate). `lineAttendees` are the line's
 * direct amex_line_attendees; `receiptAttendees` the linked receipt's names.
 */
export function evaluateAmexLineSignoff(
  line: AmexStatementLine,
  receipt:
    | Pick<ReceiptRecord, "expense_category_code" | "deleted_at">
    | undefined
    | null,
  lineAttendees: string[],
  receiptAttendees: string[],
  attendeeDirectory: ReceiptAttendeeDirectoryEntry[],
): AmexLineSignoffResult {
  const codes: AmexLineSignoffCode[] = [];
  const resolvedCategory = resolveLineCategory(line, receipt ?? undefined);

  if (line.match_status === "unmatched" || line.match_status === "matched") {
    codes.push("unresolved_match");
  }
  if (isUncategorizedLine(line, receipt ?? undefined)) {
    codes.push("missing_category");
  }
  if (
    line.receipt_status === "matched" &&
    (!line.matched_receipt_id || line.match_status !== "confirmed")
  ) {
    codes.push("matched_not_confirmed");
  }
  if (
    line.receipt_status === "missing_receipt" ||
    ((line.receipt_status === "no_receipt_required" ||
      line.receipt_status === "receipt_not_available") &&
      !line.receipt_missing_reason)
  ) {
    codes.push("missing_reason");
  }

  const unresolvedAttendeeNames: string[] = [];
  // Attendee requirement — single-sourced in evaluateAttendeeRequirement
  // (backlog #6), shared with the finalize gate so the AMEX-line checker and the
  // gate cannot drift.
  const att = evaluateAttendeeRequirement(
    resolvedCategory,
    [...receiptAttendees, ...lineAttendees],
    attendeeDirectory,
  );
  if (att.required && !att.attendeesPresent) {
    codes.push("attendees_required");
  } else if (att.required && att.unresolved.length > 0) {
    codes.push("attendee_unresolved");
    unresolvedAttendeeNames.push(...att.unresolved);
  }

  if (line.business_trip_status === "candidate") {
    codes.push("business_trip_candidate");
  }
  if (line.re_review_needed) {
    codes.push("re_review_needed");
  }

  return { codes, unresolvedAttendeeNames };
}

/** Human-readable label for a line, matching the gate's `${transaction_date}
 *  ${merchant}` format. */
function lineLabel(line: Pick<AmexStatementLine, "transaction_date" | "merchant">): string {
  return `${line.transaction_date} ${line.merchant}`;
}

/** Map a line's structured sign-off result → the exact blocker strings the
 *  finalize gate has always emitted (wording + order preserved). */
function formatAmexLineSignoffMessages(
  line: AmexStatementLine,
  result: AmexLineSignoffResult,
): string[] {
  const label = lineLabel(line);
  const out: string[] = [];
  for (const code of result.codes) {
    switch (code) {
      case "unresolved_match":
        out.push(`AMEX ${label}: unresolved match status (${line.match_status})`);
        break;
      case "missing_category":
        out.push(`AMEX ${label}: missing expense category`);
        break;
      case "matched_not_confirmed":
        out.push(`AMEX ${label}: matched receipt is not confirmed`);
        break;
      case "missing_reason":
        out.push(`AMEX ${label}: missing receipt requires a reason`);
        break;
      case "attendees_required":
        out.push(`AMEX ${label}: requires attendees`);
        break;
      case "attendee_unresolved":
        for (const name of result.unresolvedAttendeeNames) {
          out.push(
            `AMEX ${label}: attendee "${name}" is not registered in the attendee directory (company/title required)`,
          );
        }
        break;
      case "business_trip_candidate":
        out.push(`AMEX ${label}: unresolved business trip candidate`);
        break;
      case "re_review_needed":
        out.push(`AMEX ${label}: statement line changed after confirmation`);
        break;
    }
  }
  return out;
}

// ─── Consolidated receipts (multiple lines → one 領収書) ─────────────────────

export interface ConsolidatedMismatch {
  receiptId: string;
  lineCount: number;
  sum: number;
  total: number;
  label: string;
}

/**
 * Confirmed-line groups (≥2 lines sharing one matched receipt) whose amounts do
 * not sum exactly to the receipt total. Pure — shared by the finalize gate
 * (which formats each into a blocker string) and the closing-attention
 * collector (which adds the implicated receipt id). Single-line amount
 * mismatches are intentionally NOT included — those are a reviewer judgment,
 * not a blocker (unchanged behavior).
 *
 * Groups by matched receipt across all input lines; the finalize gate always
 * passes a single statement month's lines, so grouping is identical to the
 * former per-month behavior.
 */
export function collectConsolidatedMismatches(
  amexLines: AmexStatementLine[],
  receiptMap: Map<string, ReceiptRecord>,
): ConsolidatedMismatch[] {
  const confirmedByReceipt = new Map<string, AmexStatementLine[]>();
  for (const line of amexLines) {
    if (line.match_status !== "confirmed" || !line.matched_receipt_id) continue;
    const group = confirmedByReceipt.get(line.matched_receipt_id) ?? [];
    group.push(line);
    confirmedByReceipt.set(line.matched_receipt_id, group);
  }
  const out: ConsolidatedMismatch[] = [];
  for (const [receiptId, group] of confirmedByReceipt) {
    if (group.length < 2) continue;
    const receipt = receiptMap.get(receiptId);
    if (!receipt || receipt.amount_minor === null) continue;
    const sum = group.reduce((total, line) => total + line.amount_minor, 0);
    if (sum !== receipt.amount_minor) {
      out.push({
        receiptId,
        lineCount: group.length,
        sum,
        total: receipt.amount_minor,
        label: receipt.merchant ?? receiptId,
      });
    }
  }
  return out;
}

// ─── Cross-month ambiguous matches (audit A7) ───────────────────────────────

/**
 * Receipt ids matched to AMEX statement lines in MORE THAN ONE statement month.
 * Such a receipt is ambiguous — both months can't ship it — and surfaces as a
 * closing-attention signal on each month it touches. Pure; the finalize gate
 * (validateMonthReadyForExportCore gate 6) applies the same grouping, scoped to
 * the month being finalized.
 */
export function crossMonthAmbiguousReceiptIds(
  rows: Iterable<{ statement_month: string; matched_receipt_id: string }>,
): Set<string> {
  const monthsByReceipt = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.matched_receipt_id) continue;
    let set = monthsByReceipt.get(row.matched_receipt_id);
    if (!set) {
      set = new Set();
      monthsByReceipt.set(row.matched_receipt_id, set);
    }
    set.add(row.statement_month);
  }
  const out = new Set<string>();
  for (const [receiptId, months] of monthsByReceipt) {
    if (months.size > 1) out.add(receiptId);
  }
  return out;
}

/**
 * Validate that all AMEX lines are ready for sign-off/export.
 * Returns an array of human-readable blocker strings (empty = ready).
 *
 * The rule evaluation is delegated to {@link evaluateAmexLineSignoff} +
 * {@link collectConsolidatedMismatches} so the closing-attention collector
 * shares the exact same predicates. This function preserves the gate's
 * historical wording and emission order — the strings ship verbatim to the
 * finalize API client.
 *
 * `receiptMap` carries the matched receipts so category can be resolved
 * from the receipt (not the line) when a match exists. Callers must build
 * it from the matched_receipt_id set of the lines being validated.
 *
 * `attendeeDirectory` (5th param, migration 0022): when a line's resolved
 * category requires attendees AND attendees are present, every attendee name
 * (the union of the linked receipt's attendees + the line's direct attendees)
 * must resolve to a directory entry — a name with no company/title on file is
 * a blocker (business-manager review requirement: every 会議費/接待交際費 attendee
 * must show company + title). Directory rows enforce company/title NOT NULL, so
 * resolution alone proves completeness.
 */
export function validateAmexLinesForSignoff(
  amexLines: AmexStatementLine[],
  amexAttendees: Record<string, string[]>,
  receiptAttendeeMap: Map<string, string[]>,
  receiptMap: Map<string, ReceiptRecord>,
  attendeeDirectory: ReceiptAttendeeDirectoryEntry[],
): string[] {
  const blockers: string[] = [];

  for (const line of amexLines) {
    const receipt = line.matched_receipt_id
      ? receiptMap.get(line.matched_receipt_id)
      : undefined;
    const lineAttendees = amexAttendees[line.id] ?? [];
    const receiptAttendees = line.matched_receipt_id
      ? (receiptAttendeeMap.get(line.matched_receipt_id) ?? [])
      : [];
    const result = evaluateAmexLineSignoff(
      line,
      receipt,
      lineAttendees,
      receiptAttendees,
      attendeeDirectory,
    );
    blockers.push(...formatAmexLineSignoffMessages(line, result));
  }

  for (const m of collectConsolidatedMismatches(amexLines, receiptMap)) {
    blockers.push(
      `Consolidated receipt ${m.label}: ${m.lineCount} confirmed lines sum to ${m.sum} but receipt total is ${m.total}`,
    );
  }

  return blockers;
}
