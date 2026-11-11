import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SaveQueue, type SaveFetch } from "@/lib/receipts/save-queue";

// ─── controlled deferred fetch ──────────────────────────────────────────
// Every request is a manually-resolved promise so tests decide exactly when
// a save "lands" — the ordering contract is what's under test.

interface DeferredCall {
  init: RequestInit;
  /** Complete the request successfully (default) with a JSON body. */
  ok: (json?: unknown) => void;
  /** Complete the request with an HTTP error status + JSON error body. */
  fail: (error: string) => void;
  /** Simulate a network-level failure (fetch rejects). */
  drop: () => void;
}

function makeDeferredFetch() {
  const calls: DeferredCall[] = [];
  const fetchImpl: SaveFetch = (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      calls.push({
        init,
        ok: (json = {}) =>
          resolve(
            new Response(JSON.stringify(json), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        fail: (error) =>
          resolve(
            new Response(JSON.stringify({ error }), {
              status: 422,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        drop: () => reject(new TypeError("Network request failed")),
      });
    });
  return { calls, fetchImpl };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function bodyOf(call: DeferredCall): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

// ─── queue behavior ──────────────────────────────────────────────────────

test("SaveQueue: strictly serializes — nothing fires until the previous commit", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({ url: "/r", buildBody: () => ({}), fetchImpl });

  const p1 = q.save();
  const p2 = q.save();
  await tick();

  // Earlier snapshot must COMMIT before the later save is even sent —
  // this is the invariant the old abort-and-refire pattern broke.
  assert.equal(calls.length, 1);
  assert.equal(q.idle, false);

  calls[0]!.ok();
  await tick();
  assert.equal(calls.length, 2);

  calls[1]!.ok();
  await Promise.all([p1, p2]);
  assert.equal(q.idle, true);
});

test("SaveQueue: coalesces concurrent saves into one flush, never dropping a waiter", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({ url: "/r", buildBody: () => ({}), fetchImpl });

  const p1 = q.save();
  await tick(); // request 1 in flight
  const p2 = q.save();
  const p3 = q.save();
  const p4 = q.save();
  await tick();
  assert.equal(calls.length, 1); // still just request 1

  calls[0]!.ok();
  await tick();
  assert.equal(calls.length, 2); // ONE coalesced flush, not three

  calls[1]!.ok();
  const results = await Promise.all([p1, p2, p3, p4]);
  assert.equal(results.length, 4);
});

test("SaveQueue: coalesced flush carries the LATEST snapshot at fire time", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  let merchant = "old-value";
  const q = new SaveQueue({
    url: "/r",
    buildBody: () => ({ merchant }),
    fetchImpl,
  });

  const p1 = q.save();
  await tick();
  assert.equal(bodyOf(calls[0]!).merchant, "old-value");

  // Edits made while request 1 is in flight must not be lost to the
  // already-sent older snapshot.
  merchant = "latest-value";
  const p2 = q.save();
  calls[0]!.ok();
  await tick();

  assert.equal(bodyOf(calls[1]!).merchant, "latest-value");
  calls[1]!.ok();
  await Promise.all([p1, p2]);
});

test("SaveQueue: markReviewed waits for the flush carrying its rider, then resolves", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const builtWithRider: boolean[] = [];
  const q = new SaveQueue({
    url: "/r",
    buildBody: (markReviewed) => {
      builtWithRider.push(markReviewed);
      return markReviewed ? { status: "reviewed" } : {};
    },
    fetchImpl,
  });

  const p1 = q.save(); // plain autosave first
  await tick();
  const p2 = q.save(true); // save-and-next while autosave in flight
  calls[0]!.ok(); // autosave commits
  await tick();

  // The flush fired WITH the rider, after the autosave committed.
  assert.equal(calls.length, 2);
  assert.deepEqual(builtWithRider, [false, true]);
  assert.equal(bodyOf(calls[1]!).status, "reviewed");

  // p2 must not resolve until ITS flush commits.
  let resolved = false;
  void p2.then(() => {
    resolved = true;
  });
  await tick();
  assert.equal(resolved, false);

  calls[1]!.ok();
  await p2;
  assert.equal(resolved, true);
  await p1;
});

test("SaveQueue: markReviewed rider is sticky across later coalesced autosaves", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  let riderSeen: boolean | undefined;
  const q = new SaveQueue({
    url: "/r",
    buildBody: (markReviewed) => {
      riderSeen = markReviewed;
      return {};
    },
    fetchImpl,
  });

  const p1 = q.save();
  await tick();
  const pReview = q.save(true);
  const pLate = q.save(false); // operator typed again before the flush fired
  calls[0]!.ok();
  await tick();

  // The flush still promotes — a late plain autosave must not strip the
  // rider the save-and-next is waiting on.
  assert.equal(riderSeen, true);
  assert.equal(calls.length, 2);
  calls[1]!.ok();
  await Promise.all([p1, pReview, pLate]);
});

