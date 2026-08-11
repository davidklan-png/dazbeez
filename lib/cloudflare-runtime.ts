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

/**
 * Finalize notification email (Resend REST transport). Each returns null when
 * unconfigured so the notify helper can fail gracefully (email failure must
 * never fail finalize): RESEND_API_KEY is the API credential (shared with the
 * contact form); NOTIFY_FROM_ADDRESS must be a sender on the Resend-verified
 * domain; ACCOUNTANT_EMAIL is the fallback recipient when none is set in
 * Settings → Compliance. See docs/month-close-runbook.md §Notification email.
 */
export function getResendApiKeyOrNull(): string | null {
  const env = getCloudflareEnv() as CloudflareEnv & { RESEND_API_KEY?: string };
  return env.RESEND_API_KEY ?? null;
}

export function getAccountantEmail(): string | null {
  const env = getCloudflareEnv() as CloudflareEnv & { ACCOUNTANT_EMAIL?: string };
  return env.ACCOUNTANT_EMAIL ?? null;
}

export function getNotifyFromAddress(): string | null {
  const env = getCloudflareEnv() as CloudflareEnv & { NOTIFY_FROM_ADDRESS?: string };
  return env.NOTIFY_FROM_ADDRESS ?? null;
}

/**
 * Delivery From address — the sender the accountant sees on the monthly pack
 * email. Distinct from {@link getNotifyFromAddress}: NOTIFY_FROM_ADDRESS is the
 * PUBLIC inbound intake address (receipts@dazbeez.com, ADR 0011) which
 * auto-ingests replies as receipt submissions with no operator click. An
 * accountant pressing Reply to a delivery sent From the intake address would
 * have their message parsed as a receipt. The delivery From (target
 * monthlyreport@dazbeez.com) MUST be a different mailbox that is NOT bound to
 * the intake worker (operator action: Cloudflare Email Routing routes it to the
 * operator and it must not be bound to the intake worker).
 *
 * Falls back to NOTIFY_FROM_ADDRESS when unset so the contact form and the
 * channel probe (which use getNotifyFromAddress) are unaffected, and so delivery
 * still works before the operator sets the secret. The operator must verify the
 * sender on the Resend domain BEFORE pointing DELIVERY_FROM_ADDRESS at it
 * (Resend rejects unverified senders). The reply_to (Settings → Compliance)
 * covers well-behaved clients; the Email Routing rule catches replies aimed at
 * the From address directly.
 */
export function getDeliveryFromAddress(): string | null {
  const env = getCloudflareEnv() as CloudflareEnv & {
    DELIVERY_FROM_ADDRESS?: string;
    NOTIFY_FROM_ADDRESS?: string;
  };
  return env.DELIVERY_FROM_ADDRESS ?? env.NOTIFY_FROM_ADDRESS ?? null;
}
