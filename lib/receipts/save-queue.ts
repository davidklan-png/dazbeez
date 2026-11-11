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
// One queue per mounted form instance (form-pane creates it in a ref and
// REBINDS the latest closures every render). Navigation callers await saves
// through lib/receipts/review-navigation.ts BEFORE routing, so commits
// complete before the form can unmount — there is deliberately no
// fire-and-forget machinery here.
//
// ponytail: this is client-only ordering. Cross-tab / cross-session
// last-write-wins remains (no server CAS by design v1).

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

/**
 * A transport-level loss (fetch rejected) means the request MAY have been
 * applied server-side — the outcome is UNKNOWN, not failed. Once that
 * happens the queue HALTS: no further request is sent automatically (a
 * later flush could not be claimed safely ordered if the unknown one still
 * commits), pending waiters are rejected with this guidance (fields stay
 * with the caller — nothing is silently discarded), and every later save()
 * rejects until the operator reloads the receipt and checks its state.
 * Deliberately no in-session auto-resume: without a server protocol there
 * is no safe one. An HTTP error RESPONSE is a known failure (the server
 * spoke) and does NOT halt — retries keep working there.
 */
export const SAVE_HALTED_MESSAGE =
  "Network lost mid-save — this change may or may not have reached the server. " +
  "Reload the receipt to check what was saved; your edits are kept on this form " +
  "but nothing more will be sent until then.";

interface Waiter {
  resolve: (success: SaveSuccess) => void;
  reject: (error: Error) => void;
}

export class SaveQueue {
  private config: SaveQueueConfig;
  private inFlight = false;
  private hasPending = false;
  private pendingMarkReviewed = false;
  private lastFlushFailed = false;
  private haltedForUnknownOutcome = false;
  private waiters: Waiter[] = [];

  constructor(config: SaveQueueConfig) {
    this.config = config;
  }

  /** Replace the closures: the form re-renders with fresh field state, and
   * the queue must build bodies from the LATEST render, never a stale one. */
  rebind(config: SaveQueueConfig): void {
    this.config = config;
  }

  /** True when nothing is in flight and no flush is waiting. */
  get idle(): boolean {
    return !this.inFlight && !this.hasPending;
  }

  /** True when the most recent completed flush FAILED (cleared by the next
   * successful one). The form's unsaved edits can outlive the debounce timer
   * exactly when a save failed — callers use this to keep re-attempting
   * until the edits actually commit. */
  get lastFailed(): boolean {
    return this.lastFlushFailed;
  }

  /** True after an UNKNOWN network outcome (transport loss). While halted
   * nothing drains automatically and save() rejects with SAVE_HALTED_MESSAGE
   * — the operator must reload and check; there is no safe in-session
   * resume without a server protocol. */
  get halted(): boolean {
    return this.haltedForUnknownOutcome;
  }

  /**
   * Request a save. Resolves once a PATCH carrying this request's intent has
   * COMMITTED (possibly coalesced with later requests into one flush — the
   * flush always carries the latest fields, so the intent is satisfied).
   * Rejects with the server/network error if that flush fails.
   */
  save(markReviewed = false): Promise<SaveSuccess> {
    return new Promise<SaveSuccess>((resolve, reject) => {
      // Unknown-outcome halt: refuse rather than enqueue — sending more
      // after an ambiguous request cannot be claimed safely ordered.
      if (this.haltedForUnknownOutcome) {
        reject(new Error(SAVE_HALTED_MESSAGE));
        return;
      }
      this.waiters.push({ resolve, reject });
      this.hasPending = true;
      if (markReviewed) this.pendingMarkReviewed = true;
      this.drain();
    });
  }

  private drain(): void {
    if (this.haltedForUnknownOutcome) return; // no automatic draining (B3)
    if (this.inFlight || !this.hasPending) return;
    if (this.config.deferFire?.()) return; // held; next save() re-attempts
    this.inFlight = true;
    this.hasPending = false;
    const markReviewed = this.pendingMarkReviewed;
    this.pendingMarkReviewed = false;
    const waiters = this.waiters;
    this.waiters = [];
    // Capture the config BEFORE awaiting — rebind must not swap the fetch
    // under an in-flight request.
    const { url, fetchImpl = defaultFetch } = this.config;
    const body = this.config.buildBody(markReviewed);
    void this.fire(url, body, waiters, fetchImpl);
  }

  private async fire(
    url: string,
    body: Record<string, unknown>,
    waiters: Waiter[],
    fetchImpl: SaveFetch,
  ): Promise<void> {
    let result: SaveSuccess | Error;
    let haltError: Error | null = null;
    try {
      const res = await fetchImpl(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        warnings?: string[];
      };
      result = res.ok
        ? { warnings: json.warnings ?? [] }
        : new Error(json.error ?? "Save failed");
    } catch {
      // Transport loss: the request may still have been applied — UNKNOWN
      // outcome, distinct from a confirmed HTTP failure above. Halt.
      haltError = new Error(SAVE_HALTED_MESSAGE);
      result = haltError;
    }
    this.inFlight = false;
    if (haltError) {
      // Halt BEFORE rejecting so even synchronous observers see it.
      this.haltedForUnknownOutcome = true;
      // Work queued behind the ambiguous request cannot be safely ordered:
      // reject (never silently drop) its waiters too. Fields stay with the
      // caller; the guidance message is the honest recovery state.
      const queued = this.waiters;
      this.waiters = [];
      this.hasPending = false;
      this.pendingMarkReviewed = false;
      for (const waiter of queued) waiter.reject(haltError);
    }
    this.lastFlushFailed = result instanceof Error;
    for (const waiter of waiters) {
      if (result instanceof Error) waiter.reject(result);
      else waiter.resolve(result);
    }
    this.drain(); // no-op while halted
  }
}

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}
