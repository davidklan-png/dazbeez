// Audit 2026-11-09, findings 1 + 7 — real handler tests for
// /api/receipts/[id]/file (GET and HEAD).
//
//   Finding 1 (P1): a promoted email body's raw HTML original was served
//   INLINE with no sandbox — hostile HTML opened by a signed-in operator
//   executes on the app origin with their session. Active-content/unknown
//   types must now download with a response-level sandbox CSP + nosniff;
//   safe PDF/image derivatives stay inline.
//   Finding 7 (P2): a Japanese original filename put raw non-ASCII into a
//   Headers value → TypeError → 500 on GET and HEAD (and the Mac consumer
//   burned retries). Filenames now go through the shared RFC 5987 helper.
//
// These invoke the ACTUAL route handlers. The route's collaborators (Clerk
// auth, D1 getReceiptRecord, R2 bucket) are swapped via require.cache entries
// installed before the route module is loaded — no experimental flags, works
// under the plain `tsx --test` suite. node:test runs each test file in its
// own process, so the cache swaps cannot leak into other files. The fakes
// read from a mutable `state` so one route load serves every scenario.
import test from "node:test";
import assert from "node:assert/strict";

type Fixture = {
  id: string;
  original_r2_key: string;
  extraction_r2_key: string | null;
  original_content_type: string;
  original_filename: string | null;
};

type FakeObject = {
  body?: ReadableStream<Uint8Array>;
  size: number;
  httpMetadata?: { contentType?: string };
};

const state: {
  receipt: Fixture | null;
  getObject: FakeObject | null;
  headObject: FakeObject | null;
  requestedKeys: string[];
  actorThrows: boolean;
} = {
  receipt: null,
  getObject: null,
  headObject: null,
  requestedKeys: [],
  actorThrows: false,
};

function installFake(spec: string, exports: Record<string, unknown>) {
  // Deliberate CJS cache swap — see file header.
  const resolved = require.resolve(spec);
  require.cache[resolved] = { exports } as typeof require.cache[string];
}

installFake("../../lib/receipts/auth", {
  requireReceiptsActor: async () => {
    if (state.actorThrows) {
      throw new Error("Unauthorized receipts request.");
    }
    return "operator@example.com";
  },
});
installFake("../../lib/cloudflare-runtime", {
  getReceiptsProcessorKey: () => "test-processor-key",
  getReceiptsBucket: () => ({
    get: async (key: string) => {
      state.requestedKeys.push(key);
      return state.getObject;
    },
    head: async (key: string) => {
      state.requestedKeys.push(key);
      return state.headObject;
    },
  }),
});
installFake("../../lib/receipts/db", {
  getReceiptRecord: async (id: string) =>
    state.receipt?.id === id ? state.receipt : null,
});

// Deliberate CJS require (after the fakes are in the cache) — see file header.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("../../app/api/receipts/[id]/file/route") as {
  GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  HEAD: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
};

const HTML = "<html><script>fetch('/api/receipts', {credentials:'include'})</script></html>";
const htmlBytes = new TextEncoder().encode(HTML);

function configure(fixture: Partial<Fixture>, object: FakeObject | null, head?: FakeObject | null) {
  state.receipt = {
    id: "r1",
    original_r2_key: "receipts/r1-original",
    extraction_r2_key: null,
    original_content_type: "text/html",
    original_filename: "email-body.html",
    ...fixture,
  };
  state.getObject = object;
  state.headObject = head ?? object;
  state.requestedKeys = [];
  state.actorThrows = false;
}

function request(opts: { processor?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.processor) headers["x-receipts-processor-key"] = "test-processor-key";
  return new Request("http://app/api/receipts/r1/file", { headers });
}

const ctx = { params: Promise.resolve({ id: "r1" }) };

