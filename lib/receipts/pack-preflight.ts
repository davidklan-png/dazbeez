// Pre-send anomaly suite for an assembled accountant pack (O6).
//
// A pure function over the assembled pack — entry names + bytes + the parsed
// CSVs + the notice text — that returns an itemised pass/fail report. Every
// check fails LOUDLY, naming the offending value, so an anomaly is caught at
// seal time instead of by the accountant. Phase A exposes the function with
// full unit coverage; Phase B wires it into the pre-send confirmation screen
// and blocks send on failure.
//
// This is the standing replacement for David's manual pack inspection: once
// finalize sends automatically, a failure here is discovered by us, not by the
// accountant. See docs/2026-06-pack-approved-delta.md §16 for the check list.

import { dueDateCode } from "@/lib/receipts/pack-naming";
import { circledNumber } from "@/lib/receipts/reconciliation-files";
import { isPackNoticeMachineLine } from "@/lib/receipts/proofs";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PreflightCsvInput {
  /** Display label for messages, e.g. "AMEX", "CASH", "集計". */
  label: string;
  /** The shipped CSV text (decoded; BOM stripped by the caller). */
  text: string;
}

export interface PackPreflightEntry {
  /** Full ZIP entry path (including the root-folder prefix). */
  name: string;
  bytes: Uint8Array;
}

export interface PackPreflightInput {
  month: string;
  paymentDueDate: string | null;
  /** The pack's container names (zip filename + root folder). */
  containerNames: { zipName: string; rootFolder: string };
  /** ZIP entries: full path + bytes. An array (not a map) so a duplicate
   *  same-folder/same-basename pair is representable and detectable. */
  entries: PackPreflightEntry[];
  /** The ご連絡事項 (notice) text shipped in the pack. */
  noticeText: string;
  /** The reconciliation + summary CSVs present in the pack. */
  csvs: PreflightCsvInput[];
  /** AMEX statement total for the payment-path reconciliation check. Discriminated:
   *  - `none` — no AMEX 照合CSV in the pack (skip the check, as the old null did).
   *  - `total` — amount column resolved; cents summed from the sealed AMEX CSV.
   *  - `parse-error` — the AMEX CSV is present but its amount column (or recon
   *    header) could not be resolved; the check MUST fail with this detail rather
   *    than compare a fabricated zero. */
  amexStatementTotal: AmexStatementTotal;
  /** Configured attachment-size ceiling (bytes) for the transport check. */
  maxPackBytes: number;
  /** The stored operator_message from the export record (0037). Checked against
   *  the 【今月のご連絡】 content in the sealed notice — O7 invariant: one stored
   *  value, two surfaces, must match. */
  operatorMessage?: string | null;
}

export interface PreflightResult {
  check: string;
  passed: boolean;
  /** Present (with the offending value) when the check failed. */
  detail?: string;
}

export interface PackPreflightReport {
  passed: boolean;
  results: PreflightResult[];
}

/** The AMEX statement total, as resolved by the caller from the sealed AMEX 照合CSV
 *  via {@link sumReconChargeAmounts}. See {@link PackPreflightInput.amexStatementTotal}. */
export type AmexStatementTotal =
  | { kind: "none" }
  | { kind: "total"; cents: number }
  | { kind: "parse-error"; detail: string };

// ─── Small parsing helpers ──────────────────────────────────────────────────

// Minimal RFC-4180-ish CSV row parser: honours quoted cells (doubled inner
// quotes, embedded commas). Newlines inside quoted cells are not expected in
// these files (CRLF-delimited). Good enough to read the 領収書ファイル名 +
// 金額 columns the checks need.
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cur.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      cur.push(field);
      field = "";
      if (cur.length > 1 || cur[0] !== "") rows.push(cur);
      cur = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || cur.length > 0) {
    cur.push(field);
    if (cur.length > 1 || cur[0] !== "") rows.push(cur);
  }
  return rows;
}

/** Parse a signed yen amount cell ("6490", "-500", "1,705") → minor units.
 *  Returns null for blank/unparseable. */
