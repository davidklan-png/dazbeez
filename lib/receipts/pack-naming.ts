// Single naming authority for a month's accountant pack.
//
// Every human-facing name — the delivered ZIP, the root folder, the three
// receipt folders, and the five index files — is derived here from the
// statement month + the AMEX statement payment-due date, and consumed by
// exactly three places: the ZIP assembler (proofs.ts assembleProofsZip), the
// notice builder (proofs.ts buildPackNotice), and the download resolver
// (export.ts resolveBundleDownload).
//
// WHY a single authority: the June 2026 pack's notice named files that didn't
// exist in the ZIP, because the assembler, the notice, and the downloader each
// retyped filenames independently (docs/2026-06-pack-approved-delta.md §7).
// Funneling every name through this module makes a rename impossible to apply
// in one place and miss another.
//
// Naming convention (decisions D10–D12, O5): containers and index files carry
// an ASCII date prefix — `yyyymm_` for the statement month, `yyyymmdd_` for the
// AMEX statement payment-due date. Evidence filenames inside the folders are
// deliberately NOT owned here: they keep the accountant-approved 科目＆No
// pattern (reconciliation-files.ts buildEvidenceAssignments) and must not gain
// a date prefix. See proofs.ts sanitizeZipNameSegment / buildProofFilename.

const ISO_MONTH_RE = /^\d{4}-\d{2}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `"2026-06"` → `"202606"`. Throws on a malformed statement month — the month
 *  is the spine of every name, so a bad value is a programming error, not a
 *  recoverable one. */
export function monthCode(month: string): string {
  if (!ISO_MONTH_RE.test(month)) {
    throw new Error(`Invalid statement month (expected YYYY-MM): ${month}`);
  }
  return month.replace("-", "");
}

/** `"2026-06-04"` → `"20260604"`. Throws on null/unparseable — a pack named
 *  after the wrong date is worse than a pack that refuses to build, so a
 *  missing AMEX payment-due date BLOCKS the export rather than silently
 *  falling back to a guess. (Accountant-facing AMEX folder + CSV are dated by
 *  the statement payment date; CASH/DIGITAL are dated by the month.) */
export function dueDateCode(paymentDueDate: string | null | undefined): string {
  if (!paymentDueDate) {
    throw new Error(
      "Cannot name the pack: AMEX payment_due_date is missing. The AMEX folder " +
        "and CSV are named by the statement payment date, so a null/unparseable " +
        "date blocks the export rather than producing a wrong-dated pack. " +
        "Re-import the statement CSV so its お支払日 row is parsed.",
    );
  }
  if (!ISO_DATE_RE.test(paymentDueDate)) {
    throw new Error(
      `Cannot name the pack: AMEX payment_due_date is not YYYY-MM-DD: ${paymentDueDate}.`,
    );
  }
  return paymentDueDate.replace(/-/g, "");
}

/** Shared base for the delivered ZIP filename and the root folder name.
 *  Month-only, so download resolution does not need the payment date. */
export function packContainerBase(month: string): string {
  return `${monthCode(month)}_Dazbeez_Monthly_Expense_Report`;
}

/** Delivered ZIP filename, e.g. `202606_Dazbeez_Monthly_Expense_Report.zip`.
 *  Month-only — used by the download resolver, which has the month but not the
 *  payment date, and by the assembler for the root folder. */
export function packZipName(month: string): string {
  return `${packContainerBase(month)}.zip`;
}

export interface PackNames {
  month: string;
  yyyymm: string;
  yyyymmdd: string;
  /** Delivered ZIP filename, e.g. `202606_Dazbeez_Monthly_Expense_Report.zip`. */
  zipName: string;
  /** Root folder inside the ZIP (no trailing slash). */
  rootFolder: string;
  /** Receipt folders (no trailing slash). AMEX is dated by the payment date;
   *  CASH/DIGITAL by the statement month. */
  amexFolder: string;
  cashFolder: string;
  digitalFolder: string;
  /** Index files at the ZIP root. AMEX is dated by the payment date. */
  amexReconciliationCsv: string;
  cashReconciliationCsv: string;
  digitalReconciliationCsv: string;
  summaryCsv: string;
  noticeFile: string;
}

/** Every human-facing pack name for a month. Throws on null/unparseable
 *  `paymentDueDate` (see {@link dueDateCode}); callers building a pack are
 *  expected to have a valid AMEX statement on file. Pure. */
export function buildPackNames(
  month: string,
  paymentDueDate: string | null | undefined,
): PackNames {
  const yyyymm = monthCode(month);
  const yyyymmdd = dueDateCode(paymentDueDate);
  const base = packContainerBase(month);
  return {
    month,
    yyyymm,
    yyyymmdd,
    zipName: `${base}.zip`,
    rootFolder: base,
    amexFolder: `${yyyymmdd}_AMEXカード利用領収書`,
    cashFolder: `${yyyymm}_現金払い領収書`,
    digitalFolder: `${yyyymm}_デジタル払い領収書`,
    amexReconciliationCsv: `${yyyymmdd}_AMEXカード利用明細.csv`,
    cashReconciliationCsv: `${yyyymm}_現金払いリスト.csv`,
    digitalReconciliationCsv: `${yyyymm}_デジタル払いリスト.csv`,
    summaryCsv: `${yyyymm}_集計.csv`,
    noticeFile: `${yyyymm}_ご連絡事項.txt`,
  };
}
