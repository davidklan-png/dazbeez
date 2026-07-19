// Reconciliation files — monthly closing review #2 (2026-07-18).
//
// The accountant-facing deliverable set is split by payment path:
//   AMEX{yyyy-mm}_Reconciliation.csv    — the ORIGINAL statement CSV, passed
//     through line-for-line, with four appended columns on charge rows:
//     科目＆No. / 会議-出席者ID / 人数 / 領収書ファイル名.
//   CASH{yyyy-mm}_Reconciliation.csv    — CASH receipt rows in the existing
//     receipts-CSV format + the same two evidence columns appended.
//   DIGITAL{yyyy-mm}_Reconciliation.csv — likewise for DIGITAL.
//
// Evidence naming follows the manual-close contract (external/ March close):
//   {勘定科目Ja}{MonYYYY}{①}{店舗}{¥金額}.{ext}   e.g. 会議費Jun2026③小田原みなと食堂¥6,490.jpg
// One evidence file per receipt; a receipt paying multiple statement lines
// gets ONE number and every line referencing it shows the same filename.
// Numbering is assigned per 勘定科目, in statement order (raw_csv_line_number)
// for AMEX, then CASH rows, then DIGITAL rows in bundle order — a single
// numbering authority feeds the CSVs AND the proofs ZIP so they cannot drift.
//
// The receipts CSV (machine layer) is untouched; these files are the human
// layer, same doctrine as 目次 vs manifest.

import type { ExportRow } from "@/lib/receipts/types";
import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";
import { resolveAttendeeNames } from "@/lib/receipts/attendee-directory";
import {
  csvEscape,
  csvQuoteAlways,
  resolveRowAttendees,
} from "@/lib/receipts/export";
import { sanitizeZipNameSegment, formatYenAmount } from "@/lib/receipts/proofs";

// ─── 科目＆No numbering ──────────────────────────────────────────────────────

const MONTH_TOKENS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** "2026-06" → "Jun2026" — the month token used in 科目＆No labels and evidence
 *  filenames, matching the manual close's `会議費Mar2026①` convention. */
export function statementMonthToken(month: string): string {
  const y = month.slice(0, 4);
  const m = Number(month.slice(5, 7));
  const token = MONTH_TOKENS[m - 1];
  if (!token) throw new Error(`Invalid statement month: ${month}`);
  return `${token}${y}`;
}

// Circled numbers 1–50 (U+2460–2473, U+3251–325F, U+32B1–32BF). The manual
// close uses ①②③…; beyond 50 we fall back to "(n)" rather than fail a
// hypothetical 51-receipt category.
export function circledNumber(n: number): string {
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + n - 1);
  if (n >= 21 && n <= 35) return String.fromCodePoint(0x3251 + n - 21);
  if (n >= 36 && n <= 50) return String.fromCodePoint(0x32b1 + n - 36);
  return `(${n})`;
}

/** One receipt = one evidence unit. Order of the input array is the numbering
 *  order (AMEX statement order first, then CASH, then DIGITAL). */
export interface EvidenceUnit {
  receiptId: string;
  categoryJa: string;
  merchant: string;
  /** Receipt total (receipt.amount_minor) — NOT the individual line amount, so
   *  a receipt paying two statement lines is named by its full amount. */
  amountMinor: number;
  currency: string;
  ext: "jpg" | "pdf";
}

export interface EvidenceAssignment {
  /** 科目＆No label, e.g. `会議費Jun2026③`. */
  label: string;
  /** Evidence filename inside the proofs ZIP, e.g.
   *  `会議費Jun2026③小田原みなと食堂¥6,490.jpg`. */
  filename: string;
  categoryJa: string;
  seq: number;
}

/** Build the full assignment map for a month: labels + filenames. Assigns
 *  per-category sequence numbers in input order; duplicate receiptIds keep
 *  their first assignment (shared-receipt rule). */
