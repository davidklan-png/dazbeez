// Tests for lib/receipts/trusted-senders.ts (ADR 0011 Phase B follow-up).
//
// The data functions take an injected D1 (the recordIntake/testability
// precedent), so add/list/remove round-trip through a structural fake D1 that
// models just the SQL shapes trusted-senders.ts issues (SELECT/INSERT/DELETE on
// trusted_intake_senders + the audit-log INSERT). Mirrors the email-intake fake.

import test from "node:test";
import assert from "node:assert/strict";
import {
  listTrustedSenders,
  addTrustedSender,
  removeTrustedSender,
  isValidSenderEmail,
} from "@/lib/receipts/trusted-senders";
import type { TrustedIntakeSender } from "@/lib/receipts/trusted-senders";

interface FakeDb {
  rows: TrustedIntakeSender[];
  auditInserts: number;
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
  // Stubs so the fake structurally satisfies D1Database (createAuditEntry path).
  batch(_s: unknown[]): Promise<unknown[]>;
  exec(_q: string): Promise<unknown>;
  withSession(): unknown;
  dump(): Promise<ArrayBuffer>;
}

function createFakeDb(initial: TrustedIntakeSender[] = []): FakeDb {
  const db: FakeDb = {
    rows: initial.map((r) => ({ ...r })),
    auditInserts: 0,
    batch: async () => [],
    exec: async () => ({}),
    withSession: () => ({}),
    dump: async () => new ArrayBuffer(0),
    prepare(sql: string) {
      // Real D1 statements expose first/all/run BOTH directly (unparameterized)
      // AND after .bind(). Support both shapes.
      const makeStatement = (args: unknown[]) => ({
        async first<T>(): Promise<T | null> {
          if (/SELECT 1 FROM trusted_intake_senders WHERE email = \?/.test(sql)) {
            const email = String(args[0]);
            return (db.rows.find((r) => r.email === email) ?? null) as T | null;
          }
          return null as T | null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (/FROM trusted_intake_senders/.test(sql)) {
            const rows = [...db.rows].sort((a, b) =>
              a.created_at.localeCompare(b.created_at),
            );
            return { results: rows as unknown as T[] };
          }
          return { results: [] };
        },
        async run(): Promise<unknown> {
          if (/INSERT INTO trusted_intake_senders/.test(sql)) {
            db.rows.push({
              email: String(args[0]),
              added_by: String(args[1]),
              created_at: String(args[2]),
            });
          } else if (/DELETE FROM trusted_intake_senders/.test(sql)) {
            const email = String(args[0]);
            db.rows = db.rows.filter((r) => r.email !== email);
          } else if (/INSERT INTO receipt_audit_log/.test(sql)) {
            db.auditInserts += 1;
          }
          return {};
        },
        bind(...more: unknown[]) {
          return makeStatement([...args, ...more]);
        },
      });
      return makeStatement([]);
    },
  };
  return db;
}

function asD1(db: FakeDb): D1Database {
  return db as unknown as D1Database;
}

// ─── isValidSenderEmail (pure) ──────────────────────────────────────────────

test("isValidSenderEmail: accepts well-formed addresses", () => {
  assert.equal(isValidSenderEmail("david@gmail.com"), true);
  assert.equal(isValidSenderEmail("  Foo.Bar+tags@Example.co.jp  "), true);
});

test("isValidSenderEmail: rejects obviously-malformed input", () => {
  assert.equal(isValidSenderEmail("notanemail"), false);
  assert.equal(isValidSenderEmail("no-at-sign.com"), false);
  assert.equal(isValidSenderEmail("spaces in@address.com"), false);
  assert.equal(isValidSenderEmail("@nodomain.com"), false);
  assert.equal(isValidSenderEmail("a@b"), false); // no TLD
  assert.equal(isValidSenderEmail("   "), false);
});

// ─── add / list / remove round-trip ─────────────────────────────────────────

test("addTrustedSender: stores + round-trips through listTrustedSenders", async () => {
  const db = createFakeDb();
  await addTrustedSender(asD1(db), "david@gmail.com", "david");
  const listed = await listTrustedSenders(asD1(db));
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.email, "david@gmail.com");
  assert.equal(listed[0]!.added_by, "david");
});

test("addTrustedSender: normalizes to lowercase + trims on write", async () => {
  const db = createFakeDb();
  await addTrustedSender(asD1(db), "  David@Gmail.com  ", "david");
  const listed = await listTrustedSenders(asD1(db));
  assert.equal(listed[0]!.email, "david@gmail.com");
});

test("addTrustedSender: idempotent — re-adding is a no-op (1 row, 1 audit)", async () => {
  const db = createFakeDb();
  await addTrustedSender(asD1(db), "david@gmail.com", "david");
  assert.equal(db.auditInserts, 1, "first add writes one audit entry");
  // Re-add with different case → same normalized key → no-op.
  await addTrustedSender(asD1(db), "DAVID@Gmail.com", "david");
  const listed = await listTrustedSenders(asD1(db));
  assert.equal(listed.length, 1, "duplicate add does not create a second row");
  assert.equal(db.auditInserts, 1, "idempotent re-add writes no second audit");
});

test("addTrustedSender: rejects malformed input with a clear error", async () => {
  const db = createFakeDb();
  await assert.rejects(
    () => addTrustedSender(asD1(db), "not-an-email", "david"),
    /not a valid email address/i,
  );
  assert.equal((await listTrustedSenders(asD1(db))).length, 0, "rejected add stores nothing");
  assert.equal(db.auditInserts, 0, "rejected add writes no audit entry");
});

test("removeTrustedSender: deletes + audits; normalizes before lookup", async () => {
  const db = createFakeDb();
  await addTrustedSender(asD1(db), "david@gmail.com", "david");
  assert.equal(db.auditInserts, 1);
  await removeTrustedSender(asD1(db), "DAVID@Gmail.com", "david");
  assert.equal((await listTrustedSenders(asD1(db))).length, 0, "removed");
  assert.equal(db.auditInserts, 2, "removal writes an audit entry");
});

test("removeTrustedSender: absent address is a silent no-op (no audit)", async () => {
  const db = createFakeDb();
  await removeTrustedSender(asD1(db), "nobody@nowhere.com", "david");
  assert.equal(db.auditInserts, 0, "removing a non-existent sender writes no audit");
});
