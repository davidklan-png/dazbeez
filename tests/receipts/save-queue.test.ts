import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SaveQueue,
  getSaveQueue,
  type SaveFetch,
} from "@/lib/receipts/save-queue";

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

test("SaveQueue: pinned body (unmount flush) ignores later builder changes", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  let merchant = "final-edit";
  const q = new SaveQueue({
    url: "/r",
    buildBody: () => ({ merchant }),
    fetchImpl,
  });

  const p1 = q.save();
  await tick();

  // Unmount while busy: the flush pins the form's final fields NOW. A
  // same-receipt remount rebinding the builder to stale server props must
  // not rewrite the pending body.
  const pFlush = q.save(false, { pinBody: true });
  merchant = "stale-server-value";
  calls[0]!.ok();
  await tick();

  assert.equal(bodyOf(calls[1]!).merchant, "final-edit");
  calls[1]!.ok();
  await Promise.all([p1, pFlush]);
});

test("SaveQueue: requests are sent keepalive so route changes cannot drop them", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({ url: "/r", buildBody: () => ({}), fetchImpl });

  const p = q.save();
  await tick();
  assert.equal(calls[0]!.init.keepalive, true);
  assert.equal(calls[0]!.init.method, "PATCH");
  calls[0]!.ok();
  await p;
});

test("getSaveQueue: same receipt joins one queue (rebinding builders), different receipts stay independent", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  let who = 1;
  const a1 = getSaveQueue("registry-a", {
    url: "/a",
    buildBody: () => ({ who }),
    fetchImpl,
  });
  who = 2;
  const a2 = getSaveQueue("registry-a", {
    url: "/a",
    buildBody: () => ({ who }),
    fetchImpl,
  });
  assert.equal(a1, a2); // remount joins, not races

  const p = a2.save(); // fires with the REBOUND (latest) builder
  await tick();
  assert.equal(bodyOf(calls[0]!).who, 2);
  calls[0]!.ok();
  await p;

  const b = getSaveQueue("registry-b", {
    url: "/b",
    buildBody: () => ({}),
    fetchImpl,
  });
  assert.notEqual(b, a1);
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
  assert.match(
    reviewForm,
    /import \{ getSaveQueue \} from "@\/lib\/receipts\/save-queue"/,
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
    "// Unmount safety net", // marker of the effect that follows
  );
  assert.ok(!/await fetch\(/.test(markReviewed));
  assert.match(markReviewed, /await saveQueue\.save\(true\)/);
});

test("form-pane: save-and-next navigates only AFTER the queue commits, and stays on failure", () => {
  const fn = reviewForm.slice(
    reviewForm.indexOf("const onMarkReviewed = useCallback("),
    reviewForm.indexOf("useKeyboardShortcuts({"),
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

test("form-pane: Skip flushes pending edits through the queue before navigating, and stays on failure", () => {
  const fn = section(
    reviewForm,
    "async function handleSkip()",
    "async function handleDelete()",
  );
  assert.match(fn, /saveQueue\.idle/);
  const saveIdx = fn.indexOf("await saveQueue.save()");
  const pushIdx = fn.indexOf("router.push(");
  assert.ok(saveIdx !== -1 && pushIdx !== -1 && saveIdx < pushIdx);
  // The error path returns BEFORE the navigation.
  const catchIdx = fn.indexOf("} catch (error) {");
  const returnIdx = fn.indexOf("return;", catchIdx);
  assert.ok(catchIdx !== -1 && returnIdx !== -1 && returnIdx < pushIdx);
});

test("form-pane: unmount flushes a pending debounce with a pinned body through the queue", () => {
  const fn = section(
    reviewForm,
    "// ─── keyboard shortcuts ─",
    "useKeyboardShortcuts({",
  );
  assert.match(fn, /save\(false, \{ pinBody: true \}\)/);
  // Fire-and-forget but never unhandled.
  assert.match(fn, /\.catch\(\(\) => \{/);
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
