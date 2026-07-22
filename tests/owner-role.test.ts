import test from "node:test";
import assert from "node:assert/strict";

// Owner authorization is the single source of truth for "owner" across
// requireOwnerActor (throws OwnerAuthorizationError) and isReceiptsOwner
// (boolean), both routed through isOwnerRole. These are pure predicate tests
// (no Clerk network, no request scope) covering the role decision the admin
// handlers depend on.
import { isOwnerRole, OwnerAuthorizationError } from "@/lib/clerk-owner";

test("isOwnerRole: accepts the owner role", () => {
  assert.equal(isOwnerRole({ publicMetadata: { role: "owner" } }), true);
});

test("isOwnerRole: rejects a member role", () => {
  assert.equal(isOwnerRole({ publicMetadata: { role: "member" } }), false);
});

test("isOwnerRole: rejects an absent role (signed-out-ish shapes)", () => {
  assert.equal(isOwnerRole({ publicMetadata: {} }), false);
  assert.equal(isOwnerRole({}), false);
  assert.equal(isOwnerRole(undefined), false);
  assert.equal(isOwnerRole(null), false);
});

test("isOwnerRole: rejects malformed claims", () => {
  assert.equal(isOwnerRole({ publicMetadata: { role: 123 } }), false); // wrong type
  assert.equal(isOwnerRole({ publicMetadata: null }), false);
  assert.equal(isOwnerRole({ publicMetadata: "owner" }), false); // role at wrong type
  assert.equal(isOwnerRole({ role: "owner" }), false); // role at wrong nesting level
  assert.equal(isOwnerRole("owner"), false); // wrong shape entirely
});

test("isOwnerRole: only the exact 'owner' string qualifies", () => {
  assert.equal(isOwnerRole({ publicMetadata: { role: "Owner" } }), false); // case
  assert.equal(isOwnerRole({ publicMetadata: { role: "admin" } }), false); // synonym
  assert.equal(isOwnerRole({ publicMetadata: { role: "owner " } }), false); // whitespace
});

test("OwnerAuthorizationError: is a distinct, typed Error", () => {
  const err = new OwnerAuthorizationError();
  assert.ok(err instanceof Error);
  assert.ok(err instanceof OwnerAuthorizationError);
  assert.equal(err.name, "OwnerAuthorizationError");
  // Callers branch on instanceof, NOT on error message text. A plain Error with
  // the same message must NOT satisfy the check.
  const lookalike = new Error("Owner role required.");
  assert.ok(!(lookalike instanceof OwnerAuthorizationError));
});

test("OwnerAuthorizationError: supports default and custom messages", () => {
  assert.match(new OwnerAuthorizationError().message, /Owner role required/);
  assert.equal(new OwnerAuthorizationError("custom reason").message, "custom reason");
});
