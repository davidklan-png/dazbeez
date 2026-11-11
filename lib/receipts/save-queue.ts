// Client-safe serialized save queue for the receipt review form. No React, no
// server-only imports — pure logic (repo convention: upload-pool.ts) so the
// ordering contract is unit-testable with an injected fetch.
//
// Why this exists (same-session save ordering, 2026-11): the old debounce
// aborted the in-flight PATCH and fired a new one, but fetch.abort() is
// client-side only — an already-sent PATCH still applies server-side, and the
// server (updateReceiptRecord) is last-write-wins with no CAS. Two overlapping
// PATCHes could therefore commit out of order and let an OLDER field snapshot
// overwrite a newer one. "Mark reviewed" additionally fired its own PATCH
// without waiting for an in-flight autosave, so a slow autosave could revert
// the operator's last edits on a receipt already navigated away from.
//
// Contract established here:
//   • At most ONE PATCH in flight per receipt. Requests strictly serialize —
//     an earlier snapshot always commits BEFORE a later save is even sent.
//   • While a request is in flight, later save requests coalesce into a single
//     pending flush whose body is built from the LATEST state at fire time
//     (never a stale snapshot), so coalescing never drops newer fields.
//   • A markReviewed request rides the pending flush (sticky) and its promise
//     resolves only once that flush has committed — save-and-next can then
//     navigate knowing nothing older can land after it.
//   • Failures reject every waiter joined to that flush; callers decide how to
//     surface them (the form stays open with an honest error).
//   • No client aborts anywhere: serialization removes the need, and aborting
//     never stopped the server anyway.
//
// ponytail: this is client-only ordering. Cross-tab / cross-session
// last-write-wins remains (no server CAS by design v1); the module-scoped
// registry below is unbounded within a session (one small queue per reviewed
// receipt) — fine for a reviewing session, revisit if that ever matters.

export type SaveFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Builds the PATCH body. Called at FIRE time so coalesced flushes always
 * carry the latest fields. `markReviewed` is true only when a save-and-next
 * rider is pending — the caller decides (via receipt-status policy) whether
 * that means including `status` in the body. */
export type SaveBodyBuilder = (markReviewed: boolean) => Record<string, unknown>;

export interface SaveQueueConfig {
  url: string;
  buildBody: SaveBodyBuilder;
  fetchImpl?: SaveFetch;
  /** Return true to HOLD the pending flush (e.g. IME composition is active —
   * firing would read an uncommitted business-purpose value). The next
   * save() call re-attempts the drain. */
  deferFire?: () => boolean;
}

export interface SaveSuccess {
  warnings: string[];
}

interface Waiter {
  resolve: (success: SaveSuccess) => void;
  reject: (error: Error) => void;
}

export class SaveQueue {
  private config: SaveQueueConfig;
  private inFlight = false;
  private hasPending = false;
  private pendingMarkReviewed = false;
  /** Body snapshot pinned at enqueue time (unmount flush). Null = build at
   * fire time from the latest state. */
  private pinnedBody: Record<string, unknown> | null = null;
  private waiters: Waiter[] = [];

  constructor(config: SaveQueueConfig) {
    this.config = config;
  }

  /** Replace the closures (form re-renders hand in fresh ones over the latest
   * field state; a remounted form must not fire the previous instance's
   * builder). The url is constant per queue key. */
  rebind(config: SaveQueueConfig): void {
    this.config = config;
  }

  /** True when nothing is in flight and no flush is waiting. */
  get idle(): boolean {
    return !this.inFlight && !this.hasPending;
  }

  /**
   * Request a save. Resolves once a PATCH carrying this request's intent has
   * COMMITTED (possibly coalesced with later requests into one flush — the
   * flush always carries the latest fields, so the intent is satisfied).
   * Rejects with the server/network error if that flush fails.
   *
   * `pinBody: true` snapshots the body NOW instead of at fire time — used by
   * the unmount flush, where a same-receipt remount could rebind the builder
   * to stale server props before an in-flight request drains.
   */
  save(
    markReviewed = false,
    opts: { pinBody?: boolean } = {},
  ): Promise<SaveSuccess> {
    return new Promise<SaveSuccess>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.hasPending = true;
      if (markReviewed) this.pendingMarkReviewed = true;
      if (opts.pinBody) {
        this.pinnedBody = this.config.buildBody(markReviewed);
      }
      this.drain();
    });
  }

  private drain(): void {
    if (this.inFlight || !this.hasPending) return;
    if (this.config.deferFire?.()) return; // held; next save() re-attempts
    this.inFlight = true;
    this.hasPending = false;
    const markReviewed = this.pendingMarkReviewed;
    this.pendingMarkReviewed = false;
    const pinned = this.pinnedBody;
    this.pinnedBody = null;
    const waiters = this.waiters;
    this.waiters = [];
    // Capture the config BEFORE awaiting — a remount may rebind mid-flight.
    const { url, fetchImpl = defaultFetch } = this.config;
    const body = pinned ?? this.config.buildBody(markReviewed);
    void this.fire(url, body, waiters, fetchImpl);
  }

  private async fire(
    url: string,
    body: Record<string, unknown>,
    waiters: Waiter[],
    fetchImpl: SaveFetch,
  ): Promise<void> {
    let result: SaveSuccess | Error;
    try {
      const res = await fetchImpl(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // Survives page unload / SPA route changes; bodies are small JSON,
        // far under the 64 KB keepalive limit.
        keepalive: true,
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        warnings?: string[];
      };
      result = res.ok
        ? { warnings: json.warnings ?? [] }
        : new Error(json.error ?? "Save failed");
    } catch {
      result = new Error("Network error");
    }
    this.inFlight = false;
    for (const waiter of waiters) {
      if (result instanceof Error) waiter.reject(result);
      else waiter.resolve(result);
    }
    this.drain();
  }
}

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

// Module-scoped registry keyed by receipt id. A remount of the SAME receipt
// (navigate away and back while a flush is still draining) joins the existing
// queue instead of racing it with a parallel PATCH — that reordering is the
// one case a per-instance queue cannot prevent. Different receipts get
// different queues (disjoint rows — parallel is safe).
const queues = new Map<string, SaveQueue>();

/** Get-or-create the queue for a receipt, rebinding the caller's latest
 * closures into it. Call from render; it is cheap (one Map hit). */
export function getSaveQueue(key: string, config: SaveQueueConfig): SaveQueue {
  const existing = queues.get(key);
  if (existing) {
    existing.rebind(config);
    return existing;
  }
  const queue = new SaveQueue(config);
  queues.set(key, queue);
  return queue;
}
