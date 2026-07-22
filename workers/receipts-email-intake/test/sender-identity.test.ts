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
// Fake D1 that models .all() — returns every matching blocked email.
// Does NOT infer priority from bind order; production TypeScript applies it.

function makeFakeBlockedDb(blockedEmails: Set<string>) {
  let lastSql = "";
  let queryCount = 0;
  return {
    prepare(sql: string) {
      return {
        bind(...emails: string[]) {
          return {
            all() {
              queryCount++;
              lastSql = sql;
              const s = sql.toUpperCase();
              if (!s.includes("FROM BLOCKED_INTAKE_SENDERS")) return { results: [] };
              const matched: { email: string }[] = [];
              for (const e of emails) {
                if (blockedEmails.has(e)) matched.push({ email: e });
              }
              return { results: matched };
            },
            // Some callers may still use .first(); route through .all().
            first() {
              queryCount++;
              lastSql = sql;
              const s = sql.toUpperCase();
              if (!s.includes("FROM BLOCKED_INTAKE_SENDERS")) return null;
              for (const e of emails) {
                if (blockedEmails.has(e)) return { email: e };
              }
              return null;
            },
          };
        },
      };
    },
    _lastSql: () => lastSql,
    _queryCount: () => queryCount,
  } as any;
}

// ── One-identity cases ──────────────────────────────────────────────────────

test("one identity blocked → matched=true", async () => {
  const db = makeFakeBlockedDb(new Set(["spam@evil.com"]));
  const r = await resolveBlockedSenderIdentity(db, "spam@evil.com", null);
  assert.equal(r.matched, true);
  assert.equal(r.identity, "spam@evil.com");
  assert.equal(r.fromHeader, true);
});

// ── Two-distinct-identity cases ──────────────────────────────────────────────

test("header-only match with two distinct identities → fromHeader=true", async () => {
  const db = makeFakeBlockedDb(new Set(["header@evil.com"]));
  const r = await resolveBlockedSenderIdentity(db, "header@evil.com", "env@harmless.com");
  assert.equal(r.matched, true);
  assert.equal(r.identity, "header@evil.com");
  assert.equal(r.fromHeader, true);
});

test("envelope-only match with two distinct identities → fromHeader=false", async () => {
  const db = makeFakeBlockedDb(new Set(["env@evil.com"]));
  const r = await resolveBlockedSenderIdentity(db, "visible@harmless.com", "env@evil.com");
  assert.equal(r.matched, true);
  assert.equal(r.identity, "env@evil.com");
  assert.equal(r.fromHeader, false);
});

test("two distinct identities both blocked → RFC From wins", async () => {
  const db = makeFakeBlockedDb(new Set(["header@evil.com", "env@evil.com"]));
  const r = await resolveBlockedSenderIdentity(db, "header@evil.com", "env@evil.com");
  assert.equal(r.matched, true);
  assert.equal(r.identity, "header@evil.com");
  assert.equal(r.fromHeader, true);
});

// ── Deduplication ────────────────────────────────────────────────────────────

test("same header/envelope address → normalized, deduplicated, single query", async () => {
  const db = makeFakeBlockedDb(new Set());
  await resolveBlockedSenderIdentity(db, "same@example.com", "same@example.com");
  assert.equal(db._queryCount(), 1, "duplicate identities must issue one query");
});

test("case/whitespace variants normalize and deduplicate", async () => {
  const db = makeFakeBlockedDb(new Set(["same@example.com"]));
  const r = await resolveBlockedSenderIdentity(db, "  Same@Example.COM  ", "\tSAME@example.com\t");
  assert.equal(r.matched, true);
  assert.equal(r.identity, "same@example.com");
  assert.equal(db._queryCount(), 1, "normalized-duplicate identities must issue one query");
});

// ── Negative / edge ─────────────────────────────────────────────────────────

test("neither blocked → matched=false", async () => {
  const db = makeFakeBlockedDb(new Set());
  const r = await resolveBlockedSenderIdentity(db, "a@b.com", "c@d.com");
  assert.equal(r.matched, false);
  assert.equal(r.identity, null);
});

test("null header + null envelope → matched=false", async () => {
  const db = makeFakeBlockedDb(new Set(["x@y.com"]));
  const r = await resolveBlockedSenderIdentity(db, null, null);
  assert.equal(r.matched, false);
  assert.equal(db._queryCount(), 0, "no query when no identities");
});

// ── Error propagation ───────────────────────────────────────────────────────

test("D1 .all() failure propagates", async () => {
  const db = {
    prepare() {
      return {
        bind() {
          return { all: () => { throw new Error("D1 down"); } };
        },
      };
    },
  } as any;
  await assert.rejects(
    () => resolveBlockedSenderIdentity(db, "a@b.com", "c@d.com"),
    /D1 down/,
  );
});

// ── SQL shape ───────────────────────────────────────────────────────────────

test("two distinct identities issue exactly one query", async () => {
  const db = makeFakeBlockedDb(new Set());
  await resolveBlockedSenderIdentity(db, "a@example.com", "b@example.com");
  assert.equal(db._queryCount(), 1);
});

test("generated SQL contains IN clause and no CASE/ORDER BY", async () => {
  const db = makeFakeBlockedDb(new Set());
  await resolveBlockedSenderIdentity(db, "a@example.com", "b@example.com");
  const sql = db._lastSql().toUpperCase();
  assert.ok(sql.includes("IN ("), "SQL must contain IN clause");
  assert.ok(!sql.includes("ORDER BY"), "SQL must NOT contain ORDER BY");
  assert.ok(!sql.includes("CASE"), "SQL must NOT contain CASE expression");
});
