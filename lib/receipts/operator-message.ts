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
 * Resolve the operator message from the request body vs the stored draft value,
 * DISTINGUISHING omitted from an explicit decision (A2-2 / Codex P1 on #169).
 *
 * - bodyValue `undefined` (the field was not sent) → carry `storedValue` forward
 *   (a rebuild that omits the field keeps the stored message).
 * - bodyValue `null` → explicit "no message this month" → `null`.
 * - bodyValue a string (present, including `""`) → that value wins, trimmed;
 *   empty/whitespace → `null` (clears the message — a deliberate act).
 *
 * The old `bodyValue ?? storedValue` collapsed these: an empty string (present)
 * is NOT nullish, so `??` let it overwrite the stored value — the same shape as
 * the 2026-06 loss. "Clearing the message must be a deliberate act, never a side
 * effect of a rebuild." The one-shot finalize path uses omitted (`undefined`) as
 * "no decision supplied" → the route blocks, rather than silently bypassing the
 * message_not_reviewed gate.
 */
export function resolveOperatorMessageForRebuild(
  bodyValue: string | null | undefined,
  storedValue: string | null,
): string | null {
  if (bodyValue === undefined) return storedValue ?? null;
  if (bodyValue === null) return null;
  return bodyValue.trim() || null;
}

/**
 * The one-shot finalize decision from the request body (Codex P1 on #169). The
 * caller must state it explicitly so the path cannot bypass message_not_reviewed:
 * - `operatorMessage: "<text>"` → preface text.
 * - `operatorMessage: null` or `""` → explicit "no message this month."
 * - omitted (`undefined`) → NO decision → `{ ok: false }` and the route blocks
 *   with a message naming the field, rather than silently finalizing with an
 *   empty 【今月のご連絡】.
 *
 * Chosen over a separate `messageDecision: "none"` flag: it reuses the existing
 * `operatorMessage` field and the field-PRESENCE doctrine (omitted ≠ present)
 * already used by the rebuild path, so one field means one thing across both
 * routes. Nothing calls this path today (no UI, no tests, no scripts — only docs
 * describe it), so the contract change has zero caller breakage.
 */
export function oneShotFinalizeDecision(
  operatorMessage: string | null | undefined,
):
  | { ok: true; operatorMessage: string | null }
  | { ok: false; reason: "no-decision" } {
  if (operatorMessage === undefined) {
    return { ok: false, reason: "no-decision" };
  }
  return { ok: true, operatorMessage: resolveOperatorMessageForRebuild(operatorMessage, null) };
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
