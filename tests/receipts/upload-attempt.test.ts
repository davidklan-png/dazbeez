import assert from "node:assert/strict";
import { afterEach, before, mock, test } from "node:test";

let normalizations = 0;
let normalize = async (file: File) => new File([await file.arrayBuffer(), " normalized"], "normalized.jpg", { type: "image/jpeg" });
mock.module("@/lib/receipts/client-image", { namedExports: { maybeResizeImage: (file: File) => { normalizations++; return normalize(file); } } });
let UploadAttempt: typeof import("@/lib/receipts/upload-attempt").UploadAttempt;
before(async () => { ({ UploadAttempt } = await import("@/lib/receipts/upload-attempt")); });
type Phase = import("@/lib/receipts/upload-attempt").CapturePhase;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; normalizations = 0; });
const photo = () => new File(["original photo"], "photo.jpg", { type: "image/jpeg" });
const saved = () => Response.json({ receiptId: "receipt-1", reviewUrl: "/receipts/review/receipt-1" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function fingerprint(fd: FormData) {
  const file = fd.get("file") as File;
  return { bytes: await file.text(), filename: file.name, type: file.type,
    key: fd.get("client_capture_id"), payment: fd.get("paymentPath"), source: fd.get("source") };
}

test("lost acknowledgement after commit retries identical normalized bytes/key/metadata and returns one receipt", async () => {
  const requests: Awaited<ReturnType<typeof fingerprint>>[] = [];
  const committed = new Map<string, string>();
  globalThis.fetch = async (_url, init) => {
    const request = await fingerprint(init!.body as FormData);
    requests.push(request);
    committed.set(String(request.key), "receipt-1");
    if (requests.length === 1) throw new TypeError("Connection lost after commit");
    return saved();
  };
  const phases: Phase[] = [];
  const attempt = new UploadAttempt(photo(), "CASH", "mobile_capture", "fixed-key");
  assert.equal((await attempt.run((p) => phases.push(p))).ok, false);
  const result = await attempt.run((p) => phases.push(p));
  assert.deepEqual(result, { ok: true, receiptId: "receipt-1", reviewUrl: "/receipts/review/receipt-1" });
  assert.deepEqual(requests[0], { bytes: "original photo normalized", filename: "normalized.jpg", type: "image/jpeg", key: "fixed-key", payment: "CASH", source: "mobile_capture" });
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(committed.size, 1);
  assert.equal(normalizations, 1);
  assert.equal(phases.at(-1)?.kind, "saved");
  assert.equal((await attempt.run(() => assert.fail("success released bytes"))).ok, false);
});

test("cancel then retry ignores late response and old finalizer cannot release the retry gate", async () => {
  const first = deferred<Response>(); const second = deferred<Response>();
  const started = deferred<void>(); const retryStarted = deferred<void>();
  let calls = 0; let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    if (++calls === 1) { signal = init!.signal as AbortSignal; started.resolve(); return first.promise; }
    retryStarted.resolve(); return second.promise;
  };
  const attempt = new UploadAttempt(photo(), "AMEX", "mobile_capture", "key");
  const phases: Phase[] = [];
  const initial = attempt.run((p) => phases.push(p));
  await started.promise;
  attempt.cancel();
  assert.equal(signal?.aborted, true);
  const retry = attempt.run((p) => phases.push(p));
  await retryStarted.promise;
  const beforeLate = phases.length;
  first.resolve(saved());
  assert.equal((await initial).ok, false);
  assert.equal(phases.length, beforeLate);
  assert.equal((await attempt.run(() => assert.fail("double retry"))).ok, false);
  assert.equal(calls, 2);
  second.resolve(saved());
  assert.equal((await retry).ok, true);
  assert.equal(normalizations, 1);
});

test("discard while normalizing ignores late progress and retake uses a fresh identity", async () => {
  const previous = normalize;
  const resized = deferred<File>();
  normalize = () => resized.promise;
  try {
    const phases: Phase[] = [];
    const attempt = new UploadAttempt(photo(), null, "mobile_capture", "old-key");
    const pending = attempt.run((p) => phases.push(p));
    attempt.dispose();
    const requests: FormData[] = [];
    globalThis.fetch = async (_url, init) => { requests.push(init!.body as FormData); return saved(); };
    resized.resolve(photo());
    assert.equal((await pending).ok, false);
    assert.equal(phases.length, 1);
    assert.equal(requests.length, 0);
    normalize = previous;
    const retake = new UploadAttempt(photo(), "CASH", "mobile_capture", "new-key");
    assert.equal((await retake.run(() => {})).ok, true);
    assert.equal(requests[0].get("client_capture_id"), "new-key");
  } finally { normalize = previous; }
});

test("discard/unmount during response parsing suppresses stale success and errors", async () => {
  for (const reject of [false, true]) {
    const parsed = deferred<{receiptId: string}>();
    const parsing = deferred<void>();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: () => { parsing.resolve(); return parsed.promise; } }) as Response;
    const phases: Phase[] = [];
    const attempt = new UploadAttempt(photo(), null, "mobile_capture", "old-key");
    const pending = attempt.run((p) => phases.push(p));
    await parsing.promise;
    attempt.dispose();
    if (reject) parsed.resolve({ receiptId: "" }); else parsed.resolve({ receiptId: "stale" });
    assert.equal((await pending).ok, false);
    assert.equal(phases.at(-1)?.kind, "uploading");
  }
});