function parseAmountCell(cell: string): number | null {
  const cleaned = cell.replace(/[^\d-]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

/** Reverse of circledNumber (① → 1 … ㊿ → 50; "(n)" → n). */
const CIRCLED_REVERSE = new Map<string, number>();
for (let n = 1; n <= 50; n++) CIRCLED_REVERSE.set(circledNumber(n), n);

/** Extract {category, seq} from a 科目＆No evidence filename
 *  (`会議費Jun2026③小田原みなと食堂￥6,490.jpg` → {category:"会議費", seq:3}).
 *  Returns null when the name is not the standard evidence pattern. */
function parseEvidenceCategorySeq(basename: string): { category: string; seq: number } | null {
  const noExt = basename.replace(/\.(jpg|pdf)$/i, "");
  const tokenMatch = noExt.match(/[A-Z][a-z]{2}\d{4}/);
  if (!tokenMatch || tokenMatch.index === undefined) return null;
  const category = noExt.slice(0, tokenMatch.index);
  const after = noExt.slice(tokenMatch.index + tokenMatch[0].length);
  const paren = after.match(/^\((\d+)\)/);
  if (paren) return { category, seq: Number(paren[1]) };
  const firstChar = Array.from(after)[0] ?? "";
  const seq = CIRCLED_REVERSE.get(firstChar);
  return seq === undefined ? null : { category, seq };
}

/** Entry basenames that live inside a receipt folder (root/<folder>/<file>),
 *  grouped by folder. These are the evidence files. */
function evidenceByFolder(entries: PackPreflightEntry[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { name } of entries) {
    const parts = name.split("/");
    if (parts.length !== 3) continue; // root/<folder>/<file> only
    const folder = parts[1]!;
    const file = parts[2]!;
    if (!out.has(folder)) out.set(folder, []);
    out.get(folder)!.push(file);
  }
  return out;
}

// The charge rows of a reconciliation CSV: rows AFTER the header (the row
// containing 科目＆No. — present in both the AMEX and CASH/DIGITAL recon
// headers), excluding total/blank rows. The AMEX statement's Netアンサー layout
// puts metadata (カード名称 / ご利用者名 / お支払日) BEFORE the 利用日 header and
// 小計/合計 totals AFTER the charges; CASH/DIGITAL CSVs have the header at row 0.
// Charge rows carry the appended columns (≥ the header's width); total/metadata
// rows do not, so a width check excludes them. (P2 #2 — the gate must pass a
// real pack, not just the flat test fixture.)
function reconChargeRows(rows: string[][]): string[][] {
  const headerIdx = rows.findIndex((r) => r.includes("科目＆No."));
  if (headerIdx === -1) return [];
  const width = rows[headerIdx]!.length;
  const out: string[][] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.length < width) continue; // total / blank / metadata row (narrower)
    out.push(row);
  }
  return out;
}

/** The index of the recon header row (contains 科目＆No.), or -1 if none. */
function reconHeaderIndex(rows: string[][]): number {
  return rows.findIndex((r) => r.includes("科目＆No."));
}

/** The amount column of a reconciliation CSV is located SEMANTICALLY — the one
 *  header cell that contains 金額 — not positionally. This is deliberate and
 *  load-bearing: the AMEX importer (validation.ts) reads the amount by POSITION
 *  (fields[5]) because it owns its own robustness. The preflight is a VERIFICATION
 *  layer; if it located the amount the same positional way the importer does, a
 *  column-shift regression would move both sides together and the check would
 *  become tautological. Deriving the amount by an independent method (semantic
 *  name match) is what lets the check catch a layout change. The two must
 *  disagree loudly when the card company moves the column.
 *
 *  Exactly-one-match-or-fail: zero matches (the June-2026 AMEX passthrough whose
 *  amount cell is 利用金額, not 金額, under the old exact-`indexOf("金額")` read) or
 *  two-or-more (a future 支払金額 alongside 利用金額) both return a NAMED failure
 *  instead of summing the wrong column or zero. There is no path where an
 *  unfindable amount column produces a number. */
export type AmountColumnResult =
  | { ok: true; index: number }
  | { ok: false; kind: "zero" | "multiple"; matches: string[] };

/** The index of the single header cell containing 金額, or a named failure.
 *  `header` is a row of cells (parseCsvRows output). */
export function amountColumnIndex(header: string[]): AmountColumnResult {
  const matches: { index: number; cell: string }[] = [];
  for (let i = 0; i < header.length; i++) {
    const cell = header[i] ?? "";
    if (cell.includes("金額")) matches.push({ index: i, cell });
  }
  if (matches.length === 1) return { ok: true, index: matches[0]!.index };
  return {
    ok: false,
    kind: matches.length === 0 ? "zero" : "multiple",
    matches: matches.map((m) => m.cell),
  };
}

/** Format a named amount-column failure for a check detail string. Single-sourced
 *  so the AMEX-total check, the per-category check, and the delivery-preflight
 *  boundary all report the same shape. Lists the matching cells (for "multiple")
 *  and the full actual header so the operator can see what the parser saw. */
