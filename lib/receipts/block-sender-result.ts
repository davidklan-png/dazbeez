/**
 * Pure classifier for inbox block-sender rejectIntake failures. Extracted from
 * the route handler so it's unit-testable without HTTP mocking.
 *
 * Returns either a "partial-success" classification (the row was already
 * terminal — block succeeded, rejection was correctly a no-op) or a
 * "genuine-failure" classification (D1 error, audit error, or arbitrary
 * exception — the operator must be told clearly).
 */
export type BlockRejectResult =
  | { kind: "partial-success"; note: string }
  | { kind: "genuine-failure"; message: string };

export function classifyBlockRejectError(error: unknown): BlockRejectResult {
  const msg = error instanceof Error ? error.message : String(error);
  if (/already (promoted|rejected)/i.test(msg)) {
    return {
      kind: "partial-success",
      note: "Sender blocked; row was already terminal and could not be rejected.",
    };
  }
  return {
    kind: "genuine-failure",
    message: `Sender blocked, but row rejection failed: ${msg}`,
  };
}
