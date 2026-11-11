// REAL route-shell regressions (round-2 blocker 3): both render-recovery
// handlers execute with a stubbed persistence layer, so the ACTUAL route
// code — auth branching, body parsing, core call, response construction,
// and the catch path — runs.
//
// Scenario under contract: the core SUCCEEDS (mutation committed in the
// stub) but response construction throws → the route must answer a generic
// 500 whose guidance says to refresh/check current state, must NOT claim
// "the receipt was not modified" (a committed result followed by a failed
// response leaves the outcome uncertain), and must not leak internals.
//
// Runs under the documented node:test module-mock API:
//   node --experimental-test-module-mocks --import tsx --test \
//     tests/receipts/render-recovery-routes.test.ts
// Under the default `tsx --test` (npm test) the flag is absent, so these
// tests self-skip — the flagged command above is the committed way to run
// them; both commands are reported in the PR.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { NextResponse as RealNextResponse } from "next/server";

// NB: always invoke mock.module on its receiver (an unbound alias loses the
// tracker context and throws).
const canMockModules = typeof mock.module === "function";

// ─── Shared stubs ────────────────────────────────────────────────────────────

/** The row the core's admission SELECT returns per route. */
let selectRow: Record<string, unknown> | null = null;
/** Result of db.batch — the core's mutation outcome. */
let batchChanges = 1;
const batchStatements: string[] = [];

if (canMockModules) {
  const fakeDb = {
    prepare(_sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async <T>(): Promise<T | null> => selectRow as T | null,
        }),
      };
    },
    async batch(stmts: { __spec?: unknown }[]) {
      batchStatements.push(`batch:${stmts.length}`);
      return Array.from(stmts, () => ({ success: true, meta: { changes: batchChanges } }));
    },
  };
  mock.module("@/lib/cloudflare-runtime", {
    namedExports: {
      getReceiptsDb: () => fakeDb,
      getReceiptsProcessorKey: () => "test-processor-key",
    },
  });
  let unauthorized = false;
  mock.module("@/lib/receipts/auth", {
    namedExports: {
      // Mimics the real helper: resolves the Clerk actor, or throws the
      // "Unauthorized…" error the route catch translates to 401.
      requireReceiptsActor: async () => {
        if (unauthorized) throw new Error("Unauthorized receipts request.");
        return "op@dazbeez.com";
      },
    },
  });
  (globalThis as { __armAuth401?: { on: () => void; off: () => void } }).__armAuth401 = {
    on: () => { unauthorized = true; },
    off: () => { unauthorized = false; },
  };

  // Break the FIRST 2xx-success response construction on demand; error
  // responses (401/409/500) always build for real.
  let breakNextSuccess = 0;
  const realJson = RealNextResponse.json.bind(RealNextResponse);
  mock.module("next/server", {
    namedExports: {
      NextResponse: {
        json: (body: unknown, init?: ResponseInit) => {
          if (init?.status === undefined || init.status === 200) {
            if (breakNextSuccess > 0) {
              breakNextSuccess -= 1;
              throw new Error("injected: response construction failed");
            }
          }
          return realJson(body, init);
        },
      },
    },
  });
  // Expose the arm switch to tests via a module-level getter/setter object.
  (globalThis as { __armResponseBreak?: { arm: (n: number) => void } }).__armResponseBreak = {
    arm: (n: number) => {
      breakNextSuccess = n;
    },
  };
}

const arm = (n: number) =>
  (globalThis as { __armResponseBreak?: { arm: (n: number) => void } }).__armResponseBreak?.arm(n);
const armAuth401 = {
  on: () => (globalThis as { __armAuth401?: { on: () => void } }).__armAuth401?.on(),
  off: () => (globalThis as { __armAuth401?: { off: () => void } }).__armAuth401?.off(),
};

type RouteHandler = (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

const post = async (route: RouteHandler, body: unknown, headers: Record<string, string> = {}) =>
  route(
    new Request("https://dazbeez.com/api/receipts/r-1/render-failed", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "r-1" }) },
  );

