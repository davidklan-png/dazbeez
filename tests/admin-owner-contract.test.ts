import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Admin owner-enforcement contract tests.
//
// Why source-structure (not behavioral): these three handlers previously called
// an async owner guard WITHOUT `await`, letting signed-in non-owners through.
// The fix is a direct, awaited `requireOwnerActor()` as the FIRST statement. A
// behavioral test would require mocking @clerk/nextjs/server `auth()` in a
// request scope, which the project's tsx + node:test harness can't do without
// weakening runtime code. Instead we assert the control-flow invariant directly
// against source: the awaited owner check precedes every body/provider/CRM/image
// operation, non-owners map to 403 via the typed error, and batch attribution
// uses the Clerk actor (never the old "admin"/Basic fallback).

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function lineIndexOf(src: string, needle: string): number {
  const idx = src.indexOf(needle);
  assert.notEqual(idx, -1, `expected to find "${needle}" in source`);
  return src.slice(0, idx).split("\n").length; // 1-based line number
}

const BATCHES = "app/admin/api/batches/route.ts";
const DETECT = "app/admin/api/detect-cards/route.ts";
const IMAGE = "app/admin/images/[id]/route.ts";

// Contract 1: owner authorization is awaited BEFORE any body/provider/CRM/image work.
test("batches: awaits requireOwnerActor() before body, provider, and CRM work", () => {
  const src = read(BATCHES);
  const ownerLine = lineIndexOf(src, "await requireOwnerActor()");
  for (const after of ["request.formData()", "extractBusinessCardDetails(", "createBusinessCardBatch("]) {
    const at = lineIndexOf(src, after);
    assert.ok(ownerLine < at, `owner check (line ${ownerLine}) must precede ${after} (line ${at})`);
  }
});

test("detect-cards: awaits requireOwnerActor() before body and provider work", () => {
  const src = read(DETECT);
  const ownerLine = lineIndexOf(src, "await requireOwnerActor()");
  for (const after of ["request.formData()", "detectBusinessCardsFromImage("]) {
    const at = lineIndexOf(src, after);
    assert.ok(ownerLine < at, `owner check (line ${ownerLine}) must precede ${after} (line ${at})`);
  }
});

test("images/[id]: awaits requireOwnerActor() before params and image work", () => {
  const src = read(IMAGE);
  const ownerLine = lineIndexOf(src, "await requireOwnerActor()");
  for (const after of ["await params", "getImageBlob("]) {
    const at = lineIndexOf(src, after);
    assert.ok(ownerLine < at, `owner check (line ${ownerLine}) must precede ${after} (line ${at})`);
  }
});

// Contract 2: a signed-in non-owner receives 403 via the typed error (not text matching).
for (const file of [BATCHES, DETECT, IMAGE]) {
  test(`${file}: maps OwnerAuthorizationError to 403 (instanceof, not text)`, () => {
    const src = read(file);
    assert.ok(src.includes("OwnerAuthorizationError"), "must reference OwnerAuthorizationError");
    assert.ok(/instanceof OwnerAuthorizationError/.test(src), "must branch with instanceof");
    assert.ok(/status: 403/.test(src), "must return HTTP 403");
  });
}

