import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ReactElement, ReactNode } from "react";

// Exercise the actual client component's effect and rendering without adding a DOM dependency.
let states: unknown[] = [];
let cursor = 0;
let effect: (() => void | (() => void)) | undefined;
let fetchResponse: Response;
let fetchError = false;
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
// eslint-disable-next-line @typescript-eslint/no-require-imports
const react = require("react");
require.cache[require.resolve("react")] = { exports: {
  ...react,
  useState(initial: unknown) {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], (value: unknown) => { states[index] = value; }];
  },
  useEffect(callback: () => void | (() => void)) { effect = callback; },
} } as typeof require.cache[string];
require.cache[require.resolve("../../lib/receipts/keyboard")] = {
  exports: { useKeyboardShortcuts() {} },
} as typeof require.cache[string];
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ImagePane } = require("../../components/receipts/review/image-pane") as {
  ImagePane(props: { receiptId: string; receiptDisplayId: string; filename: string; fileSizeBytes: number; rawText: string | null }): ReactElement;
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  if (fetchError) throw new Error("Network down");
  return fetchResponse;
};
test.after(() => { globalThis.fetch = originalFetch; });
const props = { receiptId: "r1", receiptDisplayId: "R1", filename: "email.html", fileSizeBytes: 100, rawText: null as string | null };
function render(overrides: Partial<typeof props> = {}) {
  cursor = 0;
  return ImagePane({ ...props, ...overrides });
}
function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const el = node as ReactElement<{ children?: ReactNode }>;
  return [el as ReactElement<Record<string, unknown>>, ...elements(el.props?.children)];
}
async function preview(type: string, headers: Record<string, string> = {}, status = 200) {
  states = []; fetchCalls = []; fetchError = false;
  fetchResponse = new Response(null, { status, headers: { "content-type": type, ...headers } });
  const initial = render();
  assert.ok(elements(initial).some((el) => el.props.children === "Loading file preview…"));
  effect?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls[0].url, "/api/receipts/r1/file");
  assert.equal(fetchCalls[0].init?.method, "HEAD");
  assert.equal(fetchCalls[0].init?.cache, "no-store");
  return elements(render());
}

test("rendered email PDF is selected from the served HEAD MIME, not the original HTML filename", async () => {
  const nodes = await preview("Application/PDF; charset=binary");
  assert.ok(nodes.some((el) => el.type === "iframe" && el.props.src === "/api/receipts/r1/file"));
  assert.ok(!nodes.some((el) => el.props.alt === "Receipt R1"));
});

test("served raster image uses the same authorized endpoint; image load failure falls back to a link", async () => {
  const nodes = await preview("image/png");
  const image = nodes.find((el) => el.props.alt === "Receipt R1");
  assert.ok(image);
  assert.equal(image.props.src, "/api/receipts/r1/file");
  assert.equal(image.props.unoptimized, true);
  (image.props.onError as () => void)();
  assert.ok(elements(render()).some((el) => el.type === "a" && el.props.children === "Open file"));
  assert.ok(!elements(render()).some((el) => el.props.alt));
});

test("active/unknown/download-only files and HEAD errors never embed bytes", async () => {
  for (const [type, headers, status] of [
    ["", {}, 200], ["text/html", {}, 200], ["image/svg+xml", {}, 200], ["image/webp", {}, 200],
    ["application/pdf", { "content-disposition": "attachment; filename=receipt.pdf" }, 200],
    ["application/pdf", {}, 401], ["application/pdf", {}, 404], ["application/pdf", {}, 500],
  ] as Array<[string, Record<string, string>, number]>) {
    const nodes = await preview(type, headers, status);
    assert.ok(!nodes.some((el) => el.type === "iframe" || el.props.alt));
    assert.ok(nodes.some((el) => el.type === "a" && el.props.href === "/api/receipts/r1/file"));
  }
  states = []; fetchError = true;
  render(); effect?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!elements(render()).some((el) => el.type === "iframe" || el.props.alt));
});

test("navigation ignores the previous receipt's MIME and cancels its pending HEAD", async () => {
  await preview("application/pdf");
  const cleanup = effect?.();
  const nodes = elements(render({ receiptId: "r2" }));
  assert.ok(!nodes.some((el) => el.type === "iframe"));
  if (typeof cleanup === "function") cleanup();
  assert.equal(fetchCalls.at(-1)?.init?.signal?.aborted, true);
});

test("OCR decoration is absent; stored text uses an honest, plain-text disclosure", () => {
  const rawText = "<script>alert('OCR is untrusted')</script>\n領収書";
  const nodes = elements(render({ rawText }));
  assert.ok(nodes.some((el) => el.type === "summary" && el.props.children === "Raw extraction text (unverified)"));
  const text = nodes.find((el) => el.type === "pre");
  assert.equal(text?.props.children, rawText);
  assert.equal(text?.props.dangerouslySetInnerHTML, undefined);
  assert.ok(!elements(render()).some((el) => el.type === "details"));
  const source = readFileSync("components/receipts/review/image-pane.tsx", "utf8");
  assert.doesNotMatch(source, /showOverlay|OCR overlay|ocrOverlay|left-\[8%\]|bottom-\[14%\]/);
  const page = readFileSync("app/(receipt-system)/receipts/review/[id]/page.tsx", "utf8");
  assert.match(page, /typeof extraction\?\.rawText === "string"/);
  assert.match(page, /rawText=\{rawText\}/);
  assert.doesNotMatch(page, /contentType=\{receipt.original_content_type\}/);
});


test("a redirected HEAD response never selects an embedded viewer", async () => {
  states = []; fetchError = false;
  fetchResponse = new Response(null, { headers: { "content-type": "application/pdf" } });
  Object.defineProperty(fetchResponse, "redirected", { value: true });
  render(); effect?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!elements(render()).some((el) => el.type === "iframe" || el.props.alt));
});