export function buildEvidenceAssignments(
  month: string,
  units: EvidenceUnit[],
): Map<string, EvidenceAssignment> {
  const token = statementMonthToken(month);
  const seqByCategory = new Map<string, number>();
  const out = new Map<string, EvidenceAssignment>();
  for (const u of units) {
    if (out.has(u.receiptId)) continue;
    const categoryJa = u.categoryJa || "未分類";
    const seq = (seqByCategory.get(categoryJa) ?? 0) + 1;
    seqByCategory.set(categoryJa, seq);
    const label = `${categoryJa}${token}${circledNumber(seq)}`;
    const merchant = sanitizeZipNameSegment(u.merchant || "unknown", 30);
    const amount = formatYenAmount(u.amountMinor, u.currency);
    out.set(u.receiptId, {
      label,
      filename: `${label}${merchant}${amount}.${u.ext}`,
      categoryJa,
      seq,
    });
  }
  return out;
}

// ─── AMEX statement passthrough ─────────────────────────────────────────────

export const AMEX_RECONCILIATION_APPEND_HEADERS = [
  "科目＆No.",
  "会議-出席者ID",
  "人数",
  "領収書ファイル名",
] as const;

/** Per-statement-line appended cells, keyed by raw_csv_line_number. */
export interface AmexLineAppend {
  /** 科目＆No label for matched lines; bare 勘定科目 for no-receipt lines. */
  kamokuNo: string;
  /** "; "-joined directory ids ("1; 2; 29"). "; " (not spaces) is a HARD rule:
   *  Excel date-coerces space-separated ids ("2 3 4" → 2-Mar-2004). */
  attendeeIds: string;
  /** Attendee count as a string; "" when no attendees. */
  attendeeCount: string;
  /** Evidence filename, or `領収書なし：{reason}` when no receipt applies. */
  receiptFileCell: string;
}

// Netアンサー canonical charge-row layout (parseAmexNetanswer contract):
// date, merchant, cardholder-flag, payment-type, prepayment-flag, amount, memo.
const NETANSWER_CHARGE_FIELD_COUNT = 7;

// Minimal CSV line parser — mirror of validation.ts parseCsvLine semantics for
// the passthrough normalization (kept local: validation.ts's parser is coupled
// to import concerns; this one only needs to split/rejoin verbatim fields).
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/**
 * Build the AMEX reconciliation CSV: the decoded original statement text,
 * passed through row-for-row, with appended columns on charge rows and the
 * header row. Pure — the route decodes the R2 artifact (decodeAmexBuffer) and
 * applies BOM+CRLF to the result.
 *
 * Row rules:
 * - Charge rows (raw line number present in `appends`): fields are normalized
 *   to the canonical 7-column layout (comma-split amounts rejoined, exactly as
 *   the importer parses them) and the 4 appended cells follow. Normalization
 *   guarantees the appended columns align in Excel even when the statement
 *   emits unquoted comma-grouped amounts (8+ raw fields).
 * - The header row (first field 利用日) gets the appended header names.
 * - Every other row (metadata, ご利用者名 sections, 小計/合計, blanks) passes
 *   through VERBATIM with no appended cells.
 */
export function buildAmexReconciliationCsv(
  statementText: string,
  appends: Map<number, AmexLineAppend>,
): string {
  const rawLines = statementText.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    const lineNumber = i + 1; // parseAmexNetanswer numbers raw lines 1-based
    const append = appends.get(lineNumber);
    if (append) {
      const fields = splitCsvLine(raw.trim());
      let normalized: string[];
      if (fields.length > NETANSWER_CHARGE_FIELD_COUNT) {
        // Comma-grouped amount split across unquoted fields — rejoin per the
        // importer's rule: amount = fields[5..n-2], memo = last field.
        normalized = [
          ...fields.slice(0, 5),
          fields.slice(5, -1).join(""),
          fields[fields.length - 1] ?? "",
        ];
      } else {
        normalized = [...fields];
        while (normalized.length < NETANSWER_CHARGE_FIELD_COUNT) normalized.push("");
      }
      out.push(
        [
          ...normalized.map((f) => csvEscape(f)),
          csvEscape(append.kamokuNo),
          csvQuoteAlways(append.attendeeIds),
          csvEscape(append.attendeeCount),
          csvEscape(append.receiptFileCell),
        ].join(","),
      );
      continue;
    }
    // Header row: first field is 利用日 → extend with appended header names.
    const trimmed = raw.trim();
    if (trimmed.startsWith("利用日")) {
      out.push(`${raw},${AMEX_RECONCILIATION_APPEND_HEADERS.join(",")}`);
      continue;
    }
    out.push(raw);
  }
  return out.join("\n");
}

