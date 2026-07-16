import test from "node:test";
import assert from "node:assert/strict";
import { UploadPool, type PoolSlot } from "@/lib/receipts/upload-pool";

/** Flush the microtask queue + one macrotask so async acquire() resolves. */
const tick = () => new Promise<void>((r) => setImmediate(r));

test("UploadPool: limit must be a positive integer", () => {
  assert.throws(() => new UploadPool(0), /positive integer/);
  assert.throws(() => new UploadPool(-1), /positive integer/);
  assert.throws(() => new UploadPool(1.5), /positive integer/);
});

test("UploadPool: admits exactly `limit` then FIFO-queues the rest", async () => {
  const pool = new UploadPool(3);
  const slots: PoolSlot[] = [];
  const labels: string[] = [];

  const acquire = (label: string) =>
    pool.acquire().then((slot) => {
      labels.push(label);
      slots.push(slot);
      return slot;
    });

  // Fire five acquires synchronously.
  const pending = ["A", "B", "C", "D", "E"].map(acquire);
  await tick(); // A,B,C resolve immediately; D,E queue.

  assert.equal(pool.activeCount, 3);
  assert.equal(pool.queuedCount, 2);
  assert.deepEqual(labels, ["A", "B", "C"]);

  // Release A → D acquires (FIFO handoff, active unchanged).
  slots[0]!.release();
  await tick();
  assert.equal(pool.activeCount, 3);
  assert.equal(pool.queuedCount, 1);
  assert.deepEqual(labels, ["A", "B", "C", "D"]);

  // Release B → E acquires.
  slots[1]!.release();
  await tick();
  assert.deepEqual(labels, ["A", "B", "C", "D", "E"]);
  assert.equal(pool.queuedCount, 0);

  // Drain: active returns to 0, no leak.
  for (const s of slots.slice(2)) s.release();
  await tick();
  assert.equal(pool.activeCount, 0);
  assert.equal(pool.queuedCount, 0);
  // All acquires settled (no stranded waiters).
  await Promise.all(pending);
});

test("UploadPool: at most `limit` tasks run concurrently", async () => {
  const pool = new UploadPool(3);
  let active = 0;
  let maxActive = 0;
  const task = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await tick();
    active -= 1;
  };

  await Promise.all(
    Array.from({ length: 6 }, () =>
      pool.acquire().then(async (slot) => {
        try {
          await task();
        } finally {
          slot.release();
        }
      }),
    ),
  );

  assert.equal(maxActive, 3);
  assert.equal(pool.activeCount, 0);
});

test("UploadPool: slot is released when the task rejects (try/finally)", async () => {
  const pool = new UploadPool(1);
  const run = async (shouldThrow: boolean) => {
    const slot = await pool.acquire();
    try {
      if (shouldThrow) throw new Error("boom");
      await tick();
    } finally {
      slot.release();
    }
  };

  await assert.rejects(run(true), /boom/);
  assert.equal(pool.activeCount, 0); // freed despite the throw

  // A follow-up acquire works immediately — no leaked slot.
  const slot = await pool.acquire();
  assert.equal(pool.activeCount, 1);
  slot.release();
  assert.equal(pool.activeCount, 0);
});

test("UploadPool: double release is a no-op (no negative active)", async () => {
  const pool = new UploadPool(2);
  const slot = await pool.acquire();
  assert.equal(pool.activeCount, 1);
  slot.release();
  slot.release(); // idempotent
  assert.equal(pool.activeCount, 0);

  const s2 = await pool.acquire();
  assert.equal(pool.activeCount, 1);
  s2.release();
});