test("SaveQueue: failed flush rejects its waiters with the server error and the queue recovers", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({ url: "/r", buildBody: () => ({}), fetchImpl });

  const p1 = q.save();
  await tick();
  calls[0]!.ok();
  await p1;

  const p2 = q.save();
  await tick();
  calls[1]!.fail("Receipt is sealed");
  await assert.rejects(p2, /Receipt is sealed/);

  // Next save starts fresh.
  const p3 = q.save();
  await tick();
  assert.equal(calls.length, 3);
  calls[2]!.ok();
  await p3;
});

test("SaveQueue: network failure rejects with 'Network error'", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({ url: "/r", buildBody: () => ({}), fetchImpl });

  const p = q.save();
  await tick();
  calls[0]!.drop();
  await assert.rejects(p, /Network error/);
});

test("SaveQueue: deferFire holds the pending flush until the next save re-drains", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  let composing = false;
  const q = new SaveQueue({
    url: "/r",
    buildBody: () => ({}),
    deferFire: () => composing,
    fetchImpl,
  });

  const p1 = q.save();
  await tick();
  composing = true; // composition begins while request 1 is in flight
  calls[0]!.ok();
  await tick();
  assert.equal(calls.length, 1); // pending flush held

  composing = false; // composition end re-arms the save
  const p2 = q.save();
  await tick();
  assert.equal(calls.length, 2);
  calls[1]!.ok();
  await Promise.all([p1, p2]);
});

test("SaveQueue: lastFailed tracks the newest flush outcome for retry decisions", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({ url: "/r", buildBody: () => ({}), fetchImpl });
  assert.equal(q.lastFailed, false);

  const pFail = q.save();
  await tick();
  calls[0]!.fail("boom");
  await assert.rejects(pFail, /boom/);
  assert.equal(q.lastFailed, true); // edits that failed must stay re-flushable

  const pOk = q.save();
  await tick();
  calls[1]!.ok();
  await pOk;
  assert.equal(q.lastFailed, false);
});

test("SaveQueue: rebind swaps the builder so later flushes carry the new fields", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({
    url: "/r",
    buildBody: () => ({ merchant: "first-render" }),
    fetchImpl,
  });

  const p1 = q.save();
  await tick();
  assert.equal(bodyOf(calls[0]!).merchant, "first-render");

  // The form re-renders (fields changed) and rebinds a fresh closure.
  q.rebind({
    url: "/r",
    buildBody: () => ({ merchant: "next-render" }),
    fetchImpl,
  });
  const p2 = q.save();
  calls[0]!.ok();
  await tick();
  assert.equal(bodyOf(calls[1]!).merchant, "next-render");
  calls[1]!.ok();
  await Promise.all([p1, p2]);
});

// ─── integration wiring (source-structure, repo convention: the React
// lifecycle itself is not unit-testable without a DOM harness — pin the
// wiring that connects form-pane to the queue contract) ──────────────────

