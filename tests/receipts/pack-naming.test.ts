import test from "node:test";
import assert from "node:assert/strict";
import {
  monthCode,
  dueDateCode,
  packContainerBase,
  packZipName,
  buildPackNames,
} from "@/lib/receipts/pack-naming";

// ─── monthCode ──────────────────────────────────────────────────────────────

test("monthCode: YYYY-MM → YYYYMM (hyphen stripped)", () => {
  assert.equal(monthCode("2026-06"), "202606");
  assert.equal(monthCode("2027-12"), "202712");
  assert.equal(monthCode("2026-01"), "202601");
});

test("monthCode: throws on malformed month", () => {
  assert.throws(() => monthCode("2026-6"), /Invalid statement month/);
  assert.throws(() => monthCode("202606"), /Invalid statement month/);
  assert.throws(() => monthCode(""), /Invalid statement month/);
});

// ─── dueDateCode ────────────────────────────────────────────────────────────

test("dueDateCode: YYYY-MM-DD → YYYYMMDD (hyphens stripped)", () => {
  assert.equal(dueDateCode("2026-06-04"), "20260604");
  assert.equal(dueDateCode("2026-12-31"), "20261231");
});

test("dueDateCode: throws on null/unparseable (export-blocking, no fallback)", () => {
  // A pack named after the wrong date is worse than a pack that refuses to
  // build, so a missing AMEX payment-due date blocks the export.
  assert.throws(() => dueDateCode(null), /payment_due_date is missing/);
  assert.throws(() => dueDateCode(undefined), /payment_due_date is missing/);
  assert.throws(() => dueDateCode(""), /payment_due_date is missing/);
  assert.throws(() => dueDateCode("2026/06/04"), /not YYYY-MM-DD/);
  assert.throws(() => dueDateCode("not-a-date"), /not YYYY-MM-DD/);
});

// ─── packContainerBase / packZipName (month-only, download-safe) ────────────

test("packContainerBase + packZipName: month-only ASCII container names", () => {
  assert.equal(packContainerBase("2026-06"), "202606_Dazbeez_Monthly_Expense_Report");
  assert.equal(packZipName("2026-06"), "202606_Dazbeez_Monthly_Expense_Report.zip");
  assert.ok(/^[\x20-\x7E]+$/.test(packZipName("2026-06")), "pure ASCII");
});

// ─── buildPackNames: the full naming scheme ─────────────────────────────────

test("buildPackNames: every name matches the approved scheme (D10–D12, O5)", () => {
  const n = buildPackNames("2026-06", "2026-06-04");
  assert.equal(n.month, "2026-06");
  assert.equal(n.yyyymm, "202606");
  assert.equal(n.yyyymmdd, "20260604");
  // Container + root (same base, month-only).
  assert.equal(n.zipName, "202606_Dazbeez_Monthly_Expense_Report.zip");
  assert.equal(n.rootFolder, "202606_Dazbeez_Monthly_Expense_Report");
  // Receipt folders: AMEX dated by payment date; CASH/DIGITAL by month.
  assert.equal(n.amexFolder, "20260604_AMEXカード利用領収書");
  assert.equal(n.cashFolder, "202606_現金払い領収書");
  assert.equal(n.digitalFolder, "202606_デジタル払い領収書");
  // Index files: AMEX dated; CASH/DIGITAL/集計 by month; ご連絡事項.
  assert.equal(n.amexReconciliationCsv, "20260604_AMEXカード利用明細.csv");
  assert.equal(n.cashReconciliationCsv, "202606_現金払いリスト.csv");
  assert.equal(n.digitalReconciliationCsv, "202606_デジタル払いリスト.csv");
  assert.equal(n.summaryCsv, "202606_集計.csv");
  assert.equal(n.noticeFile, "202606_ご連絡事項.txt");
});

test("buildPackNames: throws on null payment date (blocks the export)", () => {
  assert.throws(() => buildPackNames("2026-06", null), /payment_due_date is missing/);
  assert.throws(() => buildPackNames("2026-06", "bad"), /not YYYY-MM-DD/);
});

test("buildPackNames: names are stable regardless of folder/index order", () => {
  // Same inputs always produce the same names (deterministic — the byte-identity
  // precondition for draft ⇄ seal).
  const a = buildPackNames("2026-06", "2026-06-04");
  const b = buildPackNames("2026-06", "2026-06-04");
  assert.deepEqual(a, b);
});
