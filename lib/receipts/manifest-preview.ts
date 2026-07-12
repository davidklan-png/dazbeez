// On-screen manifest preview helpers for the export screen.
//
// The preview renders a simplified CSV projection of the export bundle rows
// (the same rows buildExportBundle produces — the single source of truth the
// finalize gate and the shipped receipts-{month}.csv both consume). Hoisted
// into a lib (out of the "use client" component) so the CSV projection is
// unit-testable without importing React/Next.

export interface ManifestSampleRow {
  receiptId: string;
  merchant: string;
  txnDate: string;
  amountMinor: number;
  categoryLabel: string;
  payment: string;
  alcohol: boolean;
  archivePath: string;
  // 適格請求書 registration number (T-number) from the linked/own receipt;
  // empty string when none. Mirrors the InvoiceRegistrationNumber column of
  // the shipped export bundle CSV (buildMonthlyExportCsv) so the operator
  // sees in the preview exactly what will ship.
  invoiceRegistrationNumber: string;
}

/** Escape a CSV field; quote only when it contains a comma, quote, or newline. */
function csvField(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Build the simplified preview CSV shown in the export screen's "Raw CSV"
 * view. A projection of the bundle rows — NOT the shipped CSV (which carries
 * the full column set via buildMonthlyExportCsv) — but it includes the same
 * invoice_registration_number column (appended) so the T-number visible in
 * the preview matches the column that ships.
 */
export function buildManifestPreviewCsv(rows: ManifestSampleRow[]): string {
  const header =
    "receipt_id,merchant,transaction_date,amount,category,payment_path,alcohol_present,archive_path,invoice_registration_number";
  const body = rows
    .map((r) =>
      [
        r.receiptId,
        csvField(r.merchant),
        r.txnDate,
        r.amountMinor,
        csvField(r.categoryLabel),
        r.payment,
        r.alcohol ? "true" : "false",
        csvField(r.archivePath),
        csvField(r.invoiceRegistrationNumber),
      ].join(","),
    )
    .join("\n");
  return `${header}\n${body}`;
}