const reviewForm = readFileSync(
  "components/receipts/review/form-pane.tsx",
  "utf8",
);

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test("form-pane routes every save through the serialized queue (no parallel PATCH paths)", () => {
  assert.match(reviewForm, /import \{ SaveQueue \} from "@\/lib\/receipts\/save-queue"/);
  assert.match(
    reviewForm,
    /import \{\n(?:.*\n)*?  registerSaveFlusher,\n(?:.*\n)*?\} from "@\/lib\/receipts\/review-navigation"/,
  );
  // The queue owns all PATCH traffic — the old hand-rolled fetch in
  // onMarkReviewed and the abort-and-refire in triggerSave are gone.
  assert.doesNotMatch(reviewForm, /new AbortController/);
  assert.doesNotMatch(reviewForm, /\.abort\(\)/);
  assert.doesNotMatch(reviewForm, /inFlightRef/);
  // Every fetch in the form is either the queue's or a disjoint endpoint
  // (override sends only exportStatementMonth; delete/extract/directory).
  const markReviewed = section(
    reviewForm,
    "const onMarkReviewed = useCallback(",
    "// Flush pending edits NOW", // flushPendingEdits follows
  );
  assert.ok(!/await fetch\(/.test(markReviewed));
  assert.match(markReviewed, /await saveQueue\.save\(true\)/);
});

test("form-pane: save-and-next navigates only AFTER the queue commits, and stays on failure", () => {
  const fn = reviewForm.slice(
    reviewForm.indexOf("const onMarkReviewed = useCallback("),
    reviewForm.indexOf("const flushPendingEdits"),
  );
  const awaitIdx = fn.indexOf("await saveQueue.save(true)");
  const pushIdx = fn.indexOf("router.push(");
  assert.ok(awaitIdx !== -1 && pushIdx !== -1);
  assert.ok(awaitIdx < pushIdx, "navigation must follow the awaited save");
  // Honest failure: the catch sets an error badge and NEVER navigates.
  const catchIdx = fn.indexOf("} catch (error) {");
  assert.ok(catchIdx !== -1);
  const catchBlock = fn.slice(catchIdx);
  assert.match(catchBlock, /kind: "error"/);
  assert.doesNotMatch(catchBlock, /router\.push\(/);
});

test("form-pane: registers the navigation flusher; Skip and in-form links navigate through the guard", () => {
  // The single mounted form publishes its flush to the guard.
  assert.match(
    reviewForm,
    /useEffect\(\(\) => registerSaveFlusher\(flushPendingEdits\), \[flushPendingEdits\]\)/,
  );
  // Skip delegates to the awaited guard (flushPendingEdits does the saving);
  // the push runs only inside the guard's callback, i.e. after the flush.
  const skip = section(
    reviewForm,
    "function handleSkip()",
    "async function handleDelete()",
  );
  assert.match(skip, /guardedNavigate\(\(\) =>\s*router\.push\(/);
  // Compare + View-in-month links: guarded click preserving native
  // modifier/new-tab behavior (onClick precedes the link text in JSX, so
  // match from the href template to the guarded click).
  assert.match(
    reviewForm,
    /href=\{`\/receipts\/review\/\$\{receipt\.id\}\?month=\$\{props\.switchToMonth\}`\}[\s\S]{0,600}guardedLinkClick\(/,
  );
  assert.match(
    reviewForm,
    /href=\{`\/receipts\/review\/\$\{props\.duplicatePartner\.id\}`\}[\s\S]{0,400}guardedLinkClick\(/,
  );
});

test("form-pane: flushPendingEdits commits pending work and rethrows failures to the caller", () => {
  const fn = section(
    reviewForm,
    "const flushPendingEdits = useCallback(",
    "// The single mounted review form publishes",
  );
  assert.match(fn, /saveTimerRef\.current/);
  assert.match(fn, /saveQueue\.idle/);
  assert.match(fn, /await saveQueue\.save\(\)/);
  // Failure surfaces the badge error AND rejects so the navigator stays.
  assert.match(fn, /kind: "error"/);
  assert.match(fn, /throw error;/);
  assert.doesNotMatch(fn, /router\.push/);
});

test("form-pane: unmount keeps only a send-and-hope net for un-awaitable exits", () => {
  const fn = section(
    reviewForm,
    "// Residual net for exits",
    "useKeyboardShortcuts({",
  );
  assert.match(fn, /void saveQueue\.save\(\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(reviewForm, /pinBody/);
  // No zombie debounce: the timer is cleared at unmount, fired immediately.
  assert.match(fn, /clearTimeout\(saveTimerRef\.current\)/);
});

test("save-queue: no fire-and-forget lifecycle machinery (pin/keepalive/registry removed)", () => {
  const queueSource = readFileSync("lib/receipts/save-queue.ts", "utf8");
  assert.doesNotMatch(queueSource, /keepalive/);
  assert.doesNotMatch(queueSource, /pinBody/);
  assert.doesNotMatch(queueSource, /getSaveQueue/);
  assert.doesNotMatch(queueSource, /new Map/);
});

test("form-pane: debounce + composition guards preserved (IME invariants)", () => {
  const triggerSaveFn = section(
    reviewForm,
    "const triggerSave = useCallback(",
    "const handleBusinessPurposeCompositionStart",
  );
  // Debounce intact, saves via the queue, and suppresses badge state while
  // WebKit composition is active (both at arm time and at settle time).
  assert.match(triggerSaveFn, /SAVE_DEBOUNCE_MS/);
  assert.match(triggerSaveFn, /saveQueue\.save\(\)/);
  assert.equal(
    (triggerSaveFn.match(/businessPurposeComposingRef\.current\) return/g) ?? [])
      .length >= 2,
    true,
    "composition guard at fire AND settle",
  );
  // Composition start only holds the debounce — no abort, no setState.
  const compStart = section(
    reviewForm,
    "const handleBusinessPurposeCompositionStart",
    "const handleBusinessPurposeCompositionEnd",
  );
  assert.doesNotMatch(compStart, /\bset[A-Z]\w*\(/);
  assert.match(compStart, /businessPurposeComposingRef\.current = true/);
  assert.doesNotMatch(compStart, /\.abort\(/);
});

test("form-pane: s-key gate and Mark-reviewed button gating unchanged", () => {
  assert.match(
    reviewForm,
    /if \(!canMarkReviewed\(receipt\.status, isLocked\) \|\| !inView\) return;/,
  );
  assert.match(
    reviewForm,
    /disabled=\{!canMarkReviewed\(receipt\.status, isLocked\) \|\| !inView\}/,
  );
});
