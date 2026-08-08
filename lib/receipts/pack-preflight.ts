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
  /** AMEX statement total (cents) for the payment-path reconciliation check;
   *  null when no AMEX artifact. */
  amexStatementTotalCents: number | null;
  /** Configured attachment-size ceiling (bytes) for the transport check. */
  maxPackBytes: number;
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
      const missing = noticeFilenames(noticeText).filter(
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
      const mentioned = new Set(noticeFilenames(noticeText));
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
      // Recon rows per category: 科目＆No (col before last 3) → category prefix
      // (strip the MonYYYY+circled suffix); 金額 (col before last 2). Layouts:
      //   AMEX: 7 base + [科目＆No, 事業目的, 人数, 領収書ファイル名] → 金額 is field[5]
      //   CASH/DIGITAL: [No,利用日,店舗名,金額,科目＆No,事業目的,人数,領収書ファイル名]
      // Compute by locating the 科目＆No + 金額 columns from the header.
      const reconByCat = new Map<string, { count: number; total: number }>();
      for (const csv of reconCsvs) {
        const rows = parseCsvRows(csv.text);
        const headerIdx = reconHeaderIndex(rows);
        if (headerIdx === -1) continue; // 集計-like (no 科目＆No.), skip
        const header = rows[headerIdx]!;
        const kamokuIdx = header.indexOf("科目＆No.");
        const amountIdx = header.indexOf("金額");
        for (const row of reconChargeRows(rows)) {
          const label = row[kamokuIdx] ?? "";
          const amount = parseAmountCell(row[amountIdx] ?? "") ?? 0;
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
    run: ({ csvs, amexStatementTotalCents }) => {
      const summary = csvs.find((c) => c.label === "集計");
      if (!summary) {
        return {
          check: "summary-payment-path-reconciles",
          passed: false,
          detail: "集計 CSV not supplied",
        };
      }
      if (amexStatementTotalCents === null) {
        return { check: "summary-payment-path-reconciles", passed: true };
      }
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
      return amexTotal === amexStatementTotalCents
        ? { check: "summary-payment-path-reconciles", passed: true }
        : {
            check: "summary-payment-path-reconciles",
            passed: false,
            detail: `集計 AMEX total ${amexTotal} ≠ statement total ${amexStatementTotalCents}`,
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
      const noticeRows = noticeText.match(/明細行数:\s*(\d+)/);
      const noticeFiles = noticeText.match(/証憑ファイル数:\s*(\d+)/);
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
      const violations: string[] = [];
      if (noticeText.includes("改訂情報")) violations.push("改訂情報 block present");
      if (/manifest|マニフェスト/.test(noticeText)) violations.push("manifest sentence present");
      if (/出席者|参加者一覧|attendee/i.test(noticeText)) violations.push("attendee reference present");
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
