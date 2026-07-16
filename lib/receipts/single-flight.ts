// Client-side mobile capture guard. Pure, no React.

/**
 * A one-slot gate used to enforce mobile single-flight: at most one mobile
 * upload runs at a time, so a second capture tap while one is uploading cannot
 * overwrite the active upload's phase.
 *
 * Behavior chosen (mobile re-entry policy): EXPLICIT REJECTION. `start()`
 * returns false when busy; the caller must skip the second invocation rather
 * than queue it. This keeps the normal camera UI (capture -> upload -> re-arm)
 * unchanged while guaranteeing the in-flight phase is never clobbered. Rejection
 * is silent to the camera UI (no error tile) because the steady-state flow never
 * triggers it — it only guards a rapid double-tap during upload.
 */
export class SingleFlight {
  private inFlight = false;

  /** Try to begin a run. Returns true if this call won the start; false if one
   *  is already in flight (caller should reject/skip). */
  start(): boolean {
    if (this.inFlight) return false;
    this.inFlight = true;
    return true;
  }

  /** Mark the current run finished, re-enabling start(). */
  finish(): void {
    this.inFlight = false;
  }

  /** True while a run is in progress. */
  get busy(): boolean {
    return this.inFlight;
  }
}
