import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FormPaneProps } from "@/components/receipts/review/form-pane";
import type { ReceiptLockInfo } from "@/lib/receipts/receipt-locks";
import type { ReceiptRecord } from "@/lib/receipts/types";

// Only Next's router is replaced; SSR renders the real controls and providers.
require.cache[require.resolve("next/navigation")] = {
  exports: { useRouter: () => ({ push() {}, refresh() {} }) },
} as typeof require.cache[string];
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FormPane } = require("../../components/receipts/review/form-pane");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ReviewLayout } = require("../../components/receipts/review/review-layout");
const receipt = {
  id: "fixture", revision: 0, payment_path: "CASH", status: "reviewed", merchant: "Fixture",
  transaction_date: "2026-05-10", amount_minor: 100, currency: "JPY",
  expense_category_code: "entertainment", export_statement_month: "2026-07",
} as ReceiptRecord;
const props: FormPaneProps = {
  receipt, initialAttendees: [], queueIndex: null, queueTotal: 0,
  nextReceiptId: null, prevReceiptId: null, hasAmexMatch: false, reReviewNeeded: false,
  overrideTargetMonths: ["2026-08"], naturalStatementMonth: "2026-05",
};
function render(lock?: ReceiptLockInfo, activeId: string | null = "fixture") {
  return renderToStaticMarkup(createElement(ReviewLayout, {
    queueItems: [], activeId, queryParams: "?month=2026-05", needsAttention: 0,
    workingSetCount: 0, effectiveMonth: "2026-05", availableMonths: ["2026-05"],
    monthParam: "2026-05", readOnly: lock?.locked,
    imagePane: "Fixture original", formPane: activeId ? createElement(FormPane, { ...props, lock }) : "Select a receipt",
  }));
}

test("actual sealed Review markup uses native disabled inputs and an honest footer without editing hints", () => {
  const html = render({ locked: true, kind: "export", month: "2026-07" });
  assert.match(html, /Read-only receipt · changes are disabled/);
  assert.doesNotMatch(html, /Auto-saving every change|save &amp; next/);
  assert.match(html, /The 2026-07 export is finalized/);
  assert.match(html, /href="\/receipts\/export\?month=2026-07"/);
  const form = html.slice(html.indexOf("Read-only.</span>"));
  for (const input of form.matchAll(/<(?:input|select)\b[^>]*>/g)) assert.match(input[0], /(?:disabled|readOnly)=""/);
  assert.match(form, /<button[^>]*disabled=""[^>]*><span>Delete<\/span><\/button>/);
  assert.match(form, /role="radio"[^>]*disabled=""/);
});

test("archived and missing-export-month explanations do not invent a month or correction remedy", () => {
  const archived = render({ locked: true, kind: "archived", month: null });
  assert.match(archived, /archived and cannot be edited/);
  assert.doesNotMatch(archived, /export is finalized|Open a revision/);
  const exported = render({ locked: true, kind: "exported", month: null });
  assert.match(exported, /no recorded export month and cannot be edited/);
});

test("editable and empty Review retain their existing autosave footer wording", () => {
  assert.match(render(), /Auto-saving every change/);
  assert.match(render(undefined, null), /Auto-saving every change/);
});

test("active receipt page carries its authority lock into both form and footer", () => {
  const page = readFileSync("app/(receipt-system)/receipts/review/[id]/page.tsx", "utf8");
  assert.match(page, /readOnly=\{activeLock.locked\}/);
  assert.match(page, /lock=\{activeLock\}/);
});
