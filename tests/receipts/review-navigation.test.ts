import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  guardedLinkClick,
  guardedNavigate,
  registerSaveFlusher,
} from "@/lib/receipts/review-navigation";
import { SaveQueue, type SaveFetch } from "@/lib/receipts/save-queue";

// Behavioral integration evidence for the rail / j-k navigation contract.
// The harness mirrors form-pane's wiring (debounce timer + serialized queue +
// flushPendingEdits) with a REAL SaveQueue and manually-resolved fetches, and
// drives the exact entry points queue-rail invokes (guardedNavigate for
// j/k/arrows, guardedLinkClick for rail item clicks). Source-structure
// asserts at the bottom pin that queue-rail actually calls those entry
// points.

interface DeferredCall {
  ok: (json?: unknown) => void;
  fail: (error: string) => void;
}

function makeDeferredFetch() {
  const calls: DeferredCall[] = [];
  const fetchImpl: SaveFetch = (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      assert.equal(init.method, "PATCH");
      calls.push({
        ok: (json = {}) =>
          resolve(new Response(JSON.stringify(json), { status: 200 })),
        fail: (error) =>
          resolve(new Response(JSON.stringify({ error }), { status: 422 })),
      });
      void reject; // network-drop case not needed here
    });
  return { calls, fetchImpl };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function bodyOf(fetches: { init: RequestInit }[], i: number) {
  return JSON.parse(fetches[i]!.init.body as string) as Record<string, unknown>;
}

/** Mini form: same moving parts form-pane owns — a debounce timer, a
 * per-instance serialized queue rebound on every "render", and the
 * flushPendingEdits contract (save now, badge on settle, rethrow on
 * failure). */
function makeFormHarness() {
  const deferred = makeDeferredFetch();
  const rawCalls: { init: RequestInit }[] = [];
  const { fetchImpl } = deferred;
  const wrapFetch: SaveFetch = (url, init) => {
    rawCalls.push({ init });
    return fetchImpl(url, init);
  };
  let merchant = "committed-value";
  const queue = new SaveQueue({
    url: "/api/receipts/r1",
    buildBody: () => ({ merchant }),
    fetchImpl: wrapFetch,
  });
  const render = () =>
    queue.rebind({
      url: "/api/receipts/r1",
      buildBody: () => ({ merchant }),
      fetchImpl: wrapFetch,
    });
  const badge: string[] = [];
  let debounceArmed = false;

  return {
    calls: rawCalls,
    badge,
    /** Operator edits a field: state changes, next render rebinds, the
     * autosave debounce is armed (450 ms window — NOT yet sent). */
    edit(value: string) {
      merchant = value;
      render();
      debounceArmed = true;
    },
    /** The debounce window elapsed while the operator was NOT navigating:
     * triggerSave fired and the save is now in flight. */
    async elapseDebounce() {
      debounceArmed = false;
      void queue.save();
      await tick();
    },
    /** form-pane's flushPendingEdits, verbatim semantics. */
    async flushPendingEdits() {
      const hadPendingEdits = debounceArmed;
      debounceArmed = false;
      if (!hadPendingEdits && queue.idle && !queue.lastFailed) return;
      badge.push("saving");
      try {
        await queue.save();
        badge.push("saved");
      } catch (error) {
        badge.push(`error:${(error as Error).message}`);
        throw error;
      }
    },
    get merchant() {
      return merchant;
    },
    deferred,
  };
}

test("j/k during the debounce window: navigation waits for the latest save to commit", async (t) => {
  const form = makeFormHarness();
  const off = registerSaveFlusher(form.flushPendingEdits);
  t.after(off);

  form.edit("latest-keystroke"); // within 450 ms of pressing j/k
  const pushed: string[] = [];
  let navigated = false;

  const nav = guardedNavigate(() => {
    pushed.push("/receipts/review/next");
    navigated = true;
  });
  await tick();

  // The flush fired immediately (debounce cut short) with the LATEST value,
  // and navigation has NOT happened yet — it must await the commit.
  assert.equal(form.calls.length, 1);
  assert.equal(bodyOf(form.calls, 0).merchant, "latest-keystroke");
  assert.equal(navigated, false);

  form.deferred.calls[0]!.ok({ warnings: [] });
  assert.equal(await nav, true);
  assert.equal(navigated, true);
  assert.deepEqual(pushed, ["/receipts/review/next"]);
  assert.ok(form.badge.includes("saved"));
});

test("rail click while an autosave is in flight: both requests serialize, newest fields land last, then navigate", async (t) => {
  const form = makeFormHarness();
  const off = registerSaveFlusher(form.flushPendingEdits);
  t.after(off);

  await form.elapseDebounce(); // older snapshot committed? not yet — in flight
  assert.equal(form.calls.length, 1);

  form.edit("newer-keystroke"); // edits ON TOP of the in-flight save
  let navigated = false;
  const nav = guardedNavigate(() => {
    navigated = true;
  });
  await tick();

  // Still just the in-flight request; the flush coalesces behind it.
  assert.equal(form.calls.length, 1);
  assert.equal(navigated, false);

  form.deferred.calls[0]!.ok({}); // older save commits
  await tick();

  // NOW the flush fired — after the older commit, carrying the newer value.
  assert.equal(form.calls.length, 2);
  assert.equal(bodyOf(form.calls, 1).merchant, "newer-keystroke");
  assert.equal(navigated, false); // still awaiting the newer commit

  form.deferred.calls[1]!.ok({});
  assert.equal(await nav, true);
  assert.equal(navigated, true);
});

