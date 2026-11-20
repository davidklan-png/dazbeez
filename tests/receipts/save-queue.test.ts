import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SAVE_HALTED_MESSAGE,
  SaveQueue,
  type SaveFetch,
} from "@/lib/receipts/save-queue";

// ─── controlled deferred fetch ──────────────────────────────────────────
// Every request is a manually-resolved promise so tests decide exactly when
// a save "lands" — the ordering contract is what's under test.

interface DeferredCall {
  init: RequestInit;
  /** Complete the request successfully (default) with a JSON body. */
  ok: (json?: Record<string, unknown>) => void;
  /** Complete the request with an HTTP error status + JSON error body. */
  fail: (error: string) => void;
  /** Complete with an arbitrary status + JSON error body (e.g. 500). */
  failWith: (status: number, error: string) => void;
  /** Complete with 200 but a body that is NOT parseable JSON. */
  okGarbled: () => void;
  /** Complete with 200 and an arbitrary raw body string (parseable JSON of
   *  any shape — the R1 boundary cases: `true`, `[]`, error envelopes…). */
  okRaw: (body: string) => void;
  /** Simulate a network-level failure (fetch rejects). */
  drop: () => void;
}

function makeDeferredFetch() {
  const calls: DeferredCall[] = [];
  const fetchImpl: SaveFetch = (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      calls.push({
        init,
        ok: (json: Record<string, unknown> = {}) =>
          resolve(
            // Default body = the endpoint's ack shape ({ok:true,warnings:[]}).
            new Response(JSON.stringify({ ok: true, receiptRevisions: {}, revision: Number(JSON.parse(init.body as string).expectedRevision) + 1, warnings: [], ...json }), {
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
        failWith: (status, error) =>
          resolve(
            new Response(JSON.stringify({ error }), { status }),
          ),
        okGarbled: () =>
          resolve(new Response("{{not-json", { status: 200 })),
        okRaw: (body) => resolve(new Response(body, { status: 200 })),
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
  const q = new SaveQueue({ initialRevision: 0, url: "/r", buildBody: () => ({}), fetchImpl });

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
  const q = new SaveQueue({ initialRevision: 0, url: "/r", buildBody: () => ({}), fetchImpl });

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
    initialRevision: 0, url: "/r",
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
    initialRevision: 0, url: "/r",
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
    initialRevision: 0, url: "/r",
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
  const q = new SaveQueue({ initialRevision: 0, url: "/r", buildBody: () => ({}), fetchImpl });

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

test("SaveQueue: transport loss = UNKNOWN outcome — halts draining, rejects queued work with guidance, later saves refuse (B3)", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({ initialRevision: 0, url: "/r", buildBody: () => ({}), fetchImpl });

  // Request A in flight; work B queues behind it (newer fields + rider).
  const pA = q.save();
  await tick();
  const pB = q.save(true);
  await tick();
  assert.equal(calls.length, 1);

  // A's transport drops after the server may have accepted it.
  calls[0]!.drop();
  await assert.rejects(pA, new RegExp(SAVE_HALTED_MESSAGE.slice(0, 24)));
  // B was queued behind an UNKNOWN outcome — it must NOT be sent, and its
  // waiter must be rejected with the guidance, never resolved, never lost
  // silently.
  await assert.rejects(pB, /may or may not have reached the server/);
  assert.equal(calls.length, 1); // B never fired
  assert.equal(q.halted, true);

  // No automatic resume: a later navigation/edit attempt is refused with
  // the honest recovery state until the operator reloads.
  await assert.rejects(q.save(), /Reload the receipt/);
  assert.equal(calls.length, 1);

  // A late "success" elsewhere cannot clear the uncertainty: nothing else
  // was sent, so nothing can acknowledge safe ordering.
  assert.equal(q.halted, true);
});

test("SaveQueue: a 500 can FOLLOW a committed write — UNKNOWN outcome, halts, queued B never claims success (response boundary)", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({ initialRevision: 0, url: "/r", buildBody: () => ({}), fetchImpl });

  // A is applied (or mid-application) server-side; its handler then crashes
  // in a post-write step and answers 500. B (newer fields + rider) is
  // already queued behind it.
  const pA = q.save();
  await tick();
  const pB = q.save(true);
  calls[0]!.failWith(500, "audit write failed");

  await assert.rejects(pA, /may or may not have reached the server/);
  await assert.rejects(pB, /may or may not have reached the server/);
  assert.equal(calls.length, 1, "B must not be sent after an ambiguous A");
  assert.equal(q.halted, true);
  await assert.rejects(q.save(), /Reload the receipt/);
  assert.equal(calls.length, 1, "no auto-resume, no further sends");
});

test("SaveQueue: a 200 whose body cannot be parsed is not a usable ack — UNKNOWN, halts (response boundary)", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({ initialRevision: 0, url: "/r", buildBody: () => ({}), fetchImpl });

  const pA = q.save();
  await tick();
  const pB = q.save();
  calls[0]!.okGarbled(); // status says 200, body is garbage

  await assert.rejects(pA, /may or may not have reached the server/);
  await assert.rejects(pB, /may or may not have reached the server/);
  assert.equal(calls.length, 1);
  assert.equal(q.halted, true);
  // A later well-formed response elsewhere still cannot clear it: nothing
  // else was sent after the halt.
  await assert.rejects(q.save(), /Reload the receipt/);
});

test("R1: a parseable but UNUSABLE 200 body is not an ack — halts and queued work never claims success", async () => {
  // Each of these is a syntactically valid 2xx body that the old truthy
  // check falsely acknowledged. The endpoint's only success body is
  // { ok: true, warnings: string[] } (route.ts:386) — anything else did not
  // come from a completed save handler.
  for (const body of [
    "true", // primitive
    "[]", // array
    '{"error":"mutation not acknowledged"}', // error envelope
    '{"warnings":{"unexpected":"object"}}', // non-array warnings
    '{"ok":"yes"}', // ok present but not the endpoint's literal true
    "null", // JSON null
  ]) {
    const { calls, fetchImpl } = makeDeferredFetch();
    const q = new SaveQueue({ initialRevision: 0, url: "/r", buildBody: () => ({}), fetchImpl });
    const pA = q.save();
    await tick();
    const pB = q.save(true); // newer fields + rider queued behind A
    calls[0]!.okRaw(body);

    await assert.rejects(
      pA,
      /may or may not have reached the server/,
      `body ${body} must not acknowledge A`,
    );
    await assert.rejects(
      pB,
      /may or may not have reached the server/,
      `body ${body} must not let queued B claim success`,
    );
    assert.equal(calls.length, 1, `body ${body}: B must never be sent`);
    assert.equal(q.halted, true, `body ${body}: queue must halt`);
  }
});

test("R1: the endpoint's actual success shapes acknowledge and drain", async () => {
  // route.ts:386 always answers { ok: true, warnings: string[] } — warnings
  // may be empty or carry the compliance-recompute warning; ok alone (a
  // defensive future variant) still proves the handler completed.
  for (const [body, expectedWarnings] of [
    ['{"ok":true,"revision":1,"warnings":[]}', []],
    ['{"ok":true,"revision":1,"warnings":["Saved, but compliance checks could not be recomputed."]}', ["Saved, but compliance checks could not be recomputed."]],
    ['{"ok":true,"revision":1}', []],
  ] as const) {
    const { calls, fetchImpl } = makeDeferredFetch();
    const q = new SaveQueue({ initialRevision: 0, url: "/r", buildBody: () => ({}), fetchImpl });
    const pA = q.save();
    await tick();
    const pB = q.save();
    calls[0]!.okRaw(body);
    const result = await pA;
    assert.deepEqual(result.warnings, [...expectedWarnings], `body ${body}`);
    await tick();
    assert.equal(calls.length, 2, `body ${body}: queued B drains normally`);
    calls[1]!.ok({});
    await pB;
    assert.equal(q.halted, false);
  }
});

test("SaveQueue: a conclusive PRE-WRITE refusal (422) is a known failure — corrected-input retry stays available", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({ initialRevision: 0, url: "/r", buildBody: () => ({}), fetchImpl });

  const pA = q.save();
  await tick();
  const pB = q.save();
  calls[0]!.fail("Receipt is sealed"); // server SPOKE — definitive failure
  await assert.rejects(pA, /Receipt is sealed/);
  assert.equal(q.halted, false);

  await tick();
  assert.equal(calls.length, 2); // B still sends and can commit safely
  calls[1]!.ok();
  await pB;
});

test("SaveQueue: deferFire holds REAL pending work — nothing fires or resolves until composition ends (N1)", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  let composing = false;
  const q = new SaveQueue({
    initialRevision: 0, url: "/r",
    buildBody: () => ({}),
    deferFire: () => composing,
    fetchImpl,
  });

  const p1 = q.save();
  await tick();
  assert.equal(calls.length, 1);

  // Composition begins, and while it is active AND request 1 still in
  // flight, a second save queues BEHIND it (pending waiter exists).
  composing = true;
  let bResolved = false;
  const p2 = q.save().then(
    () => {
      bResolved = true;
    },
    () => {
      bResolved = true;
    },
  );

  // NOW request 1 completes — the drain must hold the pending flush.
  calls[0]!.ok();
  await tick();
  assert.equal(calls.length, 1, "pending flush must not fire while composing");
  assert.equal(bResolved, false, "pending waiter must not resolve while held");

  composing = false; // composition end re-arms (the next save re-drains)
  const p3 = q.save();
  await tick();
  assert.equal(calls.length, 2);
  calls[1]!.ok();
  await Promise.all([p1, p2, p3]);
});

test("SaveQueue: lastFailed tracks the newest flush outcome for retry decisions", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({ initialRevision: 0, url: "/r", buildBody: () => ({}), fetchImpl });
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
    initialRevision: 0, url: "/r",
    buildBody: () => ({ merchant: "first-render" }),
    fetchImpl,
  });

  const p1 = q.save();
  await tick();
  assert.equal(bodyOf(calls[0]!).merchant, "first-render");

  // The form re-renders (fields changed) and rebinds a fresh closure.
  q.rebind({
    initialRevision: 0, url: "/r",
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
  // The ONLY hand-rolled PATCH left in the form is the statement-month
  // override (field-disjoint from autosaves by design); every field save
  // goes through the queue.
  const formBody = reviewForm.slice(
    reviewForm.indexOf("export function FormPane"),
    reviewForm.indexOf("function formatAmountInput"),
  );
  assert.equal(
    (formBody.match(/method: "PATCH"/g) ?? []).length,
    0,
    "membership override and all fields share the revision queue",
  );
});

test("form-pane: save-and-next is a guarded navigation intent — same drain, same supersession (B2)", () => {
  const fn = section(
    reviewForm,
    "const onMarkReviewed = useCallback(",
    "// Flush pending edits NOW",
  );
  // Rider set, then navigation goes through the guard — no direct push, no
  // private save path bypassing the latest-edit drain.
  assert.match(fn, /reviewedRiderRef\.current = true/);
  assert.match(fn, /guardedNavigate\(/);
  assert.match(fn, /router\.push\(/); // inside the guard callback only
  assert.doesNotMatch(fn, /await saveQueue\.save/);
  // The button + `s` gate is unchanged.
  assert.match(
    reviewForm,
    /if \(!canMarkReviewed\(receipt\.status, isLocked\) \|\| !inView\) return;/,
  );
});

test("form-pane: registers the navigation flusher; Skip and in-form links navigate through the guard", () => {
  // The single mounted form publishes its flush to the guard.
  assert.match(
    reviewForm,
    /registerSaveFlusher\(\(\) => \{[\s\S]*?dedicatedActionRef\.current[\s\S]*?return flushPendingEdits\(\)/,
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
  assert.match(fn, /saveQueue\.halted/); // B3: clean pass refuses when halted
  assert.match(fn, /await saveQueue\.save\(markReviewed\)/); // B2: rider rides
  // Failure surfaces the badge error AND rejects so the navigator stays.
  assert.match(fn, /kind: "error"/);
  assert.match(fn, /throw error;/);
  assert.doesNotMatch(fn, /router\.push/);
  // B5: holds through an active composition at every pass, including one
  // started mid-await, and suppresses badge updates until WebKit commits.
  assert.ok(
    (fn.match(/waitForCompositionEnd\(\)/g) ?? []).length >= 2,
    "loop-head hold + error-path hold",
  );
  assert.match(fn, /if \(!businessPurposeComposingRef\.current\) \{/);
  // B1: cleanup is post-assignment (.then), never a finally inside the
  // async body — a synchronous clean pass must not cache its success.
  assert.match(fn, /void flush\.then\(/);
  assert.doesNotMatch(fn, /finally \{/);
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
    /disabled=\{overrideBusy \|\| !canMarkReviewed\(receipt\.status, isLocked\) \|\| !inView\}/,
  );
});

test("AMEX lane: edits and POST matching serialize with only acknowledged tokens", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  let body = { receiptMissingReason: "古い" };
  const q = new SaveQueue({ url: "/line", initialRevision: 7, entity: "AMEX line", buildBody: () => body, fetchImpl });
  const first = q.save(); body = { receiptMissingReason: "新しい理由" }; const pending = q.save();
  const action = q.mutate("/reconcile", "POST", () => ({ amexLineId: "l", matchStatus: "no_receipt" }));
  assert.equal(calls.length, 1); assert.equal(bodyOf(calls[0]).expectedRevision, 7);
  calls[0].ok({ revision: 9 }); await first; await tick();
  assert.equal(calls.length, 2); assert.equal(bodyOf(calls[1]).receiptMissingReason, "新しい理由");
  assert.equal(bodyOf(calls[1]).expectedRevision, 9);
  calls[1].ok({ revision: 12 }); await pending; await tick();
  assert.equal(calls[2].init.method, "POST"); assert.equal(bodyOf(calls[2]).expectedRevision, 12);
  calls[2].ok({ revision: 15 }); await action; assert.equal(q.revision, 15);
});

for (const ack of [{}, { revision: 3 }, { revision: 2 }, { revision: -1 }, { revision: 1.2 }, { revision: Number.MAX_SAFE_INTEGER + 1 }]) {
  test(`AMEX lane: missing/unsafe/regressed acknowledgement halts: ${JSON.stringify(ack)}`, async () => {
    const { calls, fetchImpl } = makeDeferredFetch();
    const q = new SaveQueue({ url: "/line", initialRevision: 3, entity: "AMEX line", buildBody: () => ({ attendees: ["保持"] }), fetchImpl });
    const save = q.save(); const refused = assert.rejects(save, /Reload to review/);
    calls[0].okRaw(JSON.stringify({ ok: true, ...ack })); await refused;
    assert.equal(q.halted, true); await assert.rejects(q.save()); assert.equal(calls.length, 1);
  });
}

for (const status of [404, 409, 500]) {
  test(`AMEX lane: ${status} preserves pending intent and halts matching/advance`, async () => {
    const { calls, fetchImpl } = makeDeferredFetch(); let draft = "first";
    const q = new SaveQueue({ url: "/line", initialRevision: 3, entity: "AMEX line", buildBody: () => ({ receiptMissingReason: draft }), fetchImpl });
    const p = q.save(); const failed = assert.rejects(p); draft = "latest local draft";
    const action = q.mutate("/reconcile", "POST", () => ({})); const blocked = assert.rejects(action);
    calls[0].failWith(status, "changed"); await failed; await blocked;
    assert.equal(q.halted, true); assert.equal(draft, "latest local draft"); assert.equal(calls.length, 1);
  });
}

test("AMEX lane: paused IME/trip barrier resumes only with its own aggregate ack", async () => {
  const { calls, fetchImpl } = makeDeferredFetch(); let deferred = true; let draft = "日本語入力中";
  const q = new SaveQueue({ url: "/line", initialRevision: 5, entity: "AMEX line", deferFire: () => deferred, buildBody: () => ({ receiptMissingReason: draft }), fetchImpl });
  const pending = q.save(); assert.equal(calls.length, 0);
  draft = "日本語確定"; q.acceptAcknowledgedRevision(8); deferred = false; const drain = q.save();
  assert.equal(calls.length, 1); assert.equal(bodyOf(calls[0]).expectedRevision, 8); assert.equal(bodyOf(calls[0]).receiptMissingReason, draft);
  calls[0].ok({ revision: 10 }); await pending; await drain;
});

test("trip acknowledgement must include all loaded affected line tokens", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({ url: "/trip", initialRevision: 3, entity: "trip", buildBody: () => ({ expectedLines: { l: 8 } }), fetchImpl });
  const p = q.save(); const failed = assert.rejects(p, /Reload to review/);
  calls[0].ok({ revision: 5, lineRevisions: {} }); await failed; assert.equal(q.halted, true);
});

test("AMEX lane: concurrent drain observers wait without enqueuing empty writes", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({ url: "/line", initialRevision: 0, entity: "AMEX line", buildBody: () => ({ attendees: ["Late"] }), fetchImpl });
  const save = q.save(); const nav = q.whenIdle(); const trip = q.whenIdle();
  calls[0].ok({ revision: 2 }); await Promise.all([save, nav, trip]);
  assert.equal(calls.length, 1); assert.equal(q.idle, true);
});

test("revision acknowledgements feed queued saves and dedicated membership/Delete at execution time", async () => {
  const { calls, fetchImpl } = makeDeferredFetch();
  const q = new SaveQueue({ url: "/r", initialRevision: 10, buildBody: () => ({ merchant: "draft" }), fetchImpl });
  const a = q.save();
  const b = q.save();
  assert.equal(bodyOf(calls[0]!).expectedRevision, 10);
  calls[0]!.ok({ revision: 13 });
  await a; await tick();
  assert.equal(bodyOf(calls[1]!).expectedRevision, 13);
  calls[1]!.ok({ revision: 16 });
  await b;
  const membership = q.mutate("PATCH", { exportStatementMonth: "2026-11" });
  assert.equal(bodyOf(calls[2]!).expectedRevision, 16);
  calls[2]!.ok({ revision: 17 }); await membership;
  const deletion = q.mutate("DELETE", { reason: "correction" });
  assert.equal(bodyOf(calls[3]!).expectedRevision, 17);
  assert.equal(calls[3]!.init.method, "DELETE");
  calls[3]!.ok({ revision: 18 }); await deletion;
});

test("revision conflict halts pending and future saves, preserving newest unsent fields", async () => {
  let draft = "first";
  let calls = 0;
  let release!: (r: Response) => void;
  const q = new SaveQueue({ url: "/r", initialRevision: 0, buildBody: () => ({ merchant: draft }), fetchImpl: async () => {
    calls++;
    return new Promise(resolve => { release = resolve; });
  } });
  const a = q.save(); draft = "unsaved typing"; const b = q.save(true);
  const rejectedA = assert.rejects(a, /changed elsewhere/);
  const rejectedB = assert.rejects(b, /changed elsewhere/);
  release(Response.json({ code: "receipt_revision_conflict", error: "conflict" }, { status: 409 }));
  await Promise.all([rejectedA, rejectedB]);
  await assert.rejects(q.save(), /changed elsewhere/);
  await assert.rejects(q.mutate("DELETE", {}), /changed elsewhere/);
  assert.equal(draft, "unsaved typing"); assert.equal(calls, 1);
});

test("missing, unsafe and regressed acknowledgement revisions halt", async () => {
  for (const revision of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 3]) {
    const q = new SaveQueue({ url: "/r", initialRevision: 4, buildBody: () => ({}), fetchImpl: async () => Response.json({ ok: true, revision }) });
    await assert.rejects(q.save(), /uncertain/);
    assert.equal(q.halted, true);
  }
});

test("a missing/deleted receipt halts future autosaves and dedicated actions", async () => {
  let calls = 0;
  const q = new SaveQueue({ initialRevision: 4, url: "/r", buildBody: () => ({ merchant: "retained" }), fetchImpl: async () => {
    calls++;
    return Response.json({ error: "Receipt not found." }, { status: 404 });
  } });
  await assert.rejects(q.save(), /no longer available/);
  await assert.rejects(q.save(), /no longer available/);
  await assert.rejects(q.mutate("DELETE", {}), /no longer available/);
  assert.equal(q.halted, true); assert.equal(calls, 1);
});

for (const receiptRevisions of [undefined, {}, { r: -1 }, { r: 2 }, { r: 4, unseen: 9 }]) {
  test(`matching halts on an unusable affected-receipt acknowledgement: ${JSON.stringify(receiptRevisions)}`, async () => {
    const q = new SaveQueue({ url: "/line", initialRevision: 0, entity: "AMEX line", buildBody: () => ({}),
      fetchImpl: async () => Response.json({ ok: true, revision: 1, receiptRevisions }) });
    await assert.rejects(q.mutate("/reconcile", "POST", () => ({ expectedReceipts: { r: 3 } })), /Reload to review/);
    assert.equal(q.halted, true);
  });
}

test("a local missing candidate context rejects and halts without leaving an in-flight slot", async () => {
  let calls = 0;
  const q = new SaveQueue({ url: "/line", initialRevision: 0, entity: "AMEX line", buildBody: () => ({}), fetchImpl: async () => {
    calls++; return Response.json({ ok: true, revision: 1 });
  } });
  await assert.rejects(q.mutate("/reconcile", "POST", () => { throw new Error("Receipt context missing — reload to review."); }), /context missing/);
  assert.equal(q.idle, true); assert.equal(q.halted, true); assert.equal(calls, 0);
});