export function describeAmountColumnFailure(opts: {
  label: string;
  kind: "zero" | "multiple";
  matches: string[];
  headerCells: string[];
}): string {
  const which =
    opts.kind === "zero"
      ? "no header cell contains 金額"
      : `${opts.matches.length} header cells contain 金額 (${opts.matches.map((m) => `"${m}"`).join(", ")})`;
  return `${opts.label} recon CSV: ${which}; expected exactly one amount column. Header: [${opts.headerCells.join(" | ")}]`;
}

/** Sum the 金額 of a reconciliation CSV's charge rows — used to derive the AMEX
 *  statement total from the sealed AMEX 照合CSV (B-5: no live lookup). This is
 *  the INDEPENDENT source for summary-payment-path-reconciles (which compares it
 *  against the 集計's AMEX total); reading the total from 集計 itself would be
 *  circular.
 *
 *  Never returns a number for "column not found" — a preflight that reported ¥0
 *  instead of "I can't find the column" produced a scary wrong "the pack doesn't
 *  reconcile" instead of "the parser is broken." On any failure to resolve the
 *  amount column (or the recon header) it returns `ok: false` carrying the actual
 *  header cells + matches so the caller can surface a named, diagnosis-ready
 *  check failure. */
export type ReconAmountSumResult =
  | { ok: true; total: number }
  | {
      ok: false;
      kind: "no-header" | "zero" | "multiple";
      headerCells: string[];
      matches: string[];
    };

export function sumReconChargeAmounts(csvText: string): ReconAmountSumResult {
  const rows = parseCsvRows(csvText);
  const headerIdx = reconHeaderIndex(rows);
  if (headerIdx === -1) {
    return { ok: false, kind: "no-header", headerCells: rows[0] ?? [], matches: [] };
  }
  const header = rows[headerIdx]!;
  const col = amountColumnIndex(header);
  if (!col.ok) {
    return { ok: false, kind: col.kind, headerCells: header, matches: col.matches };
  }
  let sum = 0;
  for (const row of reconChargeRows(rows)) {
    sum += parseAmountCell(row[col.index] ?? "") ?? 0;
  }
  return { ok: true, total: sum };
}

/** Parse the 勘定科目 section of a 集計 CSV → per-category {ja, count, totalMinor}.
 *  Single-sourced: used by summary-category-reconciles AND by the delivery email
 *  summary regeneration (D4). Rows between the 勘定科目,件数,合計金額 header and
 *  the next blank/支払方法 line. */
export function parseSummaryTotals(
  csvText: string,
): { ja: string; count: number; totalMinor: number }[] {
  const rows = parseCsvRows(csvText);
  const out: { ja: string; count: number; totalMinor: number }[] = [];
  let inCats = false;
  for (const row of rows) {
    if (row[0] === "勘定科目" && row[1] === "件数") {
      inCats = true;
      continue;
    }
    if (row[0] === "支払方法" || row[0] === "") {
      inCats = false;
      continue;
    }
    if (!inCats || row.length < 3) continue;
    out.push({
      ja: row[0]!,
      count: parseInt(row[1] ?? "0", 10),
      totalMinor: parseInt(row[2] ?? "0", 10),
    });
  }
  return out;
}

// Evidence filenames referenced by the 領収書ファイル名 (last) column of each
// reconciliation CSV's charge rows, excluding 領収書なし markers and blanks.
function referencedEvidence(
  reconCsvs: PreflightCsvInput[],
): Set<string> {
  const out = new Set<string>();
  for (const csv of reconCsvs) {
    for (const row of reconChargeRows(parseCsvRows(csv.text))) {
      if (row.length < 2) continue;
      const cell = row[row.length - 1]!.trim();
      if (!cell || cell.startsWith("領収書なし")) continue;
      out.add(cell);
    }
  }
  return out;
}

// Extract filename-like tokens (.csv/.txt/.zip) the notice mentions, so we can
// prove each one exists as an entry (the §7 desync guard, on real bytes).
function noticeFilenames(noticeText: string): string[] {
  const re = /[^\s（）「」、。]+(?:\.csv|\.txt|\.zip)/g;
  return (noticeText.match(re) ?? []).map((t) => t);
}

/** Discriminate the notice layout — see the four combinations below.
 *
 *  Do NOT scan the whole document for the marker (`の領収証憑一式を`). The
 *  operator writes arbitrary Japanese and may legitimately use that phrase in
 *  their own preface or message (observed: the operator's real 2026-06 message
 *  used the same register). A document-wide `findIndex` would land on their
 *  line, not the generated one.
 *
 *  Instead, anchor on the line IMMEDIATELY AFTER 【今月のご連絡】 — a position
 *  the generator fully controls: in the new layout buildPackNotice pushes the
 *  heading then the machine line adjacently (no blank between). Match the
 *  GENERATED machine line's specific shape (the marker + the polite closing
 *  お送りします。) at that one position — the operator's prose does not replicate
 *  the generator's exact verb form. */
