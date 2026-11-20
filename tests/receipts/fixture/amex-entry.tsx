// Mounted production ReconcileScreen with recorded routing and deferred transport.
// No account, database, processor, or live network participates in this fixture.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ReconcileScreen, type ReconcileScreenProps } from "@/components/receipts/reconcile/reconcile-screen";
import type { AmexStatementLine, ReceiptRecord, ReceiptStatus } from "@/lib/receipts/types";
import { navLog } from "./nav-shim";

const root = createRoot(document.getElementById("app")!);
const results: string[] = [];
const requests: { url: string; body: Record<string, unknown>; finish: (body?: unknown, status?: number) => void; drop: () => void }[] = [];
window.confirm = () => true;
window.fetch = (url, init) => {
  if (!init?.method || init.method === "GET") return Promise.resolve(Response.json(tripMode && String(url).includes("/trips/")
    ? { trip: { revision: 0, trip_name: "Synthetic trip", start_date: "2026-11-01", end_date: "2026-11-02", status: "candidate" }, lines: [{ id: "a", revision: 0 }] }
    : { entries: [] }));
  return new Promise((resolve, reject) => requests.push({ url: String(url), body: JSON.parse(String(init.body)),
    finish: (body = { ok: true, revision: requests.length + 1 }, status = 200) => resolve(Response.json(body, { status })),
    drop: () => reject(new TypeError("lost acknowledgement")) }));
};
function line(id: string): AmexStatementLine {
  return { id, revision: 0, statement_month: "2026-11", transaction_date: "2026-11-01", posting_date: null,
    merchant: `Synthetic ${id}`, amount_minor: 100, currency: "JPY", amex_reference: null, matched_receipt_id: null,
    match_status: "no_receipt", raw_json: "{}", created_at: "t", statement_artifact_id: null, cardholder_name: null,
    cardholder_flag: null, payment_type: null, prepayment_flag: null, memo: null, raw_csv_line_number: null,
    source_file_sha256: null, imported_at: null, expense_category: "unknown", category_status: "confirmed",
    receipt_status: "no_receipt_required", receipt_missing_reason: id === "b" ? "Existing reason" : "", business_trip_id: null,
    business_trip_status: "not_applicable", expense_category_code: "supplies", re_review_needed: 0, updated_at: null };
}
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

let era = 0;
let tripMode = false;
function mount(trip = false, candidates = false) {
  requests.length = 0; navLog.length = 0; tripMode = trip;
  const props: ReconcileScreenProps = { amexLines: [line("a"), line("b")], receipts: [], autoMatches: [], orphanReceipts: [],
    leadingSlackReceipts: [], upcomingReceipts: [], undatedReceipts: [], duplicateCandidates: new Map(), incompletePurgeJobs: [],
    month: "2026-11", monthLabel: "November 2026", monthsAvailable: [{ month: "2026-10", lineCount: 1, unmatchedCount: 0, status: null }, { month: "2026-11", lineCount: 2, unmatchedCount: 0, status: null }],
    finalized: false, window: null, receiptsInWindow: [], attendeesByReceiptId: new Map(), attendeesByLineId: { a: ["村上多寿子"] },
    attendeeDirectory: [], categoryRules: [], initialLineId: "a" };
  if (candidates) {
    props.receipts = [{ ...makeReceipt("r", "Synthetic consolidated receipt"), revision: 3, payment_path: "AMEX", status: "reviewed" }];
    props.autoMatches = props.amexLines.map(l => ({ amexLineId: l.id, receiptId: "r", confidenceScore: 100, matchReasons: ["Synthetic match"], consolidatedGroupSize: 2 }));
    for (const l of props.amexLines) { l.match_status = "unmatched"; l.receipt_status = "missing_receipt"; }
  }
  if (trip) { props.amexLines[0].business_trip_id = "t"; props.amexLines[0].business_trip_status = "candidate"; }
  flushSync(() => root.render(<ReconcileScreen key={++era} {...props} />));
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
async function until(test: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) { if (test()) return; await tick(); }
  throw new Error(`Timeout: ${label}; requests=${JSON.stringify(requests.map(r => r.body))}`);
}
function reason(id = "a") { const input = document.getElementById(`missing-reason-${id}`); assert(input, `Missing reason ${id}`); return input as HTMLInputElement; }
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function click(id: string) { document.getElementById(`line-${id}`)!.click(); }
function button(text: string) { const b = [...document.querySelectorAll("button")].find(b => b.textContent?.includes(text)); assert(b, `Missing button ${text}`); return b; }
function selected(id: string) { return document.getElementById(`line-${id}`)?.getAttribute("aria-current") === "true"; }

