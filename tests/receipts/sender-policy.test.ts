// Tests for sender-policy.ts transitions (finding 10: concurrency-safe
// mutual-exclusion transitions). Uses a structural fake D1 that accurately
// models batch change counts — a fake whose batch() is a no-op is NOT adequate.

import test from "node:test";
import assert from "node:assert/strict";
import {
  trustSender,
  blockSender,
  untrustSender,
  unblockSender,
  resolveSenderState,
} from "@/lib/receipts/sender-policy";

// ─── Structural fake D1 ───────────────────────────────────────────────────
// Models trusted_intake_senders + blocked_intake_senders Sets, tracks audit
// inserts, and reports accurate change counts per statement (including batch).

function makeFakeDb() {
  const trusted = new Map<string, { added_by: string; created_at: string }>();
  const blocked = new Map<string, { blocked_by: string; created_at: string }>();
  const audits: { action: string; objectId: string }[] = [];

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
      // binds: [id, actor, action, objectType, objectId, oldJson, newJson, createdAt]
      audits.push({ action: binds[2] as string, objectId: binds[4] as string });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }

  function queryFirst(sql: string, binds: unknown[]): Record<string, unknown> | null {
    const s = sql.trim().toUpperCase();
    if (s.includes("FROM BLOCKED_INTAKE_SENDERS")) {
      return blocked.has(binds[0] as string) ? { "1": 1 } : null;
    }
    if (s.includes("FROM TRUSTED_INTAKE_SENDERS")) {
      return trusted.has(binds[0] as string) ? { "1": 1 } : null;
    }
    return null;
  }

  function prep(sql: string) {
    return {
      bind(...args: unknown[]) {
        return {
          run: () => exec(sql, args),
          first: () => queryFirst(sql, args),
          all: () => ({ results: [] }),
        };
      },
    };
  }

  return {
    prepare: prep,
    batch: (stmts: Array<{ bind: (...a: unknown[]) => { run: () => unknown } }>) => {
      // Each batch element is a prepared statement that was .bind() called.
      // But D1 batch takes UNBOUND prepared statements + the batch itself
      // doesn't rebind. In practice, sender-policy.ts calls db.batch([
      // db.prepare(sql).bind(args), ...]) — so each element is already bound.
      // We handle this by re-executing via the stored SQL + binds.
      // Workaround: the fake's prepare().bind() returns an object whose .run()
      // executes; for batch, we call each element's underlying exec.
      // Since our bind() returns a new object each time, we need a different
      // approach: make batch accept the bound statements and call their .run().
      return stmts.map((stmt: any) => {
        if (typeof stmt?.run === "function") return stmt.run();
        return { meta: { changes: 0 } };
      });
    },
    _trusted: trusted,
    _blocked: blocked,
    _audits: audits,
  } as any;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("trustSender: new sender → trusted + audit trusted_sender.added", async () => {
  const db = makeFakeDb();
  await trustSender(db, "foo@example.com", "david");
  assert.ok(db._trusted.has("foo@example.com"));
  assert.equal(db._audits.filter((a: { action: string; objectId: string }) => a.action === "trusted_sender.added").length, 1);
  assert.equal(db._audits.filter((a: { action: string; objectId: string }) => a.action === "blocked_sender.removed").length, 0);
});

test("trustSender: already trusted → idempotent, no audit, created_at preserved", async () => {
  const db = makeFakeDb();
  await trustSender(db, "foo@example.com", "david");
  const firstCreatedAt = db._trusted.get("foo@example.com").created_at;
  await trustSender(db, "foo@example.com", "david"); // idempotent
  assert.equal(db._trusted.get("foo@example.com").created_at, firstCreatedAt);
  // Only 1 audit entry total (no duplicate).
  assert.equal(db._audits.filter((a: { action: string; objectId: string }) => a.action === "trusted_sender.added").length, 1);
});

