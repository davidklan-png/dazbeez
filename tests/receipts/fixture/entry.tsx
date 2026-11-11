// Standalone mounted-fixture entry for the review-save contract (round 4).
// Bundled by esbuild with next/link + next/navigation aliased to the shims
// beside this file, then loaded in a real browser. It mounts the REAL
// QueueControlsProvider + QueueRail + FormPane (production callbacks, hooks,
// timers and composition semantics — nothing reimplemented) with a recorded
// router and a manually-controlled fetch, auto-runs one scenario per
// cross-review blocker, and renders + exposes the results.
//
// Scenarios: B1 cached-clean-flush (edit-after-clean, failure-after-clean),
// B2 save-and-next drain/supersession (both competition orders), B3 unknown
// network outcome halt, B4 form replacement invalidating pending intents,
// B5 composition begun during a network await.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useReducer } from "react";
import { createRoot } from "react-dom/client";
import { FormPane } from "@/components/receipts/review/form-pane";
import { QueueRail } from "@/components/receipts/review/queue-rail";
import { QueueControlsProvider } from "@/components/receipts/review/queue-controls";
import type { ReceiptRecord, ReceiptStatus } from "@/lib/receipts/types";
import type { QueueItem } from "@/lib/receipts/queue-items";
import { navLog } from "./nav-shim";

// ─── fixtures ────────────────────────────────────────────────────────────

function makeReceipt(id: string, merchant: string): ReceiptRecord {
  return {
    id,
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

function makeItem(id: string, merchant: string): QueueItem {
  return {
    id,
    merchant,
    amountLabel: "¥4,200",
    dateLabel: "Nov 10",
    categoryLabel: "—",
    sortDateMs: Date.parse("2026-11-10T00:00:00Z"),
    sortAmountMinor: 4200,
    status: "captured" as ReceiptStatus,
    attentionCodes: [],
    stuck: false,
    extractionFailed: false,
    failureReason: null,
    locked: false,
    lockKind: null,
  };
}

const RECEIPT_A = makeReceipt("r-fixture-a", "Fixture Shokudo");
const RECEIPT_B = makeReceipt("r-fixture-b", "Fixture B");
const RECEIPT_C = makeReceipt("r-fixture-c", "Fixture C");
const RECEIPT_D = makeReceipt("r-fixture-d", "Fixture D");
const ITEMS = [
  makeItem(RECEIPT_A.id, RECEIPT_A.merchant ?? ""),
  makeItem(RECEIPT_C.id, RECEIPT_C.merchant ?? ""),
  makeItem(RECEIPT_D.id, RECEIPT_D.merchant ?? ""),
];

// ─── network mock (the ONLY thing mocked besides the router) ────────────

interface MockRequest {
  url: string;
  body: Record<string, unknown>;
  ok: (json?: unknown) => void;
  fail: (error: string) => void;
  failWith: (status: number, error: string) => void;
  okGarbled: () => void;
  drop: () => void;
}
const requests: MockRequest[] = [];
const requestLog: string[] = [];

function installFetchMock() {
  (window as any).fetch = (url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const isPatch = (init?.method ?? "GET") === "PATCH";
      requestLog.push(`${init?.method ?? "GET"} ${url}`);
      if (!isPatch) {
        // Attendee directory and any other GET: empty success.
        resolve(new Response('{"entries":[]}', { status: 200 }));
        return;
      }
      requests.push({
        url,
        body: JSON.parse(init!.body as string) as Record<string, unknown>,
        ok: (json = {}) =>
          resolve(new Response(JSON.stringify(json), { status: 200 })),
        fail: (error) =>
          resolve(
            new Response(JSON.stringify({ error }), { status: 422 }),
          ),
        failWith: (status, error) =>
          resolve(new Response(JSON.stringify({ error }), { status })),
        okGarbled: () => resolve(new Response("{{not-json", { status: 200 })),
        drop: () => reject(new TypeError("Simulated transport loss")),
      });
    });
}

// ─── tiny DOM/event helpers (drive the REAL component tree) ─────────────

const tick = () => new Promise<void>((r) => setTimeout(r, 20));

async function waitFor(cond: () => boolean, label: string, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await tick();
  }
  let merchantVal = "?";
  let bpVal = "?";
  try {
    merchantVal = inputByLabel("Merchant").value;
    bpVal = businessPurpose().value;
  } catch {
    /* inputs may be gone mid-swap */
  }
  throw new Error(
    `waitFor timeout: ${label} [requests=${requests.length} pushes=${pushCount()} badge="${badgeText().slice(0, 60)}" merchant="${merchantVal}" bp="${bpVal}"]`,
  );
}