async function run() {
  mount(); await tick();
  type(reason(), "最初の理由"); reason().dispatchEvent(new FocusEvent("focusout", { bubbles: true })); click("b");
  await until(() => Number(requests.length) === 1, "reason blur + selection save");
  assert(selected("a"), "Selection escaped before first acknowledgement");
  type(reason(), "保存中に追記した理由");
  requests[0].finish({ ok: true, receiptRevisions: {}, revision: 2 });
  await until(() => Number(requests.length) === 2, "late typing drain");
  assert(selected("a"), "Selection escaped before latest draft acknowledgement");
  assert(requests[1].body.receiptMissingReason === "保存中に追記した理由", "Latest Japanese reason lost");
  assert(Number(requests[1].body.expectedRevision) === 2, "Did not consume own acknowledgement");
  requests[1].finish({ ok: true, receiptRevisions: {}, revision: 4 });
  await until(() => selected("b"), "selection after full drain");
  results.push("reason onBlur + line switch waits for late typing and acknowledged revisions");

  mount(); await tick();
  const input = reason();
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); type(input, "にほんご"); click("b");
  await tick(520); assert(Number(requests.length) === 0 && selected("a"), "Composition did not hold selection and writes");
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本語確定" })); type(input, "日本語確定");
  await until(() => Number(requests.length) === 1, "IME final save");
  assert(requests[0].body.receiptMissingReason === "日本語確定", "IME final text was not preserved");
  requests[0].finish({ ok: true, receiptRevisions: {}, revision: 5 }); await until(() => selected("b"), "IME selection after ack");
  results.push("IME holds writes/navigation, then drains committed raw Japanese input");

  mount(); await tick(); type(reason(), "signoff draft"); await tick();
  button("Finalize").click(); await tick();
  const confirm = [...document.querySelectorAll("input")].find(i => i.placeholder === "2026-11" || i.placeholder?.includes("2026-11"));
  assert(confirm, "Missing signoff confirmation input"); type(confirm, "2026-11"); await tick();
  const sign = [...document.querySelectorAll("button")].filter(b => b.textContent?.trim() === "Finalize").at(-1)!;
  sign.click(); await until(() => requests.length > 0, "pending timer before signoff");
  assert(requests[0].url.includes("/amex/lines/a"), "Signoff escaped pending reason timer");
  requests[0].finish({ ok: true, receiptRevisions: {}, revision: 6 }); await until(() => Number(requests.length) === 2, "signoff after save");
  assert(requests[1].url.endsWith("/finalize"), "No signoff after acknowledged line save");
  requests[1].finish({ ok: true, warnings: [] }); await tick();
  results.push("signoff flushes pending reason timer before finalization request");

  mount(); await tick();
  const attendee = document.querySelector('input[placeholder="Attendee name"]') as HTMLInputElement;
  assert(attendee, "Missing attendee editor"); type(attendee, "新しい参加者");
  await tick(480); await until(() => Number(requests.length) === 1, "roster autosave");
  const category = document.querySelector('select') as HTMLSelectElement;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(category, "communications");
  category.dispatchEvent(new Event("change", { bubbles: true }));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "u", bubbles: true }));
  await tick(); assert(Number(requests.length) === 1, "Category/action overwrote busy slot and overlapped roster save");
  requests[0].finish({ ok: true, receiptRevisions: {}, revision: 3 }); await until(() => Number(requests.length) === 2, "category behind roster");
  assert(requests[1].body.expenseCategoryCode === "communications", "Category draft lost");
  requests[1].finish({ ok: true, receiptRevisions: {}, revision: 5 }); await until(() => Number(requests.length) === 3, "unlink behind latest fields");
  assert(requests[2].url.endsWith("/reconcile") && Number(requests[2].body.expectedRevision) === 5, "Unlink escaped edit lane");
  requests[2].finish({ ok: true, revision: 7, receiptRevisions: {}, lineRevisions: {} }); await tick();
  results.push("roster/category/keyboard action share ordering despite shared busy-slot interleaving");

  mount(true); await tick(100); type(reason(), "trip pending reason");
  button("Confirm trip").click(); await until(() => Number(requests.length) === 1, "trip flush");
  assert(requests[0].url.includes("/amex/lines/a"), "Whole trip escaped pending editor");
  requests[0].finish({ ok: true, receiptRevisions: {}, revision: 2, tripRevisions: { t: 4 } });
  await until(() => Number(requests.length) === 2, "whole trip after flush");
  assert(Number(requests[1].body.expectedRevision) === 4, "Trip did not consume own line-save context ack");
  assert((requests[1].body.expectedLines as Record<string, number>).a === 2, "Trip line token stale after own save");
  type(reason(), "trip in flight late typing"); await tick(500); assert(Number(requests.length) === 2, "Line write overlapped trip action");
  requests[1].finish({ ok: true, receiptRevisions: {}, revision: 6, lineRevisions: { a: 8 } });
  await until(() => Number(requests.length) === 3, "late draft after own trip ack");
  assert(Number(requests[2].body.expectedRevision) === 8 && requests[2].body.receiptMissingReason === "trip in flight late typing", "Late trip draft/token lost");
  requests[2].finish({ ok: true, receiptRevisions: {}, revision: 10, tripRevisions: { t: 8 } }); await tick();
  results.push("whole-trip action flushes lines, holds late edits, resumes with verified aggregate tokens");

  mount(false, true); await tick();
  button("Bulk confirm").click();
  await until(() => Number(requests.length) === 1, "bulk candidate admission");
  assert((requests[0].body.expectedReceipts as Record<string, number>).r === 3, "Bulk did not use loaded candidate receipt token");
  requests[0].finish({ ok: true, revision: 4, receiptRevisions: { r: 8 }, lineRevisions: {} });
  await until(() => Number(requests.length) === 2, "second consolidated candidate");
  assert((requests[1].body.expectedReceipts as Record<string, number>).r === 8, "Bulk did not consume own receipt acknowledgement");
  assert((requests[1].body.expectedLines as Record<string, number>).a === 4, "Consolidated sibling was not admitted with own line acknowledgement");
  requests[1].finish({ ok: true, revision: 6, receiptRevisions: { r: 12 }, lineRevisions: { a: 9 } }); await tick();
  click("a"); await until(() => selected("a"), "select consolidated sibling"); button("Unlink").click();
  await until(() => Number(requests.length) === 3, "unlink after bulk");
  assert(Number(requests[2].body.expectedRevision) === 9, "Sibling lane did not consume exact own batch token");
  assert((requests[2].body.expectedReceipts as Record<string, number>).r === 12, "Unlink lost previous affected receipt context");
  requests[2].finish({ ok: true, revision: 11, receiptRevisions: { r: 14 }, lineRevisions: { b: 10 } }); await tick();
  results.push("bulk consolidated candidates and later single unlink use loaded and own admitted receipt/line tokens");

  for (const malformed of [false, true]) {
    mount(false, true); await tick(); button("Confirm match").click();
    await until(() => Number(requests.length) === 1, "single candidate decision");
    assert((requests[0].body.expectedReceipts as Record<string, number>).r === 3, "Single match replaced loaded candidate token");
    requests[0].finish(malformed ? { ok: true, revision: 2, receiptRevisions: {} }
      : { error: "Candidate changed — reload to review", code: "amex_receipt_revision_conflict" }, malformed ? 200 : 409);
    await tick(); button("Confirm match").click(); await tick();
    assert(Number(requests.length) === 1, "Candidate failure automatically retried");
    assert(document.body.textContent?.includes("Reload to review"), "Candidate failure has no recovery action");
    results.push(`${malformed ? "malformed receipt acknowledgement" : "stale candidate"} halts single matching with loaded context retained`);
  }

  for (const failure of ["conflict", "missing", "malformed", "lost"] as const) {
    mount(); await tick(); type(reason(), "保持する最新の入力"); click("b");
    await until(() => Number(requests.length) === 1, `${failure} request`);
    if (failure === "lost") requests[0].drop();
    else requests[0].finish(failure === "malformed" ? { ok: true } : { error: "Changed — reload to review", code: "amex_line_revision_conflict" }, failure === "conflict" ? 409 : failure === "missing" ? 404 : 200);
    await tick(100); click("b"); await tick(100);
    assert(selected("a"), `${failure} navigated away`); assert(reason().value === "保持する最新の入力", `${failure} erased draft`);
    assert(Number(requests.length) === 1, `${failure} retried automatically`); assert(document.body.textContent?.includes("Reload to review"), `${failure} has no recovery action`);
    results.push(`${failure} retains draft and blocks navigation/automatic retries`);
  }
  return { pass: true, width: window.innerWidth, cases: results };
}
void run().then(result => {
  const out = document.createElement("pre"); out.id = "result"; out.textContent = JSON.stringify(result); document.body.appendChild(out);
}).catch(error => {
  const out = document.createElement("pre"); out.id = "result"; out.textContent = JSON.stringify({ pass: false, cases: results, error: String(error) }); document.body.appendChild(out);
});
