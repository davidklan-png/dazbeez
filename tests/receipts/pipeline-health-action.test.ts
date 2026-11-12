// Health-row action path tests (review R4 + round-2 blockers 2–3).
// These execute the ACTUAL request path — performHealthAction with an
// injected fetch (real Response objects, real JSON parsing) — plus the
// classification and disabling logic the component renders from. The
// network case passes a fetch that genuinely REJECTS. Route-shell HTTP
// boundaries (core-success + response-construction failure) live in
// render-recovery-routes.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyActionFailure,
  HEALTH_ACTION_FAILURE_NOTE,
  isActionDisabledByFailure,
} from "@/lib/receipts/pipeline-health";
import { performHealthAction } from "@/lib/receipts/health-action";

const res = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("classifyActionFailure matrix", () => {
  assert.equal(classifyActionFailure(409), "refused");
  assert.equal(classifyActionFailure(404), "removed");
  assert.equal(classifyActionFailure(401), "auth");
  assert.equal(classifyActionFailure(403), "auth");
  // 5xx is an UNKNOWN outcome for a mutating POST, not "safe to retry".
  assert.equal(classifyActionFailure(500), "unconfirmed");
  assert.equal(classifyActionFailure(503), "unconfirmed");
  assert.equal(classifyActionFailure(502), "unconfirmed");
  assert.equal(classifyActionFailure(429), "unconfirmed");
});

test("every failure kind disables the action; unconfirmed carries reload/check-state guidance", () => {
  // No failure yet stays enabled; any failure disables until refreshed.
  assert.equal(isActionDisabledByFailure(null), false);
  for (const kind of ["refused", "removed", "auth", "unconfirmed"] as const) {
    assert.equal(isActionDisabledByFailure(kind), true, kind);
  }
  // Blocker 2: the unknown-outcome note tells the operator to refresh and
  // check current state BEFORE trying again — it never invites a repeat.
  const note = HEALTH_ACTION_FAILURE_NOTE.unconfirmed;
  assert.match(note, /outcome unconfirmed/i);
  assert.match(note, /reload the page/i);
  assert.match(note, /check this receipt's current state/i);
  assert.match(note, /before trying again/i);
});

test("actual action path: 200 → done", async () => {
  const calls: string[] = [];
  const outcome = await performHealthAction("/api/receipts/r1/render-retry", async (url, init) => {
    calls.push(`${init!.method} ${url}`);
    return res(200, { ok: true });
  });
  assert.deepEqual(outcome, { status: "done" });
  assert.deepEqual(calls, ["POST /api/receipts/r1/render-retry"]);
});

test("actual action path: 409 keeps the endpoint's safe validated message", async () => {
  const outcome = await performHealthAction("/x", async () =>
    res(409, { error: "Receipt sits in a sealed month (2026-05) — reopen via the export revision flow." }),
  );
  assert.ok(outcome.status === "failed");
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.message, "Receipt sits in a sealed month (2026-05) — reopen via the export revision flow.");
});

test("actual action path: 409 with unparseable/missing body gets the fixed fallback", async () => {
  const noBody = await performHealthAction("/x", async () => new Response(null, { status: 409 }));
  assert.ok(noBody.status === "failed");
  assert.equal(noBody.kind, "refused");
  assert.match(noBody.message!, /not in the recoverable state/);
  const nonString = await performHealthAction("/x", async () => res(409, { error: 42 }));
  assert.ok(nonString.status === "failed");
  assert.match(nonString.message!, /not in the recoverable state/);
});

test("actual action path: 404/401/403 classify removed/auth and never echo bodies", async () => {
  for (const [status, kind] of [[404, "removed"], [401, "auth"], [403, "auth"]] as const) {
    const outcome = await performHealthAction("/x", async () => res(status, { error: "internal" }));
    assert.ok(outcome.status === "failed");
    assert.equal(outcome.kind, kind);
    assert.equal(outcome.message, null, `${status} body must not be displayed`);
  }
});

test("actual action path: 503 is unconfirmed and its body is NOT displayed (may contain internals)", async () => {
  const outcome = await performHealthAction("/api/receipts/r1/enqueue", async () =>
    res(503, { error: "D1_ERROR: no such table: receipt_records at line 7" }),
  );
  assert.ok(outcome.status === "failed");
  assert.equal(outcome.kind, "unconfirmed");
  assert.equal(outcome.message, null); // fixed safe note only — no internal text
});

test("actual action path: a genuinely REJECTED fetch (network loss) is unconfirmed", async () => {
  const outcome = await performHealthAction("/x", async () => {
    throw new TypeError("fetch failed"); // real rejection, not a status
  });
  assert.deepEqual(outcome, { status: "failed", kind: "unconfirmed", message: null });
});

test("actual action path: a 500 carrying the route's own safe guidance still shows the fixed unconfirmed note", async () => {
  // The render-retry 500 body is safe, but the rule is uniform: no 5xx body
  // is trusted for display; the fixed note carries the same guidance.
  const outcome = await performHealthAction("/x", async () =>
    res(500, { error: "Render retry failed — refresh the page and check this receipt's current state before trying again." }),
  );
  assert.ok(outcome.status === "failed");
  assert.equal(outcome.kind, "unconfirmed");
  assert.equal(outcome.message, null);
  assert.match(HEALTH_ACTION_FAILURE_NOTE.unconfirmed, /reload the page/);
});
