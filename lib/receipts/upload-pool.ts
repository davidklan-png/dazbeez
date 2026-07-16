// Client-safe FIFO semaphore for desktop multi-file uploads. No React, no
// server-only imports — pure logic extracted from ReceiptCaptureForm so it can
// be unit-tested and reused.

/**
 * A concurrency-limited FIFO pool. At most `limit` acquires are active at once;
 * further acquires resolve in arrival order (FIFO) as slots are released.
 *
 * Slot handoff model: when release() is called with waiters, the held slot is
 * transferred directly to the next waiter (active count unchanged) — this is
 * what guarantees no leaked active count and no stranded waiters, because every
 * waiter corresponds to capacity currently held by a runner that will release.
 *
 * Contract: the caller MUST call slot.release() when its work ends — typically
 * via try/finally, so a thrown/rejected task still frees its slot.
 * slot.release() is idempotent (double-release is a no-op).
 */
export interface PoolSlot {
  /** Release the slot. Idempotent: a second call is a no-op. */
  release: () => void;
}

export class UploadPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `UploadPool limit must be a positive integer (got ${limit})`,
      );
    }
  }

  /** Number of slots currently held by running work. */
  get activeCount(): number {
    return this.active;
  }

  /** Number of acquires waiting for a slot. */
  get queuedCount(): number {
    return this.waiters.length;
  }

  /** Resolve once a slot is available; release() the returned slot when done. */
  async acquire(): Promise<PoolSlot> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.makeSlot();
    }
    // Queue: resolve only when a runner hands off its slot via release().
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // active was already counted for us by the handoff in release().
    return this.makeSlot();
  }

  private makeSlot(): PoolSlot {
    let released = false;
    const release = () => {
      if (released) return; // idempotent — defend against double-release
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Hand the slot directly to the next waiter; active stays the same.
        next();
      } else {
        // No waiter — actually free the slot.
        this.active -= 1;
      }
    };
    return { release };
  }
}
