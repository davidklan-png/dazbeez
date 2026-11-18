// Mounted browser regressions: real ReviewLayout/FormPane/hooks, synthetic
// receipts only. Bundle with esbuild and the existing Next router/link shims.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { FormPane } from "@/components/receipts/review/form-pane";
import { ReviewLayout } from "@/components/receipts/review/review-layout";
import { buildQueueItems } from "@/lib/receipts/queue-items";
import { guardedNavigate } from "@/lib/receipts/review-navigation";
import type { ReceiptLockInfo } from "@/lib/receipts/receipt-locks";
import type { PaymentPath, ReceiptRecord } from "@/lib/receipts/types";
import { navLog } from "./nav-shim";

const root = createRoot(document.getElementById("root")!);
const requests: string[] = [];
const results: string[] = [];
window.fetch = async (url, init) => {
  requests.push(`${init?.method ?? "GET"} ${url}`);
  return Response.json({ ok: true, warnings: [], entries: [] });
};
window.confirm = () => true;
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function mount(path: PaymentPath, lock: ReceiptLockInfo, key: string = path, empty = false) {
  const receipt = {
    id: "fixture", payment_path: path, transaction_date: "2026-05-10", status: "captured",
    merchant: "Sealed display fixture", amount_minor: 4200, currency: "JPY",
    expense_category_code: "entertainment", export_statement_month: "2026-07",
    extraction_state: "processed", business_purpose: "Fixture purpose",
  } as ReceiptRecord;
  const queueItems = buildQueueItems([receipt], new Map(), Date.now(), new Map([[receipt.id, lock]]));
  flushSync(() => root.render(
    <ReviewLayout key={key} queueItems={empty ? [] : queueItems} activeId={empty ? null : receipt.id}
      readOnly={lock.locked} queryParams="?month=2026-05" needsAttention={0} workingSetCount={1}
      effectiveMonth="2026-05" availableMonths={["2026-05", "2026-07"]} monthParam="2026-05"
      imagePane={<div className="p-6">Synthetic original — no receipt data</div>}
      formPane={empty ? <p>Select a receipt from the queue.</p> :
        <FormPane receipt={receipt} initialAttendees={[{ id: "attendee-fixture", receipt_id: receipt.id, attendee_name: "Synthetic attendee", company: null, relationship: null, is_dazbeez_employee: 0, notes: null, created_at: "2026-05-10" }]} queueIndex={1} queueTotal={1}
          nextReceiptId={null} prevReceiptId={null} hasAmexMatch={false} reReviewNeeded={false}
          overrideTargetMonths={["2026-08"]} naturalStatementMonth="2026-05" lock={lock} />}
    />,
  ));
}
function input(labelText: string) {
  const label = Array.from(document.querySelectorAll("label")).find((el) => el.querySelector("span")?.textContent === labelText);
  const control = label?.querySelector("input,select");
  assert(control, `missing ${labelText}`);
  return control as HTMLInputElement;
}
function edit(value: string) {
  const control = input("Merchant");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}
function key(key: string) {
  (document.activeElement as HTMLElement | null)?.blur();
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}
const unlocked: ReceiptLockInfo = { locked: false, kind: null, month: null };
const sealed: ReceiptLockInfo = { locked: true, kind: "export", month: "2026-07" };

async function run() {
  for (const path of ["AMEX", "CASH", "DIGITAL", "UNKNOWN"] as const) {
    mount(path, sealed); await tick();
    const start = requests.length;
    for (const label of ["Merchant", "Date", "Amount", "Business purpose"]) assert(input(label).disabled, `${path}: ${label} disabled`);
    const form = input("Merchant").closest("section")?.parentElement;
    const radios = Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
    assert(radios.length === 4 && radios.every((el) => el.disabled), `${path}: payment paths disabled`);
    for (const text of ["Delete", "Mark reviewed", "Re-parse OCR text", "Remove", "Register attendee"]) {
      const button = Array.from(document.querySelectorAll("button")).find((el) => el.textContent?.includes(text));
      assert(button?.disabled, `${path}: ${text} disabled`);
      button.click();
    }
    assert(form, "form mounted");
    for (const control of form.querySelectorAll("input, select")) {
      assert(control instanceof HTMLInputElement || control instanceof HTMLSelectElement, "native form control");
      assert(control.disabled || (control instanceof HTMLInputElement && control.readOnly), `${path}: native disabled/read-only field`);
    }
    const attendeeAdd = Array.from(form.querySelectorAll("button")).find((el) => el.textContent?.includes("Add attendee"));
    assert(attendeeAdd?.disabled, `${path}: attendee editing disabled`);
    for (const k of ["s", "c", "a"]) key(k);
    assert(document.activeElement === document.body, "editing shortcuts do not focus controls");
    edit("programmatic edit");
    input("Business purpose").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "test" }));
    await tick(550);
    await guardedNavigate(() => {});
    assert(!requests.slice(start).some((r) => /^(PATCH|POST|DELETE)/.test(r)), `${path}: no autosave or mutations`);
    assert(navLog.length === 0, "save shortcut never navigates");
    const text = document.body.textContent ?? "";
    assert(text.includes("Read-only receipt · changes are disabled"), "read-only footer");
    assert(!text.includes("Auto-saving every change"), "no false autosave footer");
    results.push(`${path}: disabled fields/payment/category/attendees/override/actions; shortcuts, composition, debounce and navigation flush cause no mutation`);
  }
  // A pending timer must also stop if a refresh locks the mounted form.
  mount("CASH", unlocked, "transition"); await tick();
  edit("pending before seal"); await tick();
  const start = requests.length;
  mount("CASH", sealed, "transition"); await tick(550); await guardedNavigate(() => {});
  assert(!requests.slice(start).some((r) => r.startsWith("PATCH")), "new lock cancels pending autosave and unmount flush");
  results.push("unlocked-to-locked transition suppresses pending autosave");
  // Positive control: an editable correction really can autosave.
  mount("CASH", unlocked, "editable"); await tick();
  const before = requests.length;
  edit("correction edit"); await tick(550);
  assert(requests.slice(before).some((r) => r.startsWith("PATCH")), "editable correction autosaves");
  assert(document.body.textContent?.includes("Auto-saving every change"), "editable footer preserved");
  results.push("editable correction autosaves (positive control)");
  mount("CASH", unlocked, "empty", true); await tick();
  assert(document.body.textContent?.includes("Select a receipt from the queue."), "empty wording preserved");
  results.push("empty queue wording preserved");
  for (const kind of ["archived", "exported"] as const) {
    mount("DIGITAL", { locked: true, kind, month: null }, kind); await tick();
    assert(input("Merchant").disabled, `${kind} disabled`);
    assert(!document.body.textContent?.includes("The  export"), "no invented month");
    results.push(`${kind} read-only status explanation`);
  }
  mount("CASH", sealed, "screenshot"); await tick();
  return { results, requests, navLog };
}

// Browser runner awaits this and writes the result beside screenshots.
Object.assign(window, { sealedDisplayResults: run() });
