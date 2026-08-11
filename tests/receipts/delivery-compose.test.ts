import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  computeDeliveryConfigErrors,
  type ComposedDelivery,
} from "@/lib/receipts/delivery-compose";
import { buildDeliveryEmail } from "@/lib/receipts/delivery-send";

// ─── §1 config-error paths (computeDeliveryConfigErrors — the pure core of
//     ComposedDelivery.configErrors; composeDelivery calls this with resolved
//     values, so these paths are unit-testable without D1/R2 bindings) ──────────

const VALID = { to: "cpa@example.com", cc: null, replyTo: null, from: "notify@dazbeez.com", hasResendKey: true };

test("configErrors: empty when fully configured (happy path)", () => {
  assert.deepEqual(computeDeliveryConfigErrors(VALID), []);
});

test("configErrors: no To (null) → 'No delivery recipient (To) configured'", () => {
  const errs = computeDeliveryConfigErrors({ ...VALID, to: null });
  assert.ok(errs.some((e) => e.includes("No delivery recipient (To)")));
  assert.equal(errs.length, 1);
});

test("configErrors: invalid To → names the bad address", () => {
  const errs = computeDeliveryConfigErrors({ ...VALID, to: "not-an-email" });
  assert.ok(errs.some((e) => e.includes("not a valid email address") && e.includes("not-an-email")));
  assert.equal(errs.length, 1);
});

test("configErrors: invalid Cc → names the bad Cc (null Cc is fine)", () => {
  const errs = computeDeliveryConfigErrors({ ...VALID, cc: "bad-cc" });
  assert.ok(errs.some((e) => e.includes("Cc recipient is not a valid") && e.includes("bad-cc")));
  // null Cc alone is NOT an error (Cc is optional).
  assert.deepEqual(
    computeDeliveryConfigErrors({ ...VALID, cc: null }),
    [],
    "null Cc is valid (omitted from payload)",
  );
});

test("configErrors: invalid Reply-To → names the bad address (null Reply-To is fine)", () => {
  const errs = computeDeliveryConfigErrors({ ...VALID, replyTo: "bad-reply" });
  assert.ok(
    errs.some((e) => e.includes("Reply-To is not a valid") && e.includes("bad-reply")),
  );
  // null Reply-To alone is NOT an error (Reply-To is optional → omitted).
  assert.deepEqual(
    computeDeliveryConfigErrors({ ...VALID, replyTo: null }),
    [],
    "null Reply-To is valid (omitted from payload)",
  );
});

test("configErrors: no Resend key → 'Delivery not configured'", () => {
  const errs = computeDeliveryConfigErrors({ ...VALID, hasResendKey: false });
  assert.ok(errs.some((e) => e.includes("RESEND_API_KEY / DELIVERY_FROM_ADDRESS")));
  assert.equal(errs.length, 1);
});

test("configErrors: no From address → same 'Delivery not configured' message", () => {
  const errs = computeDeliveryConfigErrors({ ...VALID, from: null });
  assert.ok(errs.some((e) => e.includes("RESEND_API_KEY / DELIVERY_FROM_ADDRESS")));
  assert.equal(errs.length, 1);
});

test("configErrors: multiple problems accumulate (no To AND no key)", () => {
  const errs = computeDeliveryConfigErrors({
    to: null,
    cc: null,
    replyTo: null,
    from: null,
    hasResendKey: false,
  });
  assert.equal(errs.length, 2, "one for missing To, one for missing transport");
});

// ─── §3 preview/send parity — the one that matters ──────────────────────────
//
// composeDelivery exists so the preview endpoint and the send route CANNOT
// disagree on subject/body. Two guarantees make that true by construction:
//   (1) buildDeliveryEmail is imported by exactly ONE non-test source file
//       (lib/receipts/delivery-compose.ts). The send route and the preview
//       endpoint must NOT compose the body themselves — they go through
//       composeDelivery. If someone re-inlines body composition in either
//       route, this fails. (Same source-tree-assertion shape as the capture
//       contract test for #18.)
//   (2) buildDeliveryEmail is deterministic — identical inputs ⇒ identical
//       subject/text/html — so two composeDelivery calls for the same month
//       (one preview, one send) produce byte-identical bodies.

/** Source files (app/lib/components — NOT tests, NOT .next) referencing a token.
 *  Uses a filesystem grep (not `git grep`) so newly-added, still-untracked files
 *  like delivery-compose.ts itself are seen — the parity guarantee must hold
 *  before the first commit, not only after. */
function sourceFilesReferencing(token: string): string[] {
  const out = execFileSync(
    "grep",
    ["-rlE", token, "app/", "lib/", "components/"],
    { encoding: "utf8" },
  );
  return out.trim().split("\n").filter(Boolean);
}

test("parity (PRIMARY): buildDeliveryEmail has exactly ONE importer — delivery-compose.ts (send & preview share it)", () => {
  // delivery-send.ts DEFINES buildDeliveryEmail; every OTHER reference must be
  // the single import in delivery-compose.ts. A second importer (e.g. the send
  // route re-deriving the body) breaks preview/send parity.
  const refs = sourceFilesReferencing("buildDeliveryEmail").filter(
    (f) => f !== "lib/receipts/delivery-send.ts",
  );
  assert.deepEqual(
    refs.sort(),
    ["lib/receipts/delivery-compose.ts"],
    "buildDeliveryEmail must be imported only by delivery-compose.ts",
  );
});

test("parity: the send route and the preview endpoint both import composeDelivery (not a local re-derivation)", () => {
  const send = readFileSync(
    "app/api/receipts/export/[month]/send/route.ts",
    "utf8",
  );
  const preview = readFileSync(
    "app/api/receipts/export/[month]/delivery-preview/route.ts",
    "utf8",
  );
  assert.ok(
    /import\s*\{[^}]*composeDelivery[^}]*\}\s*from\s*"@\/lib\/receipts\/delivery-compose"/.test(
      send,
    ),
    "send route imports composeDelivery",
  );
  assert.ok(
    /import\s*\{[^}]*composeDelivery[^}]*\}\s*from\s*"@\/lib\/receipts\/delivery-compose"/.test(
      preview,
    ),
    "preview endpoint imports composeDelivery",
  );
});

test("parity: buildDeliveryEmail is deterministic — same inputs ⇒ byte-identical subject/text/html", () => {
  const opts = {
    month: "2026-06",
    operatorMessage: "今月のご連絡",
    summary: {
      monthLabel: "2026年6月",
      categoryTotals: [{ ja: "交通費", count: 2, totalMinor: 15000 }],
    },
    signature: "DB",
  };
  const a = buildDeliveryEmail(opts);
  const b = buildDeliveryEmail(opts);
  assert.deepEqual(a, b);
});

test("shape: ComposedDelivery's preflight result names map from the pack-preflight `check` field", () => {
  // The composer renders preflight.results[].name; the underlying pack-preflight
  // report uses `check`. composeDelivery maps check → name. Assert the type
  // carries `name` (compile-time shape guarantee for the composer binding).
  const sample: ComposedDelivery["preflight"]["results"][number] = {
    name: "container-names-ascii",
    passed: true,
  };
  assert.equal(sample.name, "container-names-ascii");
});
