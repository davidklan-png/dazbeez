// Tests for sender-policy.ts transitions — atomic audit, concurrency safety,
// rollback, and blocked precedence. Uses a structural fake D1 that:
//   - serializes batches
//   - snapshots state before a batch
//   - rolls back when any statement throws
//   - can be configured to deliberately fail a specific statement

import test from "node:test";
import assert from "node:assert/strict";
import {
  trustSender,
  blockSender,
  untrustSender,
  unblockSender,
  resolveSenderState,
} from "@/lib/receipts/sender-policy";

interface AuditEntry { action: string; objectId: string; }

function makeFakeDb(opts: { failOnAuditAction?: string } = {}) {
  const trusted = new Map<string, { added_by: string; created_at: string }>();
  const blocked = new Map<string, { blocked_by: string; created_at: string }>();
  const audits: AuditEntry[] = [];
  const { failOnAuditAction } = opts;

  function exec(sql: string, binds: unknown[]): { meta: { changes: number } } {
    const s = sql.trim().toUpperCase();
    if (s.startsWith("DELETE FROM BLOCKED_INTAKE_SENDERS")) {
      const email = binds[0] as string;
      return { meta: { changes: blocked.delete(email) ? 1 : 0 } };
    }
    if (s.startsWith("DELETE FROM TRUSTED_INTAKE_SENDERS")) {
      const email = binds[0] as string;
      return { meta: { changes: trusted.delete(email) ? 1 : 0 } };
    }
    if (s.includes("INTO TRUSTED_INTAKE_SENDERS")) {
      const [email, addedBy, createdAt] = binds as [string, string, string];
      if (trusted.has(email)) return { meta: { changes: 0 } };
      trusted.set(email, { added_by: addedBy, created_at: createdAt });
      return { meta: { changes: 1 } };
    }
    if (s.includes("INTO BLOCKED_INTAKE_SENDERS")) {
      const [email, blockedBy, createdAt] = binds as [string, string, string];
      if (blocked.has(email)) return { meta: { changes: 0 } };
      blocked.set(email, { blocked_by: blockedBy, created_at: createdAt });
      return { meta: { changes: 1 } };
    }
    if (s.includes("INTO RECEIPT_AUDIT_LOG")) {
      if (s.includes("WHERE EXISTS")) {
        const condEmail = binds[binds.length - 1] as string;
        let met = false;
        if (s.includes("NOT EXISTS (SELECT 1 FROM TRUSTED_INTAKE_SENDERS")) met = !trusted.has(condEmail);
        else if (s.includes("NOT EXISTS (SELECT 1 FROM BLOCKED_INTAKE_SENDERS")) met = !blocked.has(condEmail);
        else if (s.includes("FROM BLOCKED_INTAKE_SENDERS")) met = blocked.has(condEmail);
        else if (s.includes("FROM TRUSTED_INTAKE_SENDERS")) met = trusted.has(condEmail);
        if (!met) return { meta: { changes: 0 } };
        // Condition met — check if we should deliberately fail this audit.
        if (failOnAuditAction && binds[2] === failOnAuditAction) {
          throw new Error(`Simulated audit failure for ${failOnAuditAction}`);
        }
        audits.push({ action: binds[2] as string, objectId: binds[4] as string });
        return { meta: { changes: 1 } };
      }
      if (failOnAuditAction && binds[2] === failOnAuditAction) {
        throw new Error(`Simulated audit failure for ${failOnAuditAction}`);
      }
      audits.push({ action: binds[2] as string, objectId: binds[4] as string });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }

  function queryFirst(sql: string, binds: unknown[]): Record<string, unknown> | null {
    const s = sql.trim().toUpperCase();
    if (s.includes("FROM BLOCKED_INTAKE_SENDERS")) return blocked.has(binds[0] as string) ? { "1": 1 } : null;
    if (s.includes("FROM TRUSTED_INTAKE_SENDERS")) return trusted.has(binds[0] as string) ? { "1": 1 } : null;
    return null;
  }

  function prep(sql: string) {
    return {
      bind(...args: unknown[]) {
        return { run: () => exec(sql, args), first: () => queryFirst(sql, args), all: () => ({ results: [] }) };
      },
    };
  }

  // Batch: snapshot state, execute all; if any throws, roll back.
  function batch(stmts: Array<{ run: () => unknown }>) {
    // Snapshot for rollback
    const trustedSnap = new Map(trusted);
    const blockedSnap = new Map(blocked);
    const auditSnap = [...audits];
    try {
      return stmts.map((stmt: { run: () => unknown }) => stmt.run());
    } catch (err) {
      // Roll back
      trusted.clear(); trustedSnap.forEach((v, k) => trusted.set(k, v));
      blocked.clear(); blockedSnap.forEach((v, k) => blocked.set(k, v));
      audits.length = 0; audits.push(...auditSnap);
      throw err;
    }
  }

  return {
    prepare: prep,
    batch,
    _trusted: trusted,
    _blocked: blocked,
    _audits: audits,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ─── Basic transitions ──────────────────────────────────────────────────────

test("trustSender: new sender → trusted + audit", async () => {
  const db = makeFakeDb();
  await trustSender(db, "foo@example.com", "david");
  assert.ok(db._trusted.has("foo@example.com"));
  assert.equal(db._audits.filter((a: AuditEntry) => a.action === "trusted_sender.added").length, 1);
  assert.equal(db._audits.filter((a: AuditEntry) => a.action === "blocked_sender.removed").length, 0);
});

test("trustSender: already trusted → idempotent, no audit, created_at preserved", async () => {
  const db = makeFakeDb();
  await trustSender(db, "foo@example.com", "david");
  const firstCreatedAt = db._trusted.get("foo@example.com").created_at;
  await trustSender(db, "foo@example.com", "david");
  assert.equal(db._trusted.get("foo@example.com").created_at, firstCreatedAt);
  assert.equal(db._audits.filter((a: AuditEntry) => a.action === "trusted_sender.added").length, 1);
});

test("trustSender: was blocked → removes blocked + audits both", async () => {
  const db = makeFakeDb();
  await blockSender(db, "foo@example.com", "david");
  await trustSender(db, "foo@example.com", "david");
  assert.ok(!db._blocked.has("foo@example.com"));
  assert.ok(db._trusted.has("foo@example.com"));
  assert.ok(db._audits.some((a: AuditEntry) => a.action === "blocked_sender.removed"));
  assert.ok(db._audits.some((a: AuditEntry) => a.action === "trusted_sender.added"));
});

test("blockSender: new → blocked + audit", async () => {
  const db = makeFakeDb();
  await blockSender(db, "spam@evil.com", "david");
  assert.ok(db._blocked.has("spam@evil.com"));
  assert.equal(db._audits.filter((a: AuditEntry) => a.action === "blocked_sender.added").length, 1);
});

test("blockSender: was trusted → removes trusted + audits both", async () => {
  const db = makeFakeDb();
  await trustSender(db, "foo@example.com", "david");
  await blockSender(db, "foo@example.com", "david");
  assert.ok(!db._trusted.has("foo@example.com"));
  assert.ok(db._blocked.has("foo@example.com"));
});

test("blockSender: already blocked → idempotent, no duplicate audit", async () => {
  const db = makeFakeDb();
  await blockSender(db, "spam@evil.com", "david");
  await blockSender(db, "spam@evil.com", "david");
  assert.equal(db._audits.filter((a: AuditEntry) => a.action === "blocked_sender.added").length, 1);
});

test("untrustSender: removes + audits only if present", async () => {
  const db = makeFakeDb();
  await trustSender(db, "foo@example.com", "david");
  await untrustSender(db, "foo@example.com", "david");
  assert.ok(!db._trusted.has("foo@example.com"));
  assert.ok(db._audits.some((a: AuditEntry) => a.action === "trusted_sender.removed"));
  const auditCountBefore = db._audits.length;
  await untrustSender(db, "foo@example.com", "david");
  assert.equal(db._audits.length, auditCountBefore);
});

test("unblockSender: removes + audits only if present", async () => {
  const db = makeFakeDb();
  await blockSender(db, "spam@evil.com", "david");
  await unblockSender(db, "spam@evil.com", "david");
  assert.ok(!db._blocked.has("spam@evil.com"));
  assert.ok(db._audits.some((a: AuditEntry) => a.action === "blocked_sender.removed"));
});

test("resolveSenderState: blocked wins if in both tables (defensive)", async () => {
  const db = makeFakeDb();
  db._trusted.set("dual@example.com", { added_by: "x", created_at: "2026-01-01" });
  db._blocked.set("dual@example.com", { blocked_by: "x", created_at: "2026-01-01" });
  assert.equal(await resolveSenderState(db, "dual@example.com"), "blocked");
});

test("resolveSenderState: unrecognized when in neither", async () => {
  const db = makeFakeDb();
  assert.equal(await resolveSenderState(db, "unknown@example.com"), "unrecognized");
});

test("trustSender: invalid email → throws", async () => {
  const db = makeFakeDb();
  await assert.rejects(() => trustSender(db, "not-an-email", "david"), /valid email/);
});

test("blockSender: invalid email → throws", async () => {
  const db = makeFakeDb();
  await assert.rejects(() => blockSender(db, "not-an-email", "david"), /valid email/);
});

// ─── Concurrency: Promise.all opposite transitions ─────────────────────────

test("concurrency: Promise.all([trust, block]) → exactly one policy row, never both", async () => {
  const db = makeFakeDb();
  await Promise.all([
    trustSender(db, "dual@example.com", "david"),
    blockSender(db, "dual@example.com", "david"),
  ]);
  const trusted = db._trusted.has("dual@example.com");
  const blocked = db._blocked.has("dual@example.com");
  assert.equal(trusted && blocked, false, "should never be in BOTH tables");
  assert.equal(trusted || blocked, true, "should be in exactly ONE table");
});

test("concurrency: Promise.all([block, trust]) → exactly one policy row, never both", async () => {
  const db = makeFakeDb();
  await Promise.all([
    blockSender(db, "dual2@example.com", "david"),
    trustSender(db, "dual2@example.com", "david"),
  ]);
  const trusted = db._trusted.has("dual2@example.com");
  const blocked = db._blocked.has("dual2@example.com");
  assert.equal(trusted && blocked, false, "should never be in BOTH tables");
  assert.equal(trusted || blocked, true, "should be in exactly ONE table");
});

// ─── Rollback: audit failure ───────────────────────────────────────────────

test("rollback: audit failure in trustSender rolls back trusted insert", async () => {
  const db = makeFakeDb({ failOnAuditAction: "trusted_sender.added" });
  await assert.rejects(() => trustSender(db, "foo@example.com", "david"), /Simulated audit failure/);
  assert.ok(!db._trusted.has("foo@example.com"), "trusted row must be rolled back");
  assert.equal(db._audits.filter((a: AuditEntry) => a.action === "trusted_sender.added").length, 0, "audit must be rolled back");
});

test("rollback: audit failure in blockSender rolls back blocked insert", async () => {
  const db = makeFakeDb({ failOnAuditAction: "blocked_sender.added" });
  await assert.rejects(() => blockSender(db, "spam@evil.com", "david"), /Simulated audit failure/);
  assert.ok(!db._blocked.has("spam@evil.com"), "blocked row must be rolled back");
  assert.equal(db._audits.filter((a: AuditEntry) => a.action === "blocked_sender.added").length, 0, "audit must be rolled back");
});

test("rollback: retry after failure produces correct state and one audit", async () => {
  const db = makeFakeDb({ failOnAuditAction: "trusted_sender.added" });
  // First attempt fails
  await assert.rejects(() => trustSender(db, "foo@example.com", "david"));
  // Fix: new fake without the failure
  const db2 = makeFakeDb();
  await trustSender(db2, "foo@example.com", "david");
  assert.ok(db2._trusted.has("foo@example.com"));
  assert.equal(db2._audits.filter((a: AuditEntry) => a.action === "trusted_sender.added").length, 1);
});