function assertActiveContentResponse(res: Response) {
  assert.equal(res.status, 200);
  assert.ok(
    res.headers.get("content-disposition")?.startsWith("attachment"),
    `active content downloads, got: ${res.headers.get("content-disposition")}`,
  );
  assert.equal(
    res.headers.get("content-security-policy"),
    "sandbox",
    "response-level sandbox CSP",
  );
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
}

function assertInlineResponse(res: Response) {
  assert.equal(res.status, 200);
  assert.ok(
    res.headers.get("content-disposition")?.startsWith("inline"),
    `safe type renders inline, got: ${res.headers.get("content-disposition")}`,
  );
  assert.equal(res.headers.get("content-security-policy"), null, "no sandbox on passive types");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
}

// ─── Finding 1: hostile HTML original (before/after failed rendering) ────────

test("GET hostile HTML original: attachment + sandbox + nosniff, bytes preserved", async () => {
  configure(
    { original_content_type: "text/html", original_filename: "email-body.html" },
    { body: streamOf(htmlBytes), size: htmlBytes.byteLength, httpMetadata: { contentType: "text/html" } },
  );
  const res = await route.GET(request(), ctx);
  assertActiveContentResponse(res);
  assert.equal(res.headers.get("content-type"), "text/html");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="email-body.html"');
  // Raw evidence: the exact original bytes come back — no sanitizing.
  assert.equal(await res.text(), HTML);
});

test("HEAD hostile HTML original: same policy as GET", async () => {
  configure(
    { original_content_type: "text/html" },
    null,
    { size: htmlBytes.byteLength, httpMetadata: { contentType: "text/html" } },
  );
  const res = await route.HEAD(request(), ctx);
  assertActiveContentResponse(res);
  assert.equal(res.headers.get("content-type"), "text/html");
});

test("SVG original (active image type): downloads sandboxed", async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  configure(
    { original_content_type: "image/svg+xml", original_filename: "x.svg" },
    { body: streamOf(svg), size: svg.byteLength, httpMetadata: { contentType: "image/svg+xml" } },
  );
  const res = await route.GET(request(), ctx);
  assertActiveContentResponse(res);
});

test("unknown content type original: fail-closed download", async () => {
  configure(
    { original_content_type: "application/octet-stream", original_filename: "blob.bin" },
    { body: streamOf(new Uint8Array([1, 2])), size: 2, httpMetadata: { contentType: "application/octet-stream" } },
  );
  const res = await route.GET(request(), ctx);
  assertActiveContentResponse(res);
});

test("unknown image/* original (allowlist miss): GET and HEAD fail-closed download", async () => {
  // Cross-review 2026-11-10 finding 3: the old image/* wildcard (minus svg)
  // served an unregistered image MIME inline with no sandbox. Only the four
  // raster types the pipeline actually stores pass the allowlist.
  const bytes = new TextEncoder().encode("not-really-an-image");
  configure(
    { original_content_type: "image/x-unregistered-receipt", original_filename: "odd.img" },
    { body: streamOf(bytes), size: bytes.byteLength, httpMetadata: { contentType: "image/x-unregistered-receipt" } },
    { size: bytes.byteLength, httpMetadata: { contentType: "image/x-unregistered-receipt" } },
  );
  const get = await route.GET(request(), ctx);
  assertActiveContentResponse(get);
  assert.equal(get.headers.get("content-type"), "image/x-unregistered-receipt");
  const head = await route.HEAD(request(), ctx);
  assertActiveContentResponse(head);
});

// ─── Finding 1: safe PDF/image originals and derivatives stay inline ─────────

test("uploaded PDF original (no derivative): inline, served type preserved", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 fake");
  configure(
    { original_content_type: "application/pdf", original_filename: "receipt.pdf" },
    { body: streamOf(pdf), size: pdf.byteLength, httpMetadata: { contentType: "application/pdf" } },
  );
  const res = await route.GET(request(), ctx);
  assertInlineResponse(res);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), 'inline; filename="receipt.pdf"');
});

