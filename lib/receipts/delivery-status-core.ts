// Shared latest-revision delivery authority; no app runtime or I/O.
import { deriveMonthDeliveryState, deliveryStateToPill, ATTEMPT_STATE,
  type AttemptState, type DeliveryState } from "./delivery-state";

export interface DigestExport {
  id: string; export_month: string; status: string;
  current_delivery_attempt_id?: string | null;
  export_revision?: number | null; created_at: string;
}
export interface DigestDelivery {
  export_id: string; attempt_id: string;
  admission_generation?: number | null;
  state: string | null; created_at: string;
}

export function finalizedMonthsDeliveryState(all: DigestExport[], allDeliveries: DigestDelivery[]) {
  // Latest FINALIZED export id per month — tie-broken identically to
  // getLatestFinalizedExport (revision DESC, then created_at DESC) so this and
  // the send path always agree on which revision is "current".
  const latestFinalizedByMonth = new Map<
    string,
    { id: string; revision: number; createdAt: string; currentAttemptId?: string | null }
  >();
  for (const e of all) {
    if (e.status !== "finalized") continue;
    const revision = e.export_revision ?? 1;
    const createdAt = e.created_at;
    const cur = latestFinalizedByMonth.get(e.export_month);
    if (
      !cur ||
      revision > cur.revision ||
      (revision === cur.revision && createdAt > cur.createdAt)
    ) {
      latestFinalizedByMonth.set(e.export_month, { id: e.id, revision, createdAt, currentAttemptId: e.current_delivery_attempt_id });
    }
  }
  const result = new Map<string, DeliveryState | null>();
  for (const [month, latest] of latestFinalizedByMonth) {
    const attempts = allDeliveries
      .filter((d) => d.export_id === latest.id)
      .map((d) => ({
        attemptId: d.attempt_id,
        // The DB column allows 'ambiguous' at runtime (markDeliveryAmbiguous);
        // the static type narrows to three values, so cast through the authority.
        state: (d.state as AttemptState) ?? ATTEMPT_STATE.PENDING,
        createdAt: d.created_at,
        admissionGeneration: d.admission_generation,
      }));
    result.set(month, deriveMonthDeliveryState(attempts, latest.currentAttemptId));
  }
  return result;
}

export function needsDeliveryAction(state: DeliveryState | null | undefined): boolean {
  return deliveryStateToPill(state) !== "delivered";
}