function noticeMessageLayout(lines: string[]): "new" | "old" | "none" {
  const headingIdx = lines.findIndex((l) => l.startsWith("【今月のご連絡】"));
  if (headingIdx === -1) return "none";
  // In the new layout the generated machine line sits directly after the heading.
  // In the old layout the line after the heading is the operator message (which
  // does not match the generated shape). The predicate is the single source of
  // truth for the machine line's identity — it and buildPackNotice share one
  // constant, so a copy edit updates both by construction (no parallel regex).
  const next = lines[headingIdx + 1] ?? "";
  return isPackNoticeMachineLine(next) ? "new" : "old";
}

/** Remove the operator's free text from a notice, so preflight checks scan only
 *  the GENERATED structure — not the operator's own words. The operator may
 *  legitimately write anything (a D17 re-delivery supersession note naming
 *  previous-pack files; a D9 attendee retention note; 改訂/出席者/manifest
 *  references; a bracketed 【注意】 line). Without stripping, every notice check
 *  operates on the operator's prose and blocks legitimate sends.
 *
 *  Handles BOTH layouts (see {@link noticeMessageLayout}): new-layout preface
 *  (above the heading) is dropped, keeping the generated heading onward; old-
 *  layout message (between the headings) is stripped, anchoring the end on
 *  【この資料について】 — the generated heading, not any 【 the operator typed. */
export function stripOperatorMessageSection(noticeText: string): string {
  const lines = noticeText.split(/\r?\n/);
  const layout = noticeMessageLayout(lines);
  if (layout === "none") return noticeText;
  const headingIdx = lines.findIndex((l) => l.startsWith("【今月のご連絡】"));
  if (layout === "new") {
    // Preface sits above the (generated) heading — keep the heading onward.
    return lines.slice(headingIdx).join("\r\n");
  }
  // OLD layout: strip lines between the two headings.
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith("【今月のご連絡】")) {
      skipping = true;
      continue;
    }
    // End the skip at the KNOWN generated heading, not any 【 the operator typed.
    if (skipping && line.startsWith("【この資料について】")) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\r\n");
}

/** Extract the operator's free text from a notice, trimmed. Returns "" when
 *  there is no operator message. Used by the O7 invariant (check #19) to compare
 *  the sealed notice's content against the stored operator_message. Handles BOTH
 *  layouts (see {@link noticeMessageLayout}): new-layout preface = lines before
 *  the heading; old-layout message = lines between the heading and
 *  【この資料について】 (anchored on the generated heading, not any bracket token). */
export function extractOperatorMessageFromNotice(noticeText: string): string {
  const lines = noticeText.split(/\r?\n/);
  const layout = noticeMessageLayout(lines);
  if (layout === "none") return "";
  const headingIdx = lines.findIndex((l) => l.startsWith("【今月のご連絡】"));
  if (layout === "new") {
    // Preface is the lines above the heading.
    return lines.slice(0, headingIdx).join("\n").trim();
  }
  // OLD layout: message between the heading and 【この資料について】.
  let capturing = false;
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("【今月のご連絡】")) {
      capturing = true;
      continue;
    }
    if (capturing && line.startsWith("【この資料について】")) break;
    if (capturing) out.push(line);
  }
  return out.join("\n").trim();
}

// ─── Checks ─────────────────────────────────────────────────────────────────

const ASCII_RE = /^[\x20-\x7E]+$/;
const HALF_WIDTH_YEN = "¥"; // U+00A5

type Check = (input: PackPreflightInput) => PreflightResult;