test("uploaded JPEG original: inline", async () => {
  const jpg = new TextEncoder().encode("\xFF\xD8\xFF fake");
  configure(
    { original_content_type: "image/jpeg", original_filename: "photo.jpg" },
    { body: streamOf(jpg), size: jpg.byteLength, httpMetadata: { contentType: "image/jpeg" } },
  );
  const res = await route.GET(request(), ctx);
  assertInlineResponse(res);
});

test("uploaded HEIC original (allowlisted raster): inline", async () => {
  const heic = new TextEncoder().encode("fake-heic-bytes");
  configure(
    { original_content_type: "image/heic", original_filename: "IMG_0001.heic" },
    { body: streamOf(heic), size: heic.byteLength, httpMetadata: { contentType: "image/heic" } },
  );
  const res = await route.GET(request(), ctx);
  assertInlineResponse(res);
  assert.equal(res.headers.get("content-type"), "image/heic");
});

test("text/plain original (promoted text-only email body): inline", async () => {
  const txt = new TextEncoder().encode("receipt text");
  configure(
    { original_content_type: "text/plain", original_filename: "email-body.txt" },
    { body: streamOf(txt), size: txt.byteLength, httpMetadata: { contentType: "text/plain" } },
  );
  const res = await route.GET(request(), ctx);
  assertInlineResponse(res);
});

test("rendered derivative selected and served inline, not the hostile original", async () => {
  const png = new TextEncoder().encode("fake-png-bytes");
  configure(
    {
      extraction_r2_key: "receipts/r1-rendered.png",
      original_content_type: "text/html",
      original_filename: "email-body.html",
    },
    { body: streamOf(png), size: png.byteLength, httpMetadata: { contentType: "image/png" } },
  );
  const res = await route.GET(request(), ctx);
  assert.deepEqual(state.requestedKeys, ["receipts/r1-rendered.png"], "derivative key requested");
  assertInlineResponse(res);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(await res.text(), "fake-png-bytes");
});

test("derivative whose R2 metadata lost its content type: fail-closed download", async () => {
  // extraction_r2_key set but httpMetadata.contentType missing → falls back to
  // the original text/html → policy keys off the SERVED type, so it downloads.
  const png = new TextEncoder().encode("fake-png-bytes");
  configure(
    { extraction_r2_key: "receipts/r1-rendered.png", original_content_type: "text/html" },
    { body: streamOf(png), size: png.byteLength },
  );
  const res = await route.GET(request(), ctx);
  assertActiveContentResponse(res);
});

// ─── Finding 7: Unicode / missing / hostile filenames (GET and HEAD) ─────────

test("Japanese filename: GET and HEAD return 200 with RFC 5987 filename*", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 fake");
  configure(
    { original_content_type: "application/pdf", original_filename: "領収書.pdf" },
    { body: streamOf(pdf), size: pdf.byteLength, httpMetadata: { contentType: "application/pdf" } },
    { size: pdf.byteLength, httpMetadata: { contentType: "application/pdf" } },
  );
  const get = await route.GET(request(), ctx);
  assert.equal(get.status, 200, "GET must not 500 on non-ASCII filename");
  const head = await route.HEAD(request(), ctx);
  assert.equal(head.status, 200, "HEAD must not 500 on non-ASCII filename");

  const cd = get.headers.get("content-disposition");
  assert.ok(cd?.startsWith("inline; filename=\""), `ASCII fallback present: ${cd}`);
  const star = cd?.slice(cd.indexOf("filename*=UTF-8''") + "filename*=UTF-8''".length);
  assert.equal(decodeURIComponent(star ?? ""), "領収書.pdf", "filename* decodes to the original name");
  assert.equal(head.headers.get("content-disposition"), cd, "GET/HEAD agree");
});