function inputByLabel(text: string): HTMLInputElement {
  for (const label of Array.from(document.querySelectorAll("label"))) {
    const span = label.querySelector("span");
    if (span && span.textContent === text) {
      const input = label.querySelector("input, select");
      if (input) return input as HTMLInputElement;
    }
  }
  throw new Error(`input not found by label: ${text}`);
}

function buttonByText(text: string): HTMLButtonElement {
  for (const btn of Array.from(document.querySelectorAll("button"))) {
    if (btn.textContent?.includes(text)) return btn;
  }
  throw new Error(`button not found: ${text}`);
}

function railLink(receiptId: string): HTMLAnchorElement {
  const link = document.querySelector(
    `aside a[href*="${receiptId}"]`,
  ) as HTMLAnchorElement | null;
  if (!link) throw new Error(`rail link not found: ${receiptId}`);
  return link;
}

function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeMerchant(value: string) {
  setNativeValue(inputByLabel("Merchant"), value);
}

function businessPurpose(): HTMLInputElement {
  return inputByLabel("Business purpose");
}

function pressKey(key: string) {
  // Realistic focus: `s` is suppressed while typing in an input, so leave
  // the field first — exactly what the operator does before a shortcut.
  (document.activeElement as HTMLElement | null)?.blur();
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function badgeText(): string {
  const header = document.querySelector("header");
  return (header?.textContent ?? "").trim();
}

function resultsPanel(): HTMLElement {
  return document.getElementById("fixture-results")!;
}

// ─── scenario runner ─────────────────────────────────────────────────────

interface Result {
  name: string;
  pass: boolean;
  detail: string;
}
const results: Result[] = [];

function record(name: string, assertions: () => string) {
  try {
    const detail = assertions();
    results.push({ name, pass: true, detail });
  } catch (error) {
    results.push({
      name,
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

const pushCount = () => navLog.filter((l) => l.startsWith("push")).length;

async function runScenarios(swapReceipt: () => Promise<void>) {
  // S1 — B1: a CLEAN flush must not cache success over later state.
  let mark = pushCount();
  buttonByText("Skip").click();
  await tick();
  record("B1 clean nav sends no PATCH and pushes immediately", () => {
    assert(requests.length === 0, `unexpected PATCHes: ${requests.length}`);
    assert(pushCount() === mark + 1, "clean Skip did not push");
    return "0 PATCH, 1 push";
  });

  // edit AFTER the clean flush, then navigate — must actually save (the B1
  // bug would acknowledge from the cached clean promise and push unsaved).
  typeMerchant("m1");
  mark = pushCount();
  buttonByText("Skip").click();
  await tick();
  await waitFor(() => requests.length === 1, "S1 flush PATCH");
  record("B1 edit-after-clean navigates via a REAL flush", () => {
    assert(pushCount() === mark, "pushed before commit — not awaited");
    assert(requests[0].body.merchant === "m1", "PATCH did not carry the edit");
    return "PATCH pending with m1, no push yet";
  });
  requests[0].ok({});
  await waitFor(() => pushCount() === mark + 1, "S1 push after commit");
  results.push({ name: "B1 edit-after-clean pushes only after commit", pass: true, detail: "awaited" });

  // S2 — B1: a FAILED save, then navigation, must retry — not cached-success.
  typeMerchant("m2");
  mark = pushCount();
  buttonByText("Skip").click();
  await waitFor(() => requests.length === 2, "S2 first PATCH");
  requests[1].fail("Sealed fixture");
  await waitFor(() => badgeText().includes("Sealed fixture"), "S2 badge error");
  assert(pushCount() === mark, "S2 must not push on failure");
  buttonByText("Skip").click();
  await waitFor(() => requests.length === 3, "S2 retry PATCH");
  requests[2].ok({});
  await waitFor(() => pushCount() === mark + 1, "S2 push after retry");
  record("B1 failure-then-nav retries the save and stays until commit", () => {
    assert(requests[2].body.merchant === "m2", "retry lost the fields");
    return "retry PATCH carried m2, push after commit";
  });

  // S3 — B2: save-and-next drains edits made DURING the reviewed request.
  typeMerchant("m3");
  mark = pushCount();
  pressKey("s");
  await waitFor(() => requests.length === 4, "S3 reviewed PATCH");
  record("B2 reviewed rider rides the first save", () => {
    assert(requests[3].body.status === "reviewed", "no status rider");
    assert(requests[3].body.merchant === "m3", "wrong merchant snapshot");
    return "PATCH4 = m3 + status:reviewed";
  });
  typeMerchant("m4"); // edit WHILE the reviewed request is in flight
  requests[3].ok({});
  await waitFor(() => requests.length === 5, "S3 second drain PATCH");
  requests[4].ok({});
  await waitFor(() => pushCount() === mark + 1, "S3 push");
  record("B2 edits during the reviewed request are drained before navigating", () => {
    assert(requests[4].body.merchant === "m4", "in-flight edit not drained");
    assert(requests[4].body.status === undefined, "status re-sent needlessly");
    assert(navLog.some((l) => l.includes("/receipts/review/r-fixture-c")), "wrong target");
    return "PATCH5 = m4, then push to next receipt";
  });

  // S4a — B2 competition order 1: `s` first, rail link wins as newer intent.
  typeMerchant("m5");
  mark = pushCount();
  pressKey("s");
  await waitFor(() => requests.length === 6, "S4a reviewed PATCH");
  railLink(RECEIPT_D.id).click(); // newer intent, DIFFERENT target than s
  requests[5].ok({});
  await waitFor(() => pushCount() === mark + 1, "S4a push");
  record("B2 newer rail intent cancels the stale save-next target", () => {
    const last = navLog.filter((l) => l.startsWith("push")).slice(-1)[0];
    assert(last.split("?")[0].endsWith(RECEIPT_D.id), `expected rail-D push, got ${last}`);
    return `exactly one push (the newer rail target): ${last}`;
  });

  // S4b — B2 competition order 2: rail first, `s` wins as newer intent.
  typeMerchant("m6");
  mark = pushCount();
  railLink(RECEIPT_D.id).click();
  await waitFor(() => requests.length === 7, "S4b rail flush PATCH");
  pressKey("s"); // newer intent supersedes the rail target; its rider must
  // still be sent before ANY push — the flush loop drains it as its own pass.
  requests[6].ok({});
  await waitFor(() => requests.length === 8, "S4b rider drain PATCH");
  record("B2 late `s` rider is drained as its own commit", () => {
    assert(requests[7].body.status === "reviewed", "rider not drained");
    assert(pushCount() === mark, "pushed before the rider committed");
    return "PATCH8 carries status:reviewed, no push yet";
  });
  requests[7].ok({});
  await waitFor(() => pushCount() === mark + 1, "S4b push");
  record("B2 newer save-next intent cancels the stale rail target", () => {
    const last = navLog.filter((l) => l.startsWith("push")).slice(-1)[0];
    assert(last.split("?")[0].endsWith(RECEIPT_C.id), `expected save-next (C) push, got ${last}`);
    return `exactly one push (the save-next target): ${last}`;
  });

  // S5 — B5: composition STARTED while the navigation flush awaits network.
  setNativeValue(businessPurpose(), "pre-composition");
  mark = pushCount();
  buttonByText("Skip").click();
  await waitFor(() => requests.length === 9, "S5 flush PATCH");
  const bp = businessPurpose();
  bp.focus();
  bp.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  requests[8].ok({}); // response lands MID-COMPOSITION
  await tick();
  await tick();
  record("B5 mid-await composition holds navigation and UI updates", () => {
    assert(!badgeText().includes("Saved"), "badge updated during composition");
    assert(pushCount() === mark, "navigated during composition");
    return "no Saved badge, no push while composing";
  });
  setNativeValue(bp, "確定した値");
  bp.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await waitFor(() => requests.length === 10, "S5 committed-value PATCH");
  record("B5 committed DOM value is flushed after composition ends", () => {
    assert(requests[9].body.businessPurpose === "確定した値", "committed value not flushed");
    return "PATCH10 businessPurpose = 確定した値";
  });
  requests[9].ok({});
  await waitFor(() => pushCount() === mark + 1, "S5 push after commit");
  results.push({ name: "B5 navigation completes after the committed flush", pass: true, detail: "awaited" });

  // S6 — B4: form replacement invalidates the replaced form's pending intent.
  typeMerchant("mA");
  mark = pushCount();
  buttonByText("Skip").click();
  await waitFor(() => requests.length === 11, "S6 form-A PATCH");
  await swapReceipt(); // form A unmounts, form B mounts — A's flush unresolved
  requests[10].ok({}); // A's flush completes AFTER the replacement
  await tick();
  await tick();
  record("B4 replaced form's pending intent never pushes", () => {
    assert(pushCount() === mark, "stale push after form replacement");
    return "zero stale pushes";
  });
  typeMerchant("mB");
  buttonByText("Skip").click();
  await waitFor(() => requests.length === 12, "S6 form-B PATCH");
  requests[11].ok({});
  await waitFor(() => pushCount() === mark + 1, "S6 form-B push");
  record("B4 new form navigates normally after replacement", () => "push after B's commit");

  // S7 — B3: UNKNOWN outcome (transport loss) halts everything, honestly.
  typeMerchant("mHalted");
  mark = pushCount();
  buttonByText("Skip").click();
  await waitFor(() => requests.length === 13, "S7 PATCH");
  requests[12].drop();
  await waitFor(() => badgeText().includes("may or may not have reached"), "S7 halt badge");
  record("B3 unknown outcome surfaces guidance and stays", () => {
    assert(pushCount() === mark, "pushed after unknown outcome");
    return "halt guidance shown, no push";
  });
  typeMerchant("mStillHalted");
  buttonByText("Skip").click();
  await tick();
  await tick();
  record("B3 halted queue refuses further sends (no auto-resume)", () => {
    assert(requests.length === 13, "sent a request while halted");
    assert(pushCount() === mark, "navigated while halted");
    return "no further PATCH, no push, fields retained in the form";
  });
  const merchantNow = (inputByLabel("Merchant") as HTMLInputElement).value;
  record("B3 user fields retained after halt", () => {
    assert(merchantNow === "mStillHalted", `fields lost: ${merchantNow}`);
    return `merchant input still reads "${merchantNow}"`;
  });

  // S8 — response boundary: a 500 can FOLLOW a committed write (the route's
  // catch-all), so it is an UNKNOWN outcome: halt on a FRESH form.
  await swapReceipt(); // fresh form + fresh queue
  typeMerchant("m500");
  mark = pushCount();
  buttonByText("Skip").click();
  await waitFor(() => requests.length === 14, "S8 PATCH");
  requests[13].failWith(500, "audit write failed");
  await waitFor(() => badgeText().includes("may or may not have reached"), "S8 halt badge");
  typeMerchant("m500b");
  buttonByText("Skip").click();
  await tick();
  await tick();
  record("500-after-possible-write halts — no later send, no push, fields kept", () => {
    assert(requests.length === 14, "sent a request after an ambiguous 500");
    assert(pushCount() === mark, "navigated after an ambiguous 500");
    assert(
      (inputByLabel("Merchant") as HTMLInputElement).value === "m500b",
      "fields lost after 500",
    );
    return "halt guidance shown, queue frozen, fields retained";
  });

  // S9 — response boundary: a 200 whose body cannot be parsed is not a
  // usable acknowledgement: UNKNOWN, halt, on another fresh form.
  await swapReceipt();
  typeMerchant("mGarbled");
  mark = pushCount();
  buttonByText("Skip").click();
  await waitFor(() => requests.length === 15, "S9 PATCH");
  requests[14].okGarbled();
  await waitFor(() => badgeText().includes("may or may not have reached"), "S9 halt badge");
  record("malformed 200 ack halts — never acknowledged as saved", () => {
    assert(!badgeText().includes("Saved"), "false saved badge after garbled ack");
    assert(pushCount() === mark, "navigated on a garbled ack");
    return "halt guidance shown, no push";
  });
}

// ─── app shell ───────────────────────────────────────────────────────────

function FixtureApp() {
  const [receiptId, swap] = useReducer((id: string) =>
    id === RECEIPT_A.id ? RECEIPT_B.id : RECEIPT_A.id,
  RECEIPT_A.id,
  );
  const receipt = receiptId === RECEIPT_A.id ? RECEIPT_A : RECEIPT_B;
  return (
    <div>
      <button id="swap-receipt" onClick={swap} style={{ display: "none" }}>
        swap
      </button>
      <QueueControlsProvider
        items={ITEMS}
        activeId={receipt.id}
        queryParams="?month=2026-11"
      >
        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <div style={{ width: 280 }}>
            <QueueRail totalUnreviewed={1} totalCaptured={2} />
          </div>
          <div style={{ flex: 1, minWidth: 320 }}>
            <FormPane
              key={receipt.id}
              receipt={receipt}
              initialAttendees={[]}
              queueIndex={1}
              queueTotal={2}
              duplicatePartner={null}
              switchToMonth={null}
              nextReceiptId={RECEIPT_C.id}
              prevReceiptId={null}
              hasAmexMatch={false}
              reReviewNeeded={false}
              overrideTargetMonths={[]}
              naturalStatementMonth="2026-11"
            />
          </div>
        </div>
      </QueueControlsProvider>
      <pre id="fixture-results" style={{ marginTop: 12, fontSize: 12 }}>
        running…
      </pre>
    </div>
  );
}

installFetchMock();
const root = createRoot(document.getElementById("root")!);
// Deliberately NOT wrapped in StrictMode: its dev-only double-effect pass
// re-runs the autosave effect after the initial-render guard was consumed,
// arming a spurious mount debounce that production single-mount never has.
// This fixture exercises production mount semantics.
root.render(<FixtureApp />);

void (async () => {
  await tick();
  await tick();
  const swapReceipt = async () => {
    (document.getElementById("swap-receipt") as HTMLButtonElement).click();
    await tick();
    await tick();
  };
  let crashed = false;
  try {
    await runScenarios(swapReceipt);
  } catch (error) {
    crashed = true;
    results.push({
      name: "scenario runner",
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const pass = !crashed && results.every((r) => r.pass);
  (window as any).__RESULTS = { pass, results, navLog, requestLog };
  const lines = results.map(
    (r) => `${r.pass ? "PASS" : "FAIL"} — ${r.name} — ${r.detail}`,
  );
  resultsPanel().textContent =
    `${pass ? "ALL SCENARIOS PASS" : "FAILURES PRESENT"}\n` +
    lines.join("\n") +
    `\n\nnavLog:\n${navLog.join("\n")}\n\nrequests:\n${requestLog.join("\n")}`;
  document.title = pass ? "FIXTURE-PASS" : "FIXTURE-FAIL";
})();