/** `領収書なし：{reason}` cell for missing-receipt lines (reason optional). */
export function missingReceiptCell(reason: string | null | undefined): string {
  const r = (reason ?? "").trim();
  return r.length > 0 ? `領収書なし：${r}` : "領収書なし";
}

/** "; "-joined sorted directory ids for a row's attendees; unresolved names
 *  render "?" (drafts only — the finalize gate blocks unresolved names). */
export function attendeeIdCells(
  attendees: string[],
  directory: ReceiptAttendeeDirectoryEntry[],
): { ids: string; count: string } {
  if (attendees.length === 0) return { ids: "", count: "" };
  const { entries } = resolveAttendeeNames(attendees, directory);
  const resolved = entries
    .map((e) => (e ? e.id : null))
    .filter((id): id is number => id !== null)
    .sort((a, b) => a - b)
    .map(String);
  const unresolvedCount = entries.filter((e) => !e).length;
  const ids = [...resolved, ...Array(unresolvedCount).fill("?")].join("; ");
  return { ids, count: String(attendees.length) };
}

// ─── CASH / DIGITAL reconciliation CSVs ─────────────────────────────────────

/** Lean accountant-facing columns (draft-round feedback 2026-07-18: the full
 *  receipts-CSV column set is "too many columns" — the machine layer already
 *  ships those). Mirrors the AMEX file's appended block so both 照合CSVs read
 *  the same way; attendees carried as IDs + count, resolvable via
 *  参加者一覧.csv. */
export const PAYMENT_PATH_CSV_HEADERS = [
  "No",
  "利用日",
  "店舗名",
  "金額",
  "科目＆No.",
  "会議-出席者ID",
  "人数",
  "領収書ファイル名",
] as const;

/**
 * CASH/DIGITAL reconciliation CSV — lean rows (No restarts at 1 within the
 * file), one file per payment path. 会議-出席者ID keeps the "; " separator
 * (Excel date-coerces space-separated ids).
 */
export function buildPaymentPathReconciliationCsv(
  rows: ExportRow[],
  attendeeMap: Map<string, string[]>,
  attendeeDirectory: ReceiptAttendeeDirectoryEntry[],
  amexAttendees: Record<string, string[]>,
  assignments: Map<string, EvidenceAssignment>,
): string {
  const lines: string[] = [PAYMENT_PATH_CSV_HEADERS.join(",")];
  rows.forEach((row, index) => {
    const attendees = resolveRowAttendees(row, attendeeMap, amexAttendees);
    const { ids, count } = attendeeIdCells(attendees, attendeeDirectory);
    const assignment = row.receiptId ? assignments.get(row.receiptId) : undefined;
    lines.push(
      [
        csvEscape(String(index + 1)),
        csvEscape(row.transactionDate),
        csvEscape(row.merchant),
        csvEscape(
          row.amountMinor === null
            ? ""
            : row.currency === "JPY"
              ? String(row.amountMinor)
              : (row.amountMinor / 100).toFixed(2),
        ),
        csvEscape(assignment?.label ?? row.expenseCategoryJa ?? ""),
        csvQuoteAlways(ids),
        csvEscape(count),
        csvEscape(
          assignment?.filename ?? missingReceiptCell(row.missingReceiptReason),
        ),
      ].join(","),
    );
  });
  return lines.join("\n");
}
