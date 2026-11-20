// Synthetic two-tab fixture: real FormPane/SaveQueue, local test transport only.
import { navLog } from "./nav-shim";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReviewScreen, type ReviewScreenProps } from "@/components/receipts/export/review-screen";
import type { CategoryRoute } from "@/lib/receipts/category-cell";
import type { ExportRow } from "@/lib/receipts/types";
import { InlineCategoryCell } from "@/components/receipts/export/inline-category-cell";
import { FormPane } from "@/components/receipts/review/form-pane";
import { QueueControlsProvider } from "@/components/receipts/review/queue-controls";
import type { ReceiptRecord, ReceiptStatus } from "@/lib/receipts/types";

function makeReceipt(id: string, merchant: string): ReceiptRecord {
  return {
    id,
    revision: 0,
    created_at: "2026-11-11T09:00:00.000Z",
    updated_at: "2026-11-11T09:00:00.000Z",
    captured_at: "2026-11-11T09:00:00.000Z",
    captured_by: "fixture",
    source: "desktop_upload",
    original_filename: null,
    payment_path: "CASH",
    expense_type: "UNKNOWN",
    transaction_date: "2026-11-10",
    merchant,
    amount_minor: 4200,
    currency: "JPY",
    tax_amount_minor: null,
    business_purpose: null,
    alcohol_present: 0,
    attendees_required: 0,
    status: "captured" as ReceiptStatus,
    original_r2_key: `fixtures/${id}.pdf`,
    original_sha256: "0".repeat(64),
    original_content_type: "application/pdf",
    original_size_bytes: 1000,
    processed_r2_key: null,
    extraction_json: null,
    legacy: 0,
    exported_month: null,
    expense_category_code: null,
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
    export_statement_month: null,
  };
}

Object.assign(window, { fixtureNavigation: navLog });

function Fixture() {
  const [receipt, setReceipt] = useState(makeReceipt("r1", "Original"));
  const [sealed, setSealed] = useState(false);
  return <QueueControlsProvider items={[]} activeId="r1" queryParams="?month=2026-11">
    <button id="refresh-props" onClick={async () => {
      const state = await fetch("/state").then(r => r.json()) as { revision: number; merchant: string };
      setReceipt({ ...receipt, revision: state.revision, merchant: state.merchant });
    }}>Synthetic server refresh</button>
    <button id="seal-props" onClick={() => setSealed(true)}>Synthetic seal refresh</button>
    {window.location.hash === "#inline" ? <InlineCategoryCell
      code={receipt.expense_category_code} categoryJa={null} categoryEn={null}
      sourceLabel="from receipt" route={{ kind: "receipt", id: receipt.id, revision: receipt.revision }}
      editable hasAttendees suggestedCategoryCode={null} disabledReason={null} /> :
    <div style={{ height: "95vh" }}><FormPane receipt={receipt} initialAttendees={[]}
      queueIndex={1} queueTotal={1} nextReceiptId={null} prevReceiptId={null}
      hasAmexMatch={false} reReviewNeeded={false} overrideTargetMonths={["2026-12"]}
      naturalStatementMonth="2026-11" lock={sealed ? { locked: true, kind: "export", month: "2026-11" } : undefined} /></div>}
  </QueueControlsProvider>;
}
function IdentityFixture() {
  const [route, setRoute] = useState<CategoryRoute | null>({ kind: "receipt", id: "a", revision: 4 });
  return <>
    <button id="target-b" onClick={() => setRoute({ kind: "receipt", id: "b", revision: 9 })}>Display B</button>
    <button id="target-line" onClick={() => setRoute({ kind: "line", id: "b" })}>Display line B</button>
    <button id="target-none" onClick={() => setRoute(null)}>No target</button>
    <button id="same-target-new-token" onClick={() => setRoute({ kind: "receipt", id: "b", revision: 99 })}>Refresh B token</button>
    <div id="identity-cell"><InlineCategoryCell code={null} categoryJa={null} categoryEn={null}
      sourceLabel="from receipt" route={route} editable hasAttendees suggestedCategoryCode={null} disabledReason={null} /></div>
  </>;
}
function exportRow(id: string, revision: number): ExportRow {
  return {
    rowType: "receipt", lineId: null, receiptId: id, receiptRevision: revision,
    matchStatus: null, receiptStatus: null, missingReceiptReason: null, cardholderName: null,
    businessTripStatus: null, status: "reviewed", originalR2Key: null,
    transactionDate: "2026-11-10", merchant: `Receipt ${id.toUpperCase()}`, amountMinor: 100,
    currency: "JPY", expenseType: "UNKNOWN", expenseCategoryCode: null, expenseCategoryJa: null,
    expenseCategoryEn: null, paymentPath: "CASH", businessPurpose: null, attendees: [],
    invoiceRegistrationNumber: null, qualifiedInvoiceStatus: null, taxRate: null, taxAmountMinor: null,
    sourceType: null, counterpartyName: null,
  };
}
function ReorderFixture() {
  const [rows, setRows] = useState([exportRow("a", 4), exportRow("b", 9)]);
  const props: ReviewScreenProps = {
    month: "2026-11", monthLabel: "November 2026", window: null, rows, receipts: [],
    currentExport: null, reconciliationSealed: false, gateBlockers: [], tileBlockers: [], warnings: [],
    tripReports: [], tripLines: new Map(), categoryRules: [], prefaceNames: null, stages: [],
    attendeeMap: new Map(), amexAttendees: {}, attendeeDirectory: [],
    prefaceNoticeInput: {} as ReviewScreenProps["prefaceNoticeInput"],
  };
  return <>
    <button id="reverse" onClick={() => setRows([...rows].reverse())}>Reorder</button>
    <button id="remove-a" onClick={() => setRows(rows.filter(r => r.receiptId !== "a"))}>Remove A</button>
    <ReviewScreen {...props} />
  </>;
}
createRoot(document.getElementById("root")!).render(window.location.hash === "#identity" ? <IdentityFixture /> : window.location.hash === "#reorder" ? <ReorderFixture /> : <Fixture />);