// Contract 3: batch attribution uses the Clerk actor returned by requireOwnerActor,
// never the old "admin" fallback or Basic-auth username extraction.
test("batches: actor attribution uses requireOwnerActor() result, not 'admin' or Basic", () => {
  const src = read(BATCHES);
  assert.match(src, /const actor = await requireOwnerActor\(\)/);
  assert.ok(src.includes("createBusinessCardBatch"), "creates a batch");
  // the requireOwnerActor result is threaded into createBusinessCardBatch
  assert.ok(
    /createBusinessCardBatch\(\{[\s\S]*?actor,/.test(src),
    "the Clerk actor is passed to createBusinessCardBatch",
  );
  assert.ok(!src.includes('"admin"'), 'no "admin" string fallback');
  assert.ok(!src.includes("getAdminPageUsernameFromHeaders"), "no Basic-auth username extraction");
});

// Contract 4: no runtime code references the removed legacy auth symbols. This is the
// regression guard for the full Phase 4B removal — zero active references; historical
// mentions are allowed only in docs/ (not scanned here).
const REMOVED_RUNTIME_TOKENS: { token: string; re: RegExp }[] = [
  { token: "isReceiptsAuthorized", re: /isReceiptsAuthorized(?!Light)/ }, // keep isReceiptsAuthorizedLight
  { token: "getReceiptsAuthChallengeHeaders", re: /getReceiptsAuthChallengeHeaders/ },
  { token: "isCfAccessTokenAcceptable", re: /isCfAccessTokenAcceptable/ },
  { token: "Cf-Access-Jwt-Assertion", re: /Cf-Access-Jwt-Assertion/ },
  { token: "RECEIPTS_AUTH_*", re: /RECEIPTS_AUTH_/ },
  { token: "ADMIN_PAGE_*", re: /ADMIN_PAGE_/ },
  { token: "getAdminPageUsernameFromHeaders", re: /getAdminPageUsernameFromHeaders/ },
  { token: "assertAdminPageAccessFromHeaders", re: /assertAdminPageAccessFromHeaders/ },
  { token: "getReceiptsOwnerEmails", re: /getReceiptsOwnerEmails/ },
  { token: "DEFAULT_OWNER_EMAILS", re: /DEFAULT_OWNER_EMAILS/ },
  { token: "RECEIPTS_OWNER_EMAILS", re: /RECEIPTS_OWNER_EMAILS/ },
  { token: "CF_ACCESS_CLIENT_*", re: /CF_ACCESS_CLIENT_/ },
  { token: "CF-Access-Client-*", re: /CF-Access-Client-/ },
];

function listRuntimeCode(): string[] {
  const out: string[] = [];
  for (const entry of ["app", "lib", "components", "scripts"]) {
    const abs = join(root, entry);
    try {
      if (statSync(abs).isDirectory()) {
        for (const p of readdirSync(abs, { recursive: true })) {
          const full = join(abs, String(p));
          try {
            if (statSync(full).isFile() && /\.(ts|tsx|py)$/.test(full)) out.push(full);
          } catch {
            /* ignore non-files */
          }
        }
      }
    } catch {
      /* dir missing */
    }
  }
  for (const f of ["middleware.ts", "receipts-env.d.ts"]) out.push(join(root, f));
  return out;
}

test("no runtime code references the removed legacy auth symbols", () => {
  const files = listRuntimeCode();
  assert.ok(files.length > 0, "runtime code files were found");
  for (const { token, re } of REMOVED_RUNTIME_TOKENS) {
    const hits = files.filter((f) => re.test(readFileSync(f, "utf8")));
    assert.deepEqual(
      hits,
      [],
      `removed symbol "${token}" must not appear in runtime code; found in: ${hits.join(", ")}`,
    );
  }
});

// Contract 5: every requireOwnerActor() call site in route handlers is awaited.
test("all requireOwnerActor() calls in app/ route handlers are awaited", () => {
  const routeFiles = listRuntimeCode().filter((f) => f.includes(join("app", "admin")) || /app[\\/].*route\.ts$/.test(f));
  for (const f of routeFiles) {
    const src = readFileSync(f, "utf8");
    if (!src.includes("requireOwnerActor")) continue;
    // Every occurrence of requireOwnerActor( must be preceded by `await ` (possibly
    // across `const x = `), never a fire-and-forget call.
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/requireOwnerActor\(\)/.test(line)) continue;
      assert.ok(
        /\bawait\b/.test(line),
        `${f}:${i + 1} requireOwnerActor() must be awaited (the missing-await bug)`,
      );
    }
  }
});