test("missing filename falls back to \"receipt\"", async () => {
  configure(
    { original_content_type: "text/html", original_filename: null },
    { body: streamOf(htmlBytes), size: htmlBytes.byteLength },
  );
  const res = await route.GET(request(), ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="receipt"');
});

test("embedded double quotes are stripped from the filename parameter", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 fake");
  configure(
    { original_content_type: "application/pdf", original_filename: 'say_"hello".pdf' },
    { body: streamOf(pdf), size: pdf.byteLength },
  );
  const res = await route.GET(request(), ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-disposition"), 'inline; filename="say_hello.pdf"');
});

test("oversized filename is capped, not a header bomb", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 fake");
  configure(
    { original_content_type: "application/pdf", original_filename: "a".repeat(5000) + ".pdf" },
    { body: streamOf(pdf), size: pdf.byteLength },
  );
  const res = await route.GET(request(), ctx);
  assert.equal(res.status, 200);
  const param = res.headers.get("content-disposition")?.match(/filename="(.*)"/)?.[1] ?? "";
  assert.ok(param.length <= 200, `capped at 200, got ${param.length}`);
});

// Cross-review 2026-11-10 finding 1: the cap must truncate by code point.
// "a"×199 + "𠮷.pdf" — a UTF-16 slice at 200 kept only the HIGH surrogate of
// 𠮷, and encodeURIComponent(lone surrogate) threw URIError → 500 on GET,
// HEAD, and the processor path.
test("cap lands on a supplementary-plane character: no split surrogate, no 500", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 fake");
  const boundary = "a".repeat(199) + "𠮷.pdf";
  const expected = "a".repeat(199) + "𠮷"; // cap keeps the full code point, drops ".pdf"
  configure(
    { original_content_type: "application/pdf", original_filename: boundary },
    { body: streamOf(pdf), size: pdf.byteLength, httpMetadata: { contentType: "application/pdf" } },
    { size: pdf.byteLength, httpMetadata: { contentType: "application/pdf" } },
  );
  const get = await route.GET(request(), ctx);
  assert.equal(get.status, 200, "GET must not 500 when the cap hits a surrogate pair");
  const head = await route.HEAD(request(), ctx);
  assert.equal(head.status, 200, "HEAD must not 500 when the cap hits a surrogate pair");

  const cd = get.headers.get("content-disposition");
  const star = cd?.slice(cd.indexOf("filename*=UTF-8''") + "filename*=UTF-8''".length);
  assert.equal(decodeURIComponent(star ?? ""), expected, "filename* carries the intact code point");
  assert.equal(head.headers.get("content-disposition"), cd, "GET/HEAD agree");

  state.actorThrows = true; // the processor must still reach the bytes
  const processor = await route.GET(request({ processor: true }), ctx);
  assert.equal(processor.status, 200, "processor-key access must not 500 on the boundary name");
  assert.equal(await processor.text(), "%PDF-1.4 fake");
});

// Cross-review 2026-11-10 finding 2: the cap can leave a trailing backslash
// ("a"×199 + "\.pdf" → 200 code points ending in `\`), which used to escape
// the generated closing quote into an unterminated quoted-string.
test("cap leaves a trailing backslash: quoted-string stays terminated", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 fake");
  configure(
    { original_content_type: "application/pdf", original_filename: "a".repeat(199) + "\\.pdf" },
    { body: streamOf(pdf), size: pdf.byteLength, httpMetadata: { contentType: "application/pdf" } },
    { size: pdf.byteLength, httpMetadata: { contentType: "application/pdf" } },
  );
  const get = await route.GET(request(), ctx);
  assert.equal(get.status, 200);
  assert.equal(
    get.headers.get("content-disposition"),
    `inline; filename="${"a".repeat(199)}"`,
    "backslash stripped, closing quote terminates the parameter",
  );
  const head = await route.HEAD(request(), ctx);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-disposition"), get.headers.get("content-disposition"));
});

// ─── Authorization and processor byte access stay intact ──────────────────────

