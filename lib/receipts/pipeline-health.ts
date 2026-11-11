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