const checks: { key: string; run: Check }[] = [
  // ── Naming integrity ────────────────────────────────────────────────────
  {
    key: "container-names-ascii",
    run: ({ containerNames }) => {
      const bad = [containerNames.zipName, containerNames.rootFolder].filter(
        (n) => !ASCII_RE.test(n),
      );
      return bad.length === 0
        ? { check: "container-names-ascii", passed: true }
        : {
            check: "container-names-ascii",
            passed: false,
            detail: `non-ASCII container name(s): ${bad.join(", ")}`,
          };
    },
  },
  {
    key: "notice-filenames-exist",
    run: ({ entries, noticeText }) => {
      const basenames = new Set(
        entries.map((e) => e.name.split("/").pop()!),
      );
      const missing = noticeFilenames(stripOperatorMessageSection(noticeText)).filter(
        (f) => !basenames.has(f),
      );
      return missing.length === 0
        ? { check: "notice-filenames-exist", passed: true }
        : {
            check: "notice-filenames-exist",
            passed: false,
            detail: `notice names files absent from the ZIP: ${missing.join(", ")}`,
          };
    },
  },
  {
    // Inverse of notice-filenames-exist: every shipped reconciliation CSV must
    // be NAMED in the notice. The forward check can't catch a 照合CSV that ships
    // unmentioned (the DIGITAL-list gap, docs/2026-08-07-phase-a-verification.md
    // §Minor). 照合CSVs ship at the ZIP root; 集計.csv is a summary, not a 照合
    // table, so it stays out of scope.
    key: "notice-mentions-shipped-reconciliation-csvs",
    run: ({ entries, noticeText }) => {
      const mentioned = new Set(
        noticeFilenames(stripOperatorMessageSection(noticeText)),
      );
      const reconCsvs = [
        ...new Set(
          entries
            .map((e) => e.name.split("/").pop()!)
            .filter((b) => b.endsWith(".csv") && !b.includes("集計")),
        ),
      ];
      const unmentioned = reconCsvs.filter((b) => !mentioned.has(b));
      return unmentioned.length === 0
        ? { check: "notice-mentions-shipped-reconciliation-csvs", passed: true }
        : {
            check: "notice-mentions-shipped-reconciliation-csvs",
            passed: false,
            detail: `reconciliation CSVs shipped but not named in the notice: ${unmentioned.join(", ")}`,
          };
    },
  },
  {
    key: "payment-due-date-parseable",
    run: ({ month, paymentDueDate }) => {
      try {
        dueDateCode(paymentDueDate);
        return { check: "payment-due-date-parseable", passed: true };
      } catch (e) {
        return {
          check: "payment-due-date-parseable",
          passed: false,
          detail: `month ${month}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  },

  // ── Referential integrity ───────────────────────────────────────────────
  {
    key: "csv-cells-resolve-to-entries",
    run: ({ entries, csvs }) => {
      const reconCsvs = csvs.filter((c) => c.label !== "集計");
      const basenames = new Set(
        entries.map((e) => e.name.split("/").pop()!),
      );
      const dangling: string[] = [];
      for (const cell of referencedEvidence(reconCsvs)) {
        if (!basenames.has(cell)) dangling.push(cell);
      }
      return dangling.length === 0
        ? { check: "csv-cells-resolve-to-entries", passed: true }
        : {
            check: "csv-cells-resolve-to-entries",
            passed: false,
            detail: `領収書ファイル名 cells with no ZIP entry: ${dangling.join(", ")}`,
          };
    },
  },
  {
    key: "no-orphan-evidence",
    run: ({ entries, csvs }) => {
      const reconCsvs = csvs.filter((c) => c.label !== "集計");
      const referenced = referencedEvidence(reconCsvs);
      const byFolder = evidenceByFolder(entries);
      const orphans: string[] = [];
      for (const files of byFolder.values()) {
        for (const f of files) {
          if (!referenced.has(f)) orphans.push(f);
        }
      }
      return orphans.length === 0
        ? { check: "no-orphan-evidence", passed: true }
        : {
            check: "no-orphan-evidence",
            passed: false,
            detail: `evidence files referenced by no CSV row: ${orphans.join(", ")}`,
          };
    },
  },
  {
    key: "no-duplicate-evidence-in-folder",
    run: ({ entries }) => {
      const byFolder = evidenceByFolder(entries);
      const dupes: string[] = [];
      for (const [folder, files] of byFolder) {
        const seen = new Set<string>();
        for (const f of files) {
          if (seen.has(f)) dupes.push(`${folder}/${f}`);
          seen.add(f);
        }
      }
      return dupes.length === 0
        ? { check: "no-duplicate-evidence-in-folder", passed: true }
        : {
            check: "no-duplicate-evidence-in-folder",
            passed: false,
            detail: `duplicate evidence filenames: ${dupes.join(", ")}`,
          };
    },
  },
  {
    key: "circled-sequence-contiguous",
    run: ({ entries }) => {
      // Group evidence filenames by category (across all folders — the sequence
      // continues AMEX → CASH → DIGITAL) and require 1..n with no gaps/dupes.
      const byCategory = new Map<string, number[]>();
      for (const files of evidenceByFolder(entries).values()) {
        for (const f of files) {
          const parsed = parseEvidenceCategorySeq(f);
          if (!parsed) continue;
          if (!byCategory.has(parsed.category)) byCategory.set(parsed.category, []);
          byCategory.get(parsed.category)!.push(parsed.seq);
        }
      }
      const problems: string[] = [];
      for (const [category, seqs] of byCategory) {
        const sorted = [...seqs].sort((a, b) => a - b);
        const dupes = sorted.length !== new Set(sorted).size;
        const min = sorted[0] ?? 0;
        const contiguous =
          sorted.every((n, i) => n === min + i) && min === 1;
        if (dupes || !contiguous) {
          problems.push(`${category}: ${sorted.join(",")}`);
        }
      }
      return problems.length === 0
        ? { check: "circled-sequence-contiguous", passed: true }
        : {
            check: "circled-sequence-contiguous",
            passed: false,
            detail: `non-contiguous circled sequence (must start at ①, no gaps/dupes): ${problems.join("; ")}`,
          };
    },
  },

  // ── Arithmetic ──────────────────────────────────────────────────────────
  {
    key: "summary-category-reconciles",
    run: ({ csvs }) => {
      const summary = csvs.find((c) => c.label === "集計");
      const reconCsvs = csvs.filter((c) => c.label !== "集計");
      if (!summary) {
        return {
          check: "summary-category-reconciles",
          passed: false,
          detail: "集計 CSV not supplied",
        };
      }
      // 集計 categories: rows between the 勘定科目,件数,合計金額 header and the
      // next blank/支払方法 line. Category cells carry no comma (csvEscape
      // would have quoted them); count/total are the 2nd/3rd fields.
      const sumRows = parseCsvRows(summary.text);
      const catTotals = new Map<string, { count: number; total: number }>();
      let inCats = false;
      for (const row of sumRows) {
        if (row[0] === "勘定科目" && row[1] === "件数") {
          inCats = true;
          continue;
        }
        if (row[0] === "支払方法" || row[0] === "") {
          inCats = false;
          continue;
        }
        if (!inCats || row.length < 3) continue;
        const cat = row[0]!;
        catTotals.set(cat, {
          count: parseInt(row[1] ?? "0", 10),
          total: parseInt(row[2] ?? "0", 10),
        });
      }
      // Recon rows per category: 科目＆No → category prefix (strip the
      // MonYYYY+circled suffix); the amount column located SEMANTICALLY via
      // amountColumnIndex (the single header cell containing 金額) — not by
      // position, so this verification layer stays independent of the importer
      // (validation.ts reads amount positionally; the two must disagree loudly
      // on a column shift). On any failure to resolve the amount column for a
      // recon CSV, fail THIS check naming that CSV and its actual header — never
      // silently sum a wrong/missing column.
      const reconByCat = new Map<string, { count: number; total: number }>();
      for (const csv of reconCsvs) {
        const rows = parseCsvRows(csv.text);
        const headerIdx = reconHeaderIndex(rows);
        if (headerIdx === -1) continue; // 集計-like (no 科目＆No.), skip
        const header = rows[headerIdx]!;
        const kamokuIdx = header.indexOf("科目＆No.");
        const col = amountColumnIndex(header);
        if (!col.ok) {
          return {
            check: "summary-category-reconciles",
            passed: false,
            detail: describeAmountColumnFailure({
              label: csv.label,
              kind: col.kind,
              matches: col.matches,
              headerCells: header,
            }),
          };
        }
        for (const row of reconChargeRows(rows)) {
          const label = row[kamokuIdx] ?? "";
          const amount = parseAmountCell(row[col.index] ?? "") ?? 0;
          // Category = label with the MonYYYY+circled suffix removed.
          const m = label.match(/^(.*?)[A-Z][a-z]{2}\d{4}/);
          const cat = m ? m[1]! : label;
          if (!cat) continue;
          const cur = reconByCat.get(cat) ?? { count: 0, total: 0 };
          cur.count += 1;
          cur.total += amount;
          reconByCat.set(cat, cur);
        }
      }
      const problems: string[] = [];
      for (const [cat, expected] of catTotals) {
        const actual = reconByCat.get(cat) ?? { count: 0, total: 0 };
        if (actual.count !== expected.count || actual.total !== expected.total) {
          problems.push(
            `${cat}: 集計 ${expected.count}件/${expected.total} vs CSV ${actual.count}件/${actual.total}`,
          );
        }
      }
      return problems.length === 0
        ? { check: "summary-category-reconciles", passed: true }
        : {
            check: "summary-category-reconciles",
            passed: false,
            detail: problems.join("; "),
          };
    },
  },
  {
    key: "summary-payment-path-reconciles",
    run: ({ csvs, amexStatementTotal }) => {
      const summary = csvs.find((c) => c.label === "集計");
      if (!summary) {
        return {
          check: "summary-payment-path-reconciles",
          passed: false,
          detail: "集計 CSV not supplied",
        };
      }
      // No AMEX 照合CSV in the pack ⇒ nothing to reconcile (cash/digital only).
      if (amexStatementTotal.kind === "none") {
        return { check: "summary-payment-path-reconciles", passed: true };
      }
      // AMEX CSV present but its amount column could not be resolved ⇒ a NAMED
      // failure. Never compare against a fabricated zero.
      if (amexStatementTotal.kind === "parse-error") {
        return {
          check: "summary-payment-path-reconciles",
          passed: false,
          detail: amexStatementTotal.detail,
        };
      }
      const stmtTotal = amexStatementTotal.cents;
      const rows = parseCsvRows(summary.text);
      let amexTotal: number | null = null;
      let inPaths = false;
      for (const row of rows) {
        if (row[0] === "支払方法" && row[1] === "件数") {
          inPaths = true;
          continue;
        }
        if (!inPaths || row.length < 3) continue;
        if (row[0] === "") break;
        if (row[0] === "AMEX") amexTotal = parseInt(row[2] ?? "", 10);
      }
      if (amexTotal === null || !Number.isFinite(amexTotal)) {
        return {
          check: "summary-payment-path-reconciles",
          passed: false,
          detail: "集計 has no AMEX payment-path total to reconcile",
        };
      }
      return amexTotal === stmtTotal
        ? { check: "summary-payment-path-reconciles", passed: true }
        : {
            check: "summary-payment-path-reconciles",
            passed: false,
            detail: `集計 AMEX total ${amexTotal} ≠ statement total ${stmtTotal}`,
          };
    },
  },
  {
    key: "notice-counts-match-pack",
    run: ({ entries, csvs, noticeText }) => {
      const reconCsvs = csvs.filter((c) => c.label !== "集計");
      const rowCount = reconCsvs.reduce(
        (n, csv) => n + reconChargeRows(parseCsvRows(csv.text)).length,
        0,
      );
      const evidenceCount = [...evidenceByFolder(entries).values()].reduce(
        (n, files) => n + files.length,
        0,
      );
      // Scan stripped text (generated structure only) for consistency with the
      // other notice checks — operator prose is removed first. The counts live
      // in the generated 【今月の内容】 section, so stripping does not change
      // them; this is a consistency hardening, not a fix.
      const stripped = stripOperatorMessageSection(noticeText);
      const noticeRows = stripped.match(/明細行数:\s*(\d+)/);
      const noticeFiles = stripped.match(/証憑ファイル数:\s*(\d+)/);
      const problems: string[] = [];
      if (noticeRows && Number(noticeRows[1]) !== rowCount) {
        problems.push(`明細行数: notice ${noticeRows[1]} vs pack ${rowCount}`);
      }
      if (noticeFiles && Number(noticeFiles[1]) !== evidenceCount) {
        problems.push(`証憑ファイル数: notice ${noticeFiles[1]} vs pack ${evidenceCount}`);
      }
      return problems.length === 0
        ? { check: "notice-counts-match-pack", passed: true }
        : {
            check: "notice-counts-match-pack",
            passed: false,
            detail: problems.join("; "),
          };
    },
  },

  // ── Encoding + transport ────────────────────────────────────────────────
  {
    key: "entry-names-utf8-roundtrip",
    run: ({ entries }) => {
      const bad: string[] = [];
      const enc = new TextEncoder();
      const dec = new TextDecoder("utf-8", { fatal: true });
      for (const { name } of entries) {
        try {
          const round = dec.decode(enc.encode(name));
          if (round !== name) bad.push(name);
        } catch {
          bad.push(name);
        }
      }
      return bad.length === 0
        ? { check: "entry-names-utf8-roundtrip", passed: true }
        : {
            check: "entry-names-utf8-roundtrip",
            passed: false,
            detail: `entry names that don't round-trip UTF-8 (lone surrogate?): ${bad.join(", ")}`,
          };
    },
  },
  {
    key: "entry-names-nfc",
    run: ({ entries }) => {
      const bad = entries
        .map((e) => e.name)
        .filter((n) => n !== n.normalize("NFC"));
      return bad.length === 0
        ? { check: "entry-names-nfc", passed: true }
        : {
            check: "entry-names-nfc",
            passed: false,
            detail: `non-NFC entry names (Mac-origin NFD?): ${bad.join(", ")}`,
          };
    },
  },
  {
    key: "entry-names-no-forbidden-chars",
    run: ({ entries }) => {
      // Test each path SEGMENT — the "/" between root/folder/file is a
      // legitimate ZIP separator, not a forbidden character. A backslash,
      // colon, asterisk, etc. in any segment (or a non-BMP code point) fails.
      const segForbidden = /[\\:*?"<>|]/;
      const bad: string[] = [];
      for (const { name: path } of entries) {
        let flagged = false;
        for (const seg of path.split("/")) {
          if (segForbidden.test(seg)) { flagged = true; break; }
          for (const ch of seg) {
            if (ch.codePointAt(0)! > 0xffff) { flagged = true; break; }
          }
          if (flagged) break;
        }
        if (flagged) bad.push(path);
      }
      return bad.length === 0
        ? { check: "entry-names-no-forbidden-chars", passed: true }
        : {
            check: "entry-names-no-forbidden-chars",
            passed: false,
            detail: `entry segments with forbidden/non-BMP chars: ${bad.join(", ")}`,
          };
    },
  },
  {
    key: "no-half-width-yen",
    run: ({ entries }) => {
      const bad = entries
        .map((e) => e.name)
        .filter((n) => n.includes(HALF_WIDTH_YEN));
      return bad.length === 0
        ? { check: "no-half-width-yen", passed: true }
        : {
            check: "no-half-width-yen",
            passed: false,
            detail: `half-width ¥ (U+00A5) in filenames (CP932 0x5C hazard, regression on 0d477f9): ${bad.join(", ")}`,
          };
    },
  },
  {
    key: "pack-size-under-ceiling",
    run: ({ entries, maxPackBytes }) => {
      const total = entries.reduce((n, e) => n + e.bytes.length, 0);
      return total <= maxPackBytes
        ? { check: "pack-size-under-ceiling", passed: true }
        : {
            check: "pack-size-under-ceiling",
            passed: false,
            detail: `pack is ${total} bytes, ceiling is ${maxPackBytes}`,
          };
    },
  },

  // ── Content policy ──────────────────────────────────────────────────────
  {
    key: "notice-policy",
    run: ({ noticeText }) => {
      // Scan only the GENERATED notice structure, not the operator's free text
      // under 【今月のご連絡】 — the operator may legitimately write 改訂/出席者/
      // manifest references (D17 re-delivery supersession note, D9 attendee
      // retention note). Without stripping, preflight blocks on the operator's
      // own words.
      const generated = stripOperatorMessageSection(noticeText);
      const violations: string[] = [];
      if (generated.includes("改訂情報")) violations.push("改訂情報 block present");
      if (/manifest|マニフェスト/.test(generated)) violations.push("manifest sentence present");
      if (/出席者|参加者一覧|attendee/i.test(generated)) violations.push("attendee reference present");
      return violations.length === 0
        ? { check: "notice-policy", passed: true }
        : {
            check: "notice-policy",
            passed: false,
            detail: violations.join("; "),
          };
    },
  },
  {
    key: "csv-no-attendee-id-column",
    run: ({ csvs }) => {
      const offenders: string[] = [];
      for (const csv of csvs) {
        const header = parseCsvRows(csv.text)[0] ?? [];
        if (header.includes("会議-出席者ID")) offenders.push(csv.label);
      }
      return offenders.length === 0
        ? { check: "csv-no-attendee-id-column", passed: true }
        : {
            check: "csv-no-attendee-id-column",
            passed: false,
            detail: `CSVs still carrying a 会議-出席者ID column: ${offenders.join(", ")}`,
          };
    },
  },
  {
    // O7 invariant (one message, two surfaces): the operator_message stored on
    // receipt_exports (0037) must equal the 【今月のご連絡】 content in the sealed
    // notice. If they disagree, the ZIP and the email would say different things
    // — verified against the REAL sealed bytes, not a comment. operator_message
    // is sealed with the row (recordExportBundle's WHERE status='draft' guard);
    // changing it requires a rebuild.
    key: "operator-message-matches-notice",
    run: ({ noticeText, operatorMessage }) => {
      const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
      const fromNotice = norm(extractOperatorMessageFromNotice(noticeText));
      const fromRecord = norm(operatorMessage ?? "");
      return fromNotice === fromRecord
        ? { check: "operator-message-matches-notice", passed: true }
        : {
            check: "operator-message-matches-notice",
            passed: false,
            detail:
              "the notice's 【今月のご連絡】 does not match the stored operator_message " +
              "— the pack was sealed with a different message (O7 invariant; rebuild to change it)",
          };
    },
  },
];

/**
 * Run every preflight check against an assembled pack. Returns `{passed,
 * results}`; `passed` is true only if every check passed. Each failed result
 * carries a `detail` naming the offending value. Pure — no I/O.
 */
export function runPackPreflight(input: PackPreflightInput): PackPreflightReport {
  const results = checks.map((c) => c.run(input));
  return { passed: results.every((r) => r.passed), results };
}

/** All check keys, in order — useful for asserting coverage in tests. */
export const PREFLIGHT_CHECK_KEYS = checks.map((c) => c.key);