test("double tap starts only one request", async () => {
  const response = deferred<Response>(); let calls = 0;
  globalThis.fetch = async () => { calls++; return response.promise; };
  const attempt = new UploadAttempt(photo(), null, "mobile_capture", "key");
  const first = attempt.run(() => {});
  assert.equal((await attempt.run(() => assert.fail("overlap"))).ok, false);
  response.resolve(saved());
  assert.equal((await first).ok, true);
  assert.equal(calls, 1);
});

for (const status of [401, 403, 400, 409, 413, 503]) {
  test(`HTTP ${status} retains request and explains recovery`, async () => {
    const bodies: FormData[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(init!.body as FormData);
      return bodies.length === 1 ? Response.json({ error: "Server explanation" }, { status }) : saved();
    };
    const attempt = new UploadAttempt(photo(), null, "mobile_capture", "key");
    const first = await attempt.run(() => {});
    assert.equal(first.ok, false);
    if (!first.ok) assert.match(first.message, status === 401 || status === 403 ? /Sign in in another tab/ : /Server explanation.*Retry/);
    assert.equal((await attempt.run(() => {})).ok, true);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(normalizations, 1);
  });
}

test("unconfirmed malformed success retains photo for retry", async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response("not json") : saved();
  const attempt = new UploadAttempt(photo(), null, "mobile_capture", "key");
  assert.equal((await attempt.run(() => {})).ok, false);
  assert.equal((await attempt.run(() => {})).ok, true);
  assert.equal(normalizations, 1);
});

test("hook keeps desktop outcomes out of mobile retry state and unmount aborts a retry", async () => {
  const phases: Phase[] = [];
  const cleanups: (() => void)[] = [];
  const react = mock.module("react", { namedExports: {
    useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => [value, (phase: Phase) => phases.push(phase)],
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => () => void) => cleanups.push(effect()),
  } });
  try {
    const { useReceiptUpload } = await import("@/components/receipts/capture/use-receipt-upload");
    const hook = useReceiptUpload();
    globalThis.fetch = async () => Response.json({ error: "Temporary" }, { status: 503 });
    assert.equal((await hook.upload(photo(), "CASH", "mobile_capture")).ok, false);
    const failedPhase = phases.at(-1);
    globalThis.fetch = async () => saved();
    assert.equal((await hook.upload(photo(), "AMEX", "desktop_upload")).ok, true);
    assert.equal(phases.at(-1), failedPhase);

    const started = deferred<void>(); const response = deferred<Response>();
    let signal: AbortSignal | undefined;
    globalThis.fetch = async (_url, init) => { signal = init!.signal as AbortSignal; started.resolve(); return response.promise; };
    const retry = hook.retry();
    await started.promise;
    const beforeUnmount = phases.length;
    cleanups[0]();
    assert.equal(signal?.aborted, true);
    response.resolve(saved());
    assert.equal((await retry).ok, false);
    assert.equal(phases.length, beforeUnmount);
    assert.equal((await hook.retry()).ok, false);
  } finally { react.restore(); }
});
