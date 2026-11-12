// App binding defaults; the shared core also runs in the standalone intake worker.
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import {
  getPipelineHealth as getHealth,
  listPipelineAttentionReceipts as listAttention,
  type PipelineDetailKind,
} from "./pipeline-health-core";
export * from "./pipeline-health-core";

export function getPipelineHealth(db: D1Database = getReceiptsDb(), now = Date.now()) {
  return getHealth(db, now);
}

export function listPipelineAttentionReceipts(
  kind: PipelineDetailKind, db: D1Database = getReceiptsDb(), now = Date.now(),
) {
  return listAttention(kind, db, now);
}

// ─── Health-row action failure classification (review R4 + round-2) ────────────

/** Why a health-row action endpoint failed. Pure — the component maps the
 *  HTTP status to one of these before rendering, so the classification is
 *  unit-testable without a DOM. */
export type ActionFailureKind = "refused" | "removed" | "auth" | "unconfirmed";

/**
 * Classify a health-row action failure (Enqueue / Retry render):
 *   409 → refused      (the endpoint's own validated message is shown; the
 *                       action is prohibited in the current state — disabled
 *                       until the page is refreshed)
 *   404 → removed      (the receipt no longer exists — stale dashboard row)
 *   401/403 → auth     (session lost — sign in again)
 *   anything else, incl. 5xx → unconfirmed: the POST's outcome is UNKNOWN.
 *     A mutating POST that answers 5xx — or whose response is lost — may
 *     have committed before the failure, so the safe next step is to reload
 *     and check the current state, never an immediate repeat.
 * Network-level failures (fetch rejected, no status) are classified by the
 * caller as `unconfirmed` — no status exists to classify.
 */
export function classifyActionFailure(status: number): ActionFailureKind {
  if (status === 409) return "refused";
  if (status === 404) return "removed";
  if (status === 401 || status === 403) return "auth";
  return "unconfirmed";
}

/**
 * The operator-facing note per failure kind. Fixed strings only — arbitrary
 * 5xx bodies are NOT echoed (the enqueue endpoint may surface internal
 * error text); the 409 refusal is rendered separately with the endpoint's
 * own validated message. Exported so tests assert the exact notes.
 */
export const HEALTH_ACTION_FAILURE_NOTE: Record<ActionFailureKind, string> = {
  refused: "", // rendered separately with the endpoint message
  removed: "receipt no longer exists — reload the page",
  auth: "session expired — sign in again",
  unconfirmed:
    "outcome unconfirmed — reload the page and check this receipt's current state before trying again",
};

/**
 * True when the action button must be DISABLED after this failure kind.
 * Every failure kind disables: a refused action cannot succeed in this
 * state, a removed/unauthenticated click cannot work, and an UNCONFIRMED
 * outcome must not be retried before the operator checks current state (a
 * repeat may double-apply or hit a just-succeeded refusal). `null` (no
 * failure yet) stays enabled.
 */
export function isActionDisabledByFailure(kind: ActionFailureKind | null): boolean {
  return kind !== null;
}
