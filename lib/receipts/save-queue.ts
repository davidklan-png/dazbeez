import { isReceiptRevision, RECEIPT_CONFLICT_MESSAGE } from "./receipt-revision";

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
  initialRevision: number;
  entity?: string;
  onAcknowledged?: (body: Record<string, unknown>, ack: SaveSuccess) => void;
  buildBody: SaveBodyBuilder;
  fetchImpl?: SaveFetch;
  /** Return true to HOLD the pending flush (e.g. IME composition is active —
   * firing would read an uncommitted business-purpose value). The next
   * save() call re-attempts the drain. */
  deferFire?: () => boolean;
}

export interface SaveSuccess {
  warnings: string[];
  revision: number;
  receiptRevisions?: Record<string, number>;
  lineRevisions?: Record<string, number>;
  tripRevisions?: Record<string, number>;
}

/**
 * An UNKNOWN save outcome — the request may have been applied server-side —
 * arises from MORE than a transport loss (response-boundary addendum):
 *   • fetch rejects (connection lost; the request may still land), or
 *   • a 5xx / off-contract status: the route's catch-all 500
 *     (app/api/receipts/[id]/route.ts:387-401) can FOLLOW a committed
 *     UPDATE — updateReceiptRecord writes the row before its audit and
 *     membership steps (lib/receipts/db.ts), so a later crash answers 500
 *     with the write already durable, or
 *   • a 2xx whose body cannot be parsed: not a usable acknowledgement.
 * Once any of those happens the queue HALTS: no further request is sent
 * automatically (a later flush could not be claimed safely ordered if the
 * unknown one still commits), pending waiters are rejected with this
 * guidance (fields stay with the caller — nothing is silently discarded),
 * and every later save() rejects until the operator reloads the receipt
 * and checks its state. Deliberately no in-session auto-resume: without a
 * server protocol there is no safe one.
 */
export const SAVE_HALTED_MESSAGE =
  "This save's outcome is uncertain — it may or may not have reached the server. " +
  "Reload the receipt to check what was saved; your edits are kept on this form " +
  "but nothing more will be sent until then.";

/**
 * Statuses the receipt PATCH route can ONLY emit BEFORE any D1 write, i.e. a
 * response with one of these conclusively proves nothing was applied and the
 * ordinary corrected-input retry may proceed: 400 field validation, 404/409
 * lifecycle guards, 422 sealed-month guard (all route.ts:92-311, ahead of
 * updateReceiptRecord), 401 auth (requireReceiptsActor), 403 edge/middleware
 * auth. Every other status — notably the catch-all 500 — can follow a
 * committed write and is therefore an UNKNOWN outcome (see above).
 */
export function isConclusivePreWriteRefusal(status: number): boolean {
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 409 ||
    status === 422
  );
}

/**
 * Runtime shape check for the success body, derived verbatim from the ONLY
 * success the receipt PATCH route can emit: `{ ok: true, warnings: string[] }`
 * (route.ts:386; warnings built as a string array at :375). A 2xx whose body
 * is anything else — primitive (`true`), array (`[]`), an error envelope
 * (`{error:…}`), or a non-array `warnings` — did not come from a completed
 * save handler and is therefore NOT an acknowledgement: it is an UNKNOWN
 * outcome and halts. No new ack key is invented; `ok: true` is the
 * endpoint's own.
 */
function isUsableSuccessAck(
  parsed: unknown,
): parsed is { ok: true; warnings?: string[] } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const body = parsed as { ok?: unknown; warnings?: unknown; error?: unknown };
  if (body.error !== undefined) return false; // error envelope ≠ success ack
  if (body.ok !== true || !isReceiptRevision((parsed as { revision?: unknown }).revision)) return false; // the endpoint's own acknowledgement
  if (body.warnings !== undefined && !isStringArray(body.warnings)) {
    return false; // wrong warnings type = not the endpoint's body
  }
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((w) => typeof w === "string");
}

