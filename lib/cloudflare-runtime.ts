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