test("failed save during j/k: no navigation, honest error badge, retry path works", async (t) => {
  const form = makeFormHarness();
  const off = registerSaveFlusher(form.flushPendingEdits);
  t.after(off);

  form.edit("unsaved-edit");
  let navigated = false;
  const nav = guardedNavigate(() => {
    navigated = true;
  });
  await tick();
  assert.equal(form.calls.length, 1);

  form.deferred.calls[0]!.fail("Receipt is sealed");
  assert.equal(await nav, false);

  // Stayed on the receipt: no navigation, error surfaced, edit retained.
  assert.equal(navigated, false);
  assert.ok(form.badge.includes("error:Receipt is sealed"));
  assert.equal(form.merchant, "unsaved-edit");

  // Recovery: the next navigation attempt flushes again and succeeds.
  const retry = guardedNavigate(() => {
    navigated = true;
  });
  await tick();
  assert.equal(form.calls.length, 2);
  assert.equal(bodyOf(form.calls, 1).merchant, "unsaved-edit");
  form.deferred.calls[1]!.ok({});
  assert.equal(await retry, true);
  assert.equal(navigated, true);
});

test("no form mounted (rail on the list page): navigation is immediate and untouched", async () => {
  // Ensure no flusher leaked from another test file run in the same process.
  const off = registerSaveFlusher(async () => {});
  off();

  let navigated = false;
  const result = await guardedNavigate(() => {
    navigated = true;
  });
  assert.equal(result, true);
  assert.equal(navigated, true);
});

test("guardedLinkClick: modifier and non-left clicks keep native new-tab behavior", async (t) => {
  const form = makeFormHarness();
  const off = registerSaveFlusher(form.flushPendingEdits);
  t.after(off);

  form.edit("pending");
  const pushed: string[] = [];
  interface FakeLinkEvent {
    defaultPrevented: boolean;
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    prevented: boolean;
    preventDefault(): void;
  }
  const mkEvent = (over: Partial<FakeLinkEvent> = {}): FakeLinkEvent => {
    const e: FakeLinkEvent = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      prevented: false,
      preventDefault() {
        e.prevented = true;
      },
    };
    return Object.assign(e, over);
  };

  // ⌘/Ctrl/Shift/Alt + middle/right click: never intercepted — the browser
  // opens the new tab exactly as before.
  for (const over of [
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
    { button: 2 },
  ]) {
    const e = mkEvent(over);
    guardedLinkClick(e, "/receipts/review/x", (h) => pushed.push(h));
    assert.equal(e.prevented, false, `must not preventDefault: ${JSON.stringify(over)}`);
  }
  assert.deepEqual(pushed, [] as string[]);
  assert.equal(form.calls.length, 0); // nothing even attempted a save

  // Plain left click: intercepted, awaits the flush, pushes the SAME href.
  const e = mkEvent({});
  guardedLinkClick(e, "/receipts/review/x?month=2026-06", (h) => pushed.push(h));
  assert.equal(e.prevented, true);
  await tick();
  assert.equal(form.calls.length, 1);
  form.deferred.calls[0]!.ok({});
  await tick();
  assert.deepEqual(pushed, ["/receipts/review/x?month=2026-06"]);
});

test("registerSaveFlusher: re-registering replaces; unregistering restores immediate navigation", async () => {
  const offA = registerSaveFlusher(async () => {
    throw new Error("stale form");
  });
  const offB = registerSaveFlusher(async () => {});
  assert.equal(
    await guardedNavigate(() => {}),
    true,
    "the LATEST registration wins — a stale form cannot block navigation",
  );
  offB();
  offA();
  assert.equal(
    await guardedNavigate(() => {}),
    true,
    "after unmount, navigation is immediate",
  );
});

// ─── wiring: queue-rail actually routes j/k + item links through the guard ──

const queueRail = readFileSync(
  "components/receipts/review/queue-rail.tsx",
  "utf8",
);

test("queue-rail: j/k + arrow navigation goes through guardedNavigate", () => {
  const fn = queueRail.slice(
    queueRail.indexOf("function navigate(delta: number)"),
    queueRail.indexOf("const doneSoFar"),
  );
  assert.match(fn, /guardedNavigate\(/);
  // The push target is unchanged: same receipt URL + preserved queryParams.
  assert.match(fn, /\/receipts\/review\/\$\{next\.id\}\$\{queryParams\}/);
});

test("queue-rail: item links are guarded with native modifier behavior preserved", () => {
  assert.match(queueRail, /onClick=\{\(e\) =>\s*guardedLinkClick\(/);
  // The guarded push uses the same href as the Link itself.
  assert.match(
    queueRail,
    /href=\{`\/receipts\/review\/\$\{item\.id\}\$\{queryParams\}`\}[\s\S]{0,400}guardedLinkClick\(\s*e,\s*`\/receipts\/review\/\$\{item\.id\}\$\{queryParams\}`/,
  );
  // Keyboard gating untouched (j/k/arrows still suppressed while typing —
  // the shared module's isTypingTarget path).
  assert.match(queueRail, /useKeyboardShortcuts\(\{\s*j:/);
  assert.doesNotMatch(queueRail, /allowInInputs/);
});