test("trustSender: was blocked → removes blocked + audits both changes", async () => {
  const db = makeFakeDb();
  await blockSender(db, "foo@example.com", "david");
  assert.ok(db._blocked.has("foo@example.com"));
  await trustSender(db, "foo@example.com", "david");
  assert.ok(!db._blocked.has("foo@example.com"));
  assert.ok(db._trusted.has("foo@example.com"));
  assert.ok(db._audits.some((a: { action: string; objectId: string }) => a.action === "blocked_sender.removed"));
  assert.ok(db._audits.some((a: { action: string; objectId: string }) => a.action === "trusted_sender.added"));
});

test("blockSender: new → blocked + audit blocked_sender.added", async () => {
  const db = makeFakeDb();
  await blockSender(db, "spam@evil.com", "david");
  assert.ok(db._blocked.has("spam@evil.com"));
  assert.equal(db._audits.filter((a: { action: string; objectId: string }) => a.action === "blocked_sender.added").length, 1);
});

test("blockSender: was trusted → removes trusted + audits both", async () => {
  const db = makeFakeDb();
  await trustSender(db, "foo@example.com", "david");
  await blockSender(db, "foo@example.com", "david");
  assert.ok(!db._trusted.has("foo@example.com"));
  assert.ok(db._blocked.has("foo@example.com"));
  assert.ok(db._audits.some((a: { action: string; objectId: string }) => a.action === "trusted_sender.removed"));
  assert.ok(db._audits.some((a: { action: string; objectId: string }) => a.action === "blocked_sender.added"));
});

test("blockSender: already blocked → idempotent, no duplicate audit", async () => {
  const db = makeFakeDb();
  await blockSender(db, "spam@evil.com", "david");
  await blockSender(db, "spam@evil.com", "david");
  assert.equal(db._audits.filter((a: { action: string; objectId: string }) => a.action === "blocked_sender.added").length, 1);
});

test("untrustSender: removes + audits only if present", async () => {
  const db = makeFakeDb();
  await trustSender(db, "foo@example.com", "david");
  await untrustSender(db, "foo@example.com", "david");
  assert.ok(!db._trusted.has("foo@example.com"));
  assert.ok(db._audits.some((a: { action: string; objectId: string }) => a.action === "trusted_sender.removed"));
  // Idempotent: untrust again → no extra audit
  const auditCountBefore = db._audits.length;
  await untrustSender(db, "foo@example.com", "david");
  assert.equal(db._audits.length, auditCountBefore);
});

test("unblockSender: removes + audits only if present", async () => {
  const db = makeFakeDb();
  await blockSender(db, "spam@evil.com", "david");
  await unblockSender(db, "spam@evil.com", "david");
  assert.ok(!db._blocked.has("spam@evil.com"));
  assert.ok(db._audits.some((a: { action: string; objectId: string }) => a.action === "blocked_sender.removed"));
});

test("resolveSenderState: blocked wins if in both tables (defensive)", async () => {
  const db = makeFakeDb();
  // Manually seed inconsistent state (both tables)
  db._trusted.set("dual@example.com", { added_by: "x", created_at: "2026-01-01" });
  db._blocked.set("dual@example.com", { blocked_by: "x", created_at: "2026-01-01" });
  const state = await resolveSenderState(db, "dual@example.com");
  assert.equal(state, "blocked");
});

test("resolveSenderState: unrecognized when in neither", async () => {
  const db = makeFakeDb();
  const state = await resolveSenderState(db, "unknown@example.com");
  assert.equal(state, "unrecognized");
});

test("trustSender: invalid email → throws", async () => {
  const db = makeFakeDb();
  await assert.rejects(() => trustSender(db, "not-an-email", "david"), /valid email/);
});

test("blockSender: invalid email → throws", async () => {
  const db = makeFakeDb();
  await assert.rejects(() => blockSender(db, "not-an-email", "david"), /valid email/);
});
