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

export function getAiBinding(): Ai | null {
  const env = getCloudflareEnv();
  return env.AI ?? null;
}
