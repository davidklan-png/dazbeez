import { getCloudflareContext } from "@opennextjs/cloudflare";

export function getCloudflareEnv(): CloudflareEnv {
  const { env } = getCloudflareContext();
  return env as CloudflareEnv;
}

export function getSubmissionDb(): D1Database {
  return getCloudflareEnv().DB;
}

export function getCrmDb(): D1Database {
  return getCloudflareEnv().CRM_DB;
}

export function getResendApiKey(): string {
  const apiKey = getCloudflareEnv().RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("Resend API key binding is not configured.");
  }

  return apiKey;
}

export function getAiBinding(): Ai | null {
  const env = getCloudflareEnv();
  return env.AI ?? null;
}

export function getGoogleCloudVisionApiKey(): string {
  const env = getCloudflareEnv() as CloudflareEnv & {
    GOOGLE_CLOUD_VISION_API_KEY?: string;
  };
  const apiKey =
    env.GOOGLE_CLOUD_VISION_API_KEY ?? process.env.GOOGLE_CLOUD_VISION_API_KEY;

  if (!apiKey) {
    throw new Error("GOOGLE_CLOUD_VISION_API_KEY is not configured.");
  }

  return apiKey;
}

export function getCrmImagesBucket(): R2Bucket | null {
  const env = getCloudflareEnv();
  return env.CRM_IMAGES ?? null;
}

export function getReceiptsDb(): D1Database {
  return getCloudflareEnv().RECEIPTS_DB;
}

export function getReceiptsBucket(): R2Bucket {
  return getCloudflareEnv().RECEIPTS_BUCKET;
}

export function getReceiptsArchiveBucket(): R2Bucket {
  return getCloudflareEnv().RECEIPTS_ARCHIVE_BUCKET;
}

/**
 * Extraction queue producer (ADR 0001). Returns null when the binding is not
 * configured (e.g. before the queue is created on the Mac) so capture can
 * degrade gracefully — the receipt still lands in D1 as `captured` and a
 * backfill can enqueue it later.
 */
export function getReceiptsQueue(): Queue<unknown> | null {
  const env = getCloudflareEnv() as CloudflareEnv & {
    RECEIPTS_QUEUE?: Queue<unknown>;
  };
  return env.RECEIPTS_QUEUE ?? null;
}

/**
 * Shared secret for the Mac MLX consumer to authenticate to the extract
 * endpoint as a machine actor. Set via `wrangler secret put RECEIPTS_PROCESSOR_KEY`.
 */
export function getReceiptsProcessorKey(): string | null {
  const env = getCloudflareEnv() as CloudflareEnv & {
    RECEIPTS_PROCESSOR_KEY?: string;
  };
  return env.RECEIPTS_PROCESSOR_KEY ?? process.env.RECEIPTS_PROCESSOR_KEY ?? null;
}