// ─── render-failed shell ─────────────────────────────────────────────────────

test("render-failed shell: core succeeds, response construction fails → generic 500, check-state guidance, no not-modified claim", { skip: !canMockModules }, async () => {
  const { POST } = await import("@/app/api/receipts/[id]/render-failed/route");
  selectRow = {
    id: "r-1", deleted_at: null, needs_render: 1, extraction_state: "captured",
    status: "captured", extraction_json: null,
  };
  batchChanges = 1;
  batchStatements.length = 0;
  arm(1); // the next 2xx response construction throws
  const res = await post(POST, { reason: "empty body from /file" }, { "x-receipts-processor-key": "test-processor-key" });
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /refresh the dashboard/i);
  assert.match(body.error, /current state/i);
  // Never claims rollback for an outcome it cannot know.
  assert.doesNotMatch(body.error, /not modified/i);
  // Generic — no injected internals echoed.
  assert.doesNotMatch(body.error, /response construction failed/i);
});

test("render-failed shell: core succeeds normally → 200 recorded", { skip: !canMockModules }, async () => {
  const { POST } = await import("@/app/api/receipts/[id]/render-failed/route");
  selectRow = {
    id: "r-1", deleted_at: null, needs_render: 1, extraction_state: "captured",
    status: "captured", extraction_json: null,
  };
  batchChanges = 1;
  const res = await post(POST, { reason: "ok" }, { "x-receipts-processor-key": "test-processor-key" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; extractionState: string };
  assert.equal(body.ok, true);
  assert.equal(body.extractionState, "failed");
});

test("render-failed shell: wrong processor key and no Clerk session → 401 (layered auth branch)", { skip: !canMockModules }, async () => {
  const { POST } = await import("@/app/api/receipts/[id]/render-failed/route");
  // requireReceiptsActor stub mimics the real helper's unauthorized throw
  // (no Clerk session behind the wrong key).
  armAuth401.on();
  try {
    selectRow = null;
    const res = await post(POST, { reason: "x" }, { "x-receipts-processor-key": "wrong" });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "Unauthorized.");
  } finally {
    armAuth401.off();
  }
});

// ─── render-retry shell ──────────────────────────────────────────────────────

const retryPost = async (
  routeFn: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
) =>
  routeFn(
    new Request("https://dazbeez.com/api/receipts/r-1/render-retry", { method: "POST" }),
    { params: Promise.resolve({ id: "r-1" }) },
  );

test("render-retry shell: core succeeds, response construction fails → generic 500, check-state guidance, no not-modified claim", { skip: !canMockModules }, async () => {
  const { POST } = await import("@/app/api/receipts/[id]/render-retry/route");
  selectRow = {
    id: "r-1", deleted_at: null, needs_render: 1, extraction_state: "failed",
    status: "captured", extraction_json: JSON.stringify({ failed: true, reason: "x" }),
    transaction_date: null,
  };
  batchChanges = 1;
  arm(1);
  const res = await retryPost(POST);
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /refresh the page/i);
  assert.match(body.error, /current state/i);
  assert.doesNotMatch(body.error, /not modified/i);
  assert.doesNotMatch(body.error, /response construction failed/i);
});

test("render-retry shell: core conflict maps to the endpoint's honest 409", { skip: !canMockModules }, async () => {
  const { POST } = await import("@/app/api/receipts/[id]/render-retry/route");
  // Terminal row but the zero-change branch: batch changes = 0 → re-read
  // still shows the failed row → sealed/changed honest conflict.
  selectRow = {
    id: "r-1", deleted_at: null, needs_render: 1, extraction_state: "failed",
    status: "captured", extraction_json: null, transaction_date: "2026-05-10",
  };
  batchChanges = 0;
  const res = await retryPost(POST);
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /sealed month \(2026-05\)/);
});
