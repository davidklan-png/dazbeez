// Tests for parseRfcFromMailbox and resolveBlockedSenderIdentity.
// Run from the worker directory:
//   npx tsx --test test/sender-identity.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { parseRfcFromMailbox, resolveBlockedSenderIdentity } from "../src/sender-identity";

// ─── parseRfcFromMailbox ────────────────────────────────────────────────────

test("quoted display name → bare mailbox", () => {
  assert.equal(parseRfcFromMailbox('"John Doe" <john@example.com>'), "john@example.com");
});

test("comma inside quoted display name → first valid mailbox", () => {
  assert.equal(parseRfcFromMailbox('"Doe, John" <john@example.com>'), "john@example.com");
});

test("bare mailbox → bare mailbox", () => {
  assert.equal(parseRfcFromMailbox("foo@bar.com"), "foo@bar.com");
});

test("uppercase normalization", () => {
  assert.equal(parseRfcFromMailbox("FOO@BAR.COM"), "foo@bar.com");
  assert.equal(parseRfcFromMailbox("Name <FOO@BAR.COM>"), "foo@bar.com");
});

test("malformed header → null", () => {
  assert.equal(parseRfcFromMailbox("not an email"), null);
  assert.equal(parseRfcFromMailbox(""), null);
});

test("null/undefined → null", () => {
  assert.equal(parseRfcFromMailbox(null), null);
  assert.equal(parseRfcFromMailbox(undefined), null);
});

test("multiple addresses → first valid mailbox", () => {
  assert.equal(parseRfcFromMailbox("a@b.com, c@d.com"), "a@b.com");
  assert.equal(parseRfcFromMailbox("Name <first@valid.com>, Other <second@valid.com>"), "first@valid.com");
});

test("unquoted display name with angle brackets → mailbox", () => {
  assert.equal(parseRfcFromMailbox("John Doe <john@example.com>"), "john@example.com");
});

// ─── resolveBlockedSenderIdentity ────────────────────────────────────────────
// Uses a minimal fake D1 that returns a row for specified emails.

function makeFakeBlockedDb(blockedEmails: Set<string>) {
  return {
    prepare(sql: string) {
      return {
        bind(email: string) {
          return {
            first: () => {
              if (sql.toUpperCase().includes("FROM BLOCKED_INTAKE_SENDERS") && blockedEmails.has(email)) {
                return { "1": 1 };
              }
              return null;
            },
          };
        },
      };
    },
  } as any;
}

test("resolveBlockedSenderIdentity: header match only → matched=true, fromHeader=true", async () => {
  const db = makeFakeBlockedDb(new Set(["header@evil.com"]));
  const r = await resolveBlockedSenderIdentity(db, "header@evil.com", "envelope@other.com");
  assert.equal(r.matched, true);
  assert.equal(r.identity, "header@evil.com");
  assert.equal(r.fromHeader, true);
});

test("resolveBlockedSenderIdentity: envelope match only → matched=true, fromHeader=false", async () => {
  const db = makeFakeBlockedDb(new Set(["envelope@evil.com"]));
  const r = await resolveBlockedSenderIdentity(db, "header@other.com", "envelope@evil.com");
  assert.equal(r.matched, true);
  assert.equal(r.identity, "envelope@evil.com");
  assert.equal(r.fromHeader, false);
});

test("resolveBlockedSenderIdentity: both match → matched=true (header checked first)", async () => {
  const db = makeFakeBlockedDb(new Set(["same@evil.com"]));
  const r = await resolveBlockedSenderIdentity(db, "same@evil.com", "same@evil.com");
  assert.equal(r.matched, true);
  assert.equal(r.identity, "same@evil.com");
});

test("resolveBlockedSenderIdentity: neither match → matched=false", async () => {
  const db = makeFakeBlockedDb(new Set());
  const r = await resolveBlockedSenderIdentity(db, "a@b.com", "c@d.com");
  assert.equal(r.matched, false);
  assert.equal(r.identity, null);
});

test("resolveBlockedSenderIdentity: header/envelope mismatch, only envelope blocked → matched on envelope", async () => {
  const db = makeFakeBlockedDb(new Set(["env@evil.com"]));
  const r = await resolveBlockedSenderIdentity(db, "visible@harmless.com", "env@evil.com");
  assert.equal(r.matched, true);
  assert.equal(r.identity, "env@evil.com");
  assert.equal(r.fromHeader, false);
});

test("resolveBlockedSenderIdentity: lookup error falls back to matched=false (not a false positive)", async () => {
  const db = {
    prepare() {
      return {
        bind() {
          return { first: () => { throw new Error("D1 down"); } };
        },
      };
    },
  } as any;
  const r = await resolveBlockedSenderIdentity(db, "a@b.com", "c@d.com");
  assert.equal(r.matched, false);
});

test("resolveBlockedSenderIdentity: null header + null envelope → matched=false", async () => {
  const db = makeFakeBlockedDb(new Set(["x@y.com"]));
  const r = await resolveBlockedSenderIdentity(db, null, null);
  assert.equal(r.matched, false);
});