/** `error` text from an error envelope, when present and a string. */
function errorTextOf(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const error = (parsed as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
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
  private lastFlushFailed = false;
  private haltedForUnknownOutcome = false;
  private waiters: Waiter[] = [];
  private idleWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  private acknowledgedRevision: number;
  private stoppedMessage: string | null = null;
  private actions: { url: string; method: "POST" | "PATCH" | "DELETE"; buildBody: () => Record<string, unknown>; waiter: Waiter }[] = [];

  constructor(config: SaveQueueConfig) {
    this.config = config;
    this.acknowledgedRevision = config.initialRevision;
  }

  /** Replace the closures: the form re-renders with fresh field state, and
   * the queue must build bodies from the LATEST render, never a stale one. */
  rebind(config: SaveQueueConfig): void {
    this.config = config;
  }

  /** True when nothing is in flight and no flush is waiting. */
  get idle(): boolean {
    return !this.inFlight && !this.hasPending && this.actions.length === 0;
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
        reject(new Error(this.haltMessage));
        return;
      }
      this.waiters.push({ resolve, reject });
      this.hasPending = true;
      if (markReviewed) this.pendingMarkReviewed = true;
      this.drain();
    });
  }

  get revision(): number { return this.acknowledgedRevision; }

  /** Observe a full drain without enqueuing another write. */
  whenIdle(): Promise<void> {
    if (this.halted) return Promise.reject(new Error(this.haltMessage));
    if (this.idle) return this.lastFailed ? Promise.reject(new Error("Save refused — correct the fields or reload to review.")) : Promise.resolve();
    return new Promise((resolve, reject) => this.idleWaiters.push({ resolve, reject }));
  }

  /** Only consume tokens returned by this editor's verified aggregate action. */
  acceptAcknowledgedRevision(revision: number): void {
    if (this.inFlight || !Number.isSafeInteger(revision) || revision < (this.acknowledgedRevision ?? 0)) throw new Error("Invalid aggregate acknowledgement");
    this.acknowledgedRevision = revision;
  }

  stop(message: string): void {
    this.stoppedMessage = message;
    this.haltedForUnknownOutcome = true;
    this.lastFlushFailed = true;
    for (const w of [...this.waiters, ...this.actions.map(a => a.waiter)]) w.reject(new Error(message));
    this.waiters = []; this.actions = []; this.hasPending = false;
    for (const w of this.idleWaiters) w.reject(new Error(message));
    this.idleWaiters = [];
  }

  /** Receipt dedicated actions retain their fixed-URL idle barrier. */
  mutate(method: "PATCH" | "DELETE", body: Record<string, unknown>): Promise<SaveSuccess>;
  mutate(url: string, method: "POST" | "PATCH" | "DELETE", buildBody: () => Record<string, unknown>): Promise<SaveSuccess>;
  mutate(urlOrMethod: string, methodOrBody: "POST" | "PATCH" | "DELETE" | Record<string, unknown>, buildBody?: () => Record<string, unknown>): Promise<SaveSuccess> {
    if (this.halted) return Promise.reject(new Error(this.haltMessage));
    if (!buildBody) {
      if (!this.idle) return Promise.reject(new Error("Wait for pending receipt saves."));
      this.inFlight = true;
      return new Promise((resolve, reject) => {
        void this.fire(this.config.url, methodOrBody as Record<string, unknown>, [{ resolve, reject }], this.config.fetchImpl ?? defaultFetch, urlOrMethod as "PATCH" | "DELETE");
      });
    }
    return new Promise((resolve, reject) => {
      this.actions.push({ url: urlOrMethod, method: methodOrBody as "POST" | "PATCH" | "DELETE", buildBody, waiter: { resolve, reject } });
      this.drain();
    });
  }

  private get haltMessage(): string {
    return this.stoppedMessage ?? (this.config.entity
      ? `This ${this.config.entity} changed or the save outcome is uncertain. Reload to review; your edits are kept here and further writes are stopped.`
      : SAVE_HALTED_MESSAGE);
  }

  private drain(): void {
    if (this.halted || this.inFlight || (!this.hasPending && !this.actions.length)) return;
    if (this.config.deferFire?.()) return;
    this.inFlight = true;
    const { url, fetchImpl = defaultFetch } = this.config;
    let target = url;
    let method: "POST" | "PATCH" | "DELETE" = "PATCH";
    let body: Record<string, unknown>;
    let waiters: Waiter[];
    if (this.hasPending) {
      this.hasPending = false;
      const markReviewed = this.pendingMarkReviewed;
      this.pendingMarkReviewed = false;
      waiters = this.waiters;
      this.waiters = [];
      body = this.config.buildBody(markReviewed);
    } else {
      const action = this.actions.shift()!;
      target = action.url;
      method = action.method;
      body = action.buildBody();
      waiters = [action.waiter];
    }
    if (this.acknowledgedRevision !== undefined) body = { ...body, expectedRevision: this.acknowledgedRevision };
    void this.fire(target, body, waiters, fetchImpl, method);
  }

  private async fire(
    url: string,
    body: Record<string, unknown>,
    waiters: Waiter[],
    fetchImpl: SaveFetch,
    method: "POST" | "PATCH" | "DELETE",
  ): Promise<void> {
    let result: SaveSuccess | Error;
    let haltError: Error | null = null;
    try {
      const res = await fetchImpl(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, expectedRevision: this.acknowledgedRevision }),
      });
      // Ack boundary: a success ack must be a 2xx WITH a parseable body; a
      // conclusive failure must be one of the route's proven PRE-WRITE
      // statuses. Anything else is an UNKNOWN outcome and halts.
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null; // malformed/missing body — not a usable ack
      }
      const ack = parsed as { revision?: unknown; receiptRevisions?: unknown; lineRevisions?: unknown; tripRevisions?: unknown } | null;
      const validToken = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
      const revisioned = true;
      const usableRevision = !revisioned || (validToken(ack?.revision) && (this.config.entity ? ack.revision > this.acknowledgedRevision : ack.revision >= this.acknowledgedRevision));
      const validMap = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(validToken);
      const expectedLines = body.expectedLines as Record<string, number> | undefined;
      const usableLines = (ack?.lineRevisions === undefined ? expectedLines === undefined : validMap(ack.lineRevisions)) &&
        (!expectedLines || Object.entries(expectedLines).every(([id, rev]) => validToken((ack?.lineRevisions as Record<string, unknown> | undefined)?.[id]) && (ack!.lineRevisions as Record<string, number>)[id] >= rev));
      const usableTrips = ack?.tripRevisions === undefined || validMap(ack.tripRevisions);
      if (res.ok && isUsableSuccessAck(parsed) && usableRevision && usableLines && usableTrips) {
        if (revisioned) this.acknowledgedRevision = ack!.revision as number;
        result = { warnings: parsed.warnings ?? [], revision: this.acknowledgedRevision,
          ...(ack?.lineRevisions ? { lineRevisions: ack.lineRevisions as Record<string, number> } : {}),
          ...(ack?.tripRevisions ? { tripRevisions: ack.tripRevisions as Record<string, number> } : {}) };
        this.config.onAcknowledged?.(body, result);
      } else if (!res.ok && isConclusivePreWriteRefusal(res.status)) {
        result = new Error(errorTextOf(parsed) ?? "Save failed");
        if (this.config.entity ? (res.status === 404 || res.status === 409) : (res.status === 404 || (res.status === 409 && (parsed as { code?: string } | null)?.code === "receipt_revision_conflict"))) {
          haltError = new Error(this.config.entity ? this.haltMessage : RECEIPT_CONFLICT_MESSAGE);
          result = haltError;
        }
      } else {
        haltError = new Error(this.haltMessage);
        result = haltError;
      }
    } catch {
      // Transport loss: the request may still have been applied — UNKNOWN
      // outcome. Halt.
      haltError = new Error(this.haltMessage);
      result = haltError;
    }
    this.inFlight = false;
    if (haltError) {
      // Halt BEFORE rejecting so even synchronous observers see it.
      this.haltedForUnknownOutcome = true;
      this.stoppedMessage = haltError.message;
      // Work queued behind the ambiguous request cannot be safely ordered:
      // reject (never silently drop) its waiters too. Fields stay with the
      // caller; the guidance message is the honest recovery state.
      const queued = [...this.waiters, ...this.actions.map(a => a.waiter)];
      this.actions = [];
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
    if (result instanceof Error || this.idle) {
      const idle = this.idleWaiters; this.idleWaiters = [];
      for (const w of idle) { if (result instanceof Error) w.reject(result); else w.resolve(); }
    }
    this.drain(); // no-op while halted
  }
}

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}
