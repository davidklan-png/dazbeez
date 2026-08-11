// Pure helpers for the operator-message (【今月のご連絡】) write path, extracted
// so the two latent bugs behind the 2026-06 message-loss incident are unit-
// testable at the DB/route layer without D1/R2 bindings.
//
// The incident itself was client-side (a typed preface never saved; see the
// message_not_reviewed finalize gate for the server-side fix). These helpers
// close the two SERVER-side latent bugs the investigation turned up:
//   (A2-1) a no-op UPDATE returning success (assertExactlyOneRowWritten)
//   (A2-2) a rebuild collapsing "omitted" and "empty string" (resolveOperatorMessageForRebuild)

/**
 * Resolve the operator message for a rebuild from the request body vs the stored
 * draft value, DISTINGUISHING omitted from empty string (A2-2).
 *
 * - bodyValue `undefined` (the field was not sent) → carry `storedValue` forward.
 * - bodyValue a string (present, including `""`) → that value wins, trimmed;
 *   empty/whitespace → `null` (clears the message — a deliberate act).
 *
 * The old `bodyValue ?? storedValue` collapsed these: an empty string (present)
 * is NOT nullish, so `??` let it overwrite the stored value — the same shape as
 * the 2026-06 loss. "Clearing the message must be a deliberate act, never a side
 * effect of a rebuild."
 */
export function resolveOperatorMessageForRebuild(
  bodyValue: string | undefined,
  storedValue: string | null,
): string | null {
  return bodyValue !== undefined
    ? bodyValue.trim() || null
    : (storedValue ?? null);
}

/**
 * Assert that a write affected exactly one row (A2-1). A D1 UPDATE that matches
 * zero rows returns `meta.changes === 0` with no error; before this guard, the
 * caller returned 200 and the UI reported "saved," making a lost write
 * undiagnosable (exactly the 2026-06 signal). Now any departure from exactly one
 * row throws — the write either persisted or the operator sees a 500. `context`
 * names the writer in the message so the audit trail is diagnosis-ready.
 */
export function assertExactlyOneRowWritten(
  rowsWritten: number,
  context: string,
): void {
  if (rowsWritten !== 1) {
    throw new Error(
      `${context}: wrote ${rowsWritten} rows (expected 1). The value was NOT persisted — ` +
        "the target row was sealed, removed, or never existed between the read and the write.",
    );
  }
}