test("no session and no processor key: 401 on GET and HEAD", async () => {
  configure(
    {},
    { body: streamOf(htmlBytes), size: htmlBytes.byteLength },
  );
  state.actorThrows = true;
  const get = await route.GET(request(), ctx);
  assert.equal(get.status, 401);
  const head = await route.HEAD(request(), ctx);
  assert.equal(head.status, 401);
});

test("processor key bypasses Clerk and still receives the original bytes", async () => {
  configure(
    { original_content_type: "text/html", original_filename: "email-body.html" },
    { body: streamOf(htmlBytes), size: htmlBytes.byteLength },
  );
  state.actorThrows = true; // would 401 without the processor key
  const res = await route.GET(request({ processor: true }), ctx);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), HTML, "Mac consumer gets the exact original bytes");
  assert.ok(
    res.headers.get("content-disposition")?.startsWith("attachment"),
    "headers change, bytes do not",
  );
});

// Reviewer matrix (cross-review 2026-11-10 suggestion 3): pin the remaining
// processor/auth permutations and PDF-derivative parity, reusing the fixtures.

test("processor key on HEAD bypasses Clerk with the same headers as GET", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 fake");
  configure(
    { original_content_type: "application/pdf", original_filename: "receipt.pdf" },
    { body: streamOf(pdf), size: pdf.byteLength },
    { size: pdf.byteLength },
  );
  state.actorThrows = true;
  const head = await route.HEAD(request({ processor: true }), ctx);
  assert.equal(head.status, 200, "valid processor key must satisfy HEAD without a session");
  const get = await route.GET(request({ processor: true }), ctx);
  assert.equal(head.headers.get("content-disposition"), get.headers.get("content-disposition"));
});

test("wrong processor key is rejected like a missing one", async () => {
  configure(
    {},
    { body: streamOf(htmlBytes), size: htmlBytes.byteLength },
  );
  state.actorThrows = true; // no Clerk session either
  const bad = new Request("http://app/api/receipts/r1/file", {
    headers: { "x-receipts-processor-key": "not-the-key" },
  });
  assert.equal((await route.GET(bad, ctx)).status, 401, "wrong key GET");
  assert.equal((await route.HEAD(bad, ctx)).status, 401, "wrong key HEAD");
});

test("PDF derivative serves inline on GET and HEAD with the same headers", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 rendered");
  configure(
    {
      extraction_r2_key: "receipts/r1-rendered.pdf",
      original_content_type: "text/html",
      original_filename: "email-body.html",
    },
    { body: streamOf(pdf), size: pdf.byteLength, httpMetadata: { contentType: "application/pdf" } },
    { size: pdf.byteLength, httpMetadata: { contentType: "application/pdf" } },
  );
  const get = await route.GET(request(), ctx);
  assertInlineResponse(get);
  assert.equal(get.headers.get("content-type"), "application/pdf");
  const head = await route.HEAD(request(), ctx);
  assertInlineResponse(head);
  assert.equal(head.headers.get("content-type"), "application/pdf");
  assert.deepEqual(state.requestedKeys, [
    "receipts/r1-rendered.pdf",
    "receipts/r1-rendered.pdf",
  ], "both methods fetch the derivative key");
  assert.equal(
    head.headers.get("content-disposition"),
    get.headers.get("content-disposition"),
    "GET/HEAD parity",
  );
});

test("unknown receipt id: 404; missing R2 object: 404", async () => {
  configure({}, null); // receipt row exists, R2 object does not
  const missingObject = await route.GET(request(), ctx);
  assert.equal(missingObject.status, 404);
  state.getObject = { body: streamOf(htmlBytes), size: htmlBytes.byteLength };
  const ok = await route.GET(request(), ctx);
  assert.equal(ok.status, 200);
  state.getObject = null;
  const missingReceipt = await route.GET(request(), { params: Promise.resolve({ id: "nope" }) });
  assert.equal(missingReceipt.status, 404);
});

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
