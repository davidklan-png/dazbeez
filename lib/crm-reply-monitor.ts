import { normalizeEmail } from "./crm-normalization";
import { stringifyJson } from "./crm-json";

export const EXCLUDED_SENDERS: ReadonlySet<string> = new Set([
  "david@dazbeez.com",
  "david.klan@gmail.com",
]);

export interface ParsedReply {
  messageIdHeader: string;
  threadId?: string | null;
  subject: string;
  from: string;
  fromName?: string | null;
  to: string[];
  cc: string[];
  emailTs: string;
  labels?: string[];
  bodyPlain: string;
  snippet: string;
  displayUrl?: string | null;
  rawSize?: number | null;
}

export type IngestOutcome =
  | { status: "captured"; contactId: number; eventId: number }
  | { status: "skipped_self"; sender: string }
  | { status: "skipped_no_match"; sender: string }
  | { status: "skipped_dedupe"; messageIdHeader: string }
  | { status: "error"; error: string };

export interface MinimalD1Database {
  prepare: (query: string) => {
    bind: (...values: unknown[]) => {
      first: <T = unknown>() => Promise<T | null>;
      run: () => Promise<{ meta?: { last_row_id?: number | bigint } }>;
    };
  };
}

export function isExcludedSender(email: string | null | undefined): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return EXCLUDED_SENDERS.has(normalized);
}

export function deriveSnippet(bodyPlain: string, maxChars = 280): string {
  const collapsed = bodyPlain.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return collapsed.slice(0, maxChars - 1) + "\u2026";
}

export async function ingestReply(
  db: MinimalD1Database,
  reply: ParsedReply,
): Promise<IngestOutcome> {
  if (!reply.messageIdHeader) {
    return { status: "error", error: "missing Message-ID header" };
  }

  const sender = normalizeEmail(reply.from);
  if (!sender) {
    await recordSkipLog(db, {
      messageIdHeader: reply.messageIdHeader,
      subject: reply.subject,
      status: "error",
      sender: null,
      errorMessage: "invalid sender address",
    });
    return { status: "error", error: "invalid sender address" };
  }

  if (EXCLUDED_SENDERS.has(sender)) {
    await recordSkipLog(db, {
      messageIdHeader: reply.messageIdHeader,
      subject: reply.subject,
      status: "skipped_self",
      sender,
    });
    return { status: "skipped_self", sender };
  }

  const existing = await db
    .prepare("SELECT status FROM email_reply_ingest_log WHERE message_id_header = ? LIMIT 1")
    .bind(reply.messageIdHeader)
    .first<{ status: string }>();
  if (existing) {
    return { status: "skipped_dedupe", messageIdHeader: reply.messageIdHeader };
  }

  const contact = await db
    .prepare(
      `SELECT c.id, c.name, c.company_id
       FROM contacts c
       WHERE c.email_lower = ?
       LIMIT 1`,
    )
    .bind(sender)
    .first<{ id: number; name: string | null; company_id: number | null }>();

  if (!contact) {
    await recordSkipLog(db, {
      messageIdHeader: reply.messageIdHeader,
      subject: reply.subject,
      status: "skipped_no_match",
      sender,
    });
    return { status: "skipped_no_match", sender };
  }

  const payload = {
    message_id_header: reply.messageIdHeader,
    thread_id: reply.threadId ?? null,
    subject: reply.subject,
    from: reply.from,
    from_normalized: sender,
    to: reply.to,
    cc: reply.cc,
    email_ts: reply.emailTs,
    labels: reply.labels ?? [],
    display_url: reply.displayUrl ?? null,
    snippet: reply.snippet,
    body: reply.bodyPlain,
    raw_size: reply.rawSize ?? null,
    captured_via: "cloudflare_email_worker",
  };

  const displayName = contact.name ?? reply.fromName ?? reply.from;
  const summary = reply.subject ? reply.subject.slice(0, 500) : reply.snippet.slice(0, 500);

  const eventInsert = await db
    .prepare(
      `INSERT INTO contact_events_v2
        (contact_id, company_id, source, event_type, name, email, summary, payload_json)
       VALUES (?, ?, 'admin_manual_entry', 'email_reply_received', ?, ?, ?, ?)`,
    )
    .bind(
      contact.id,
      contact.company_id,
      displayName,
      sender,
      summary,
      stringifyJson(payload),
    )
    .run();

  const rawId = eventInsert.meta?.last_row_id;
  const eventId = typeof rawId === "bigint" ? Number(rawId) : Number(rawId ?? 0);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    return { status: "error", error: "contact_events_v2 insert returned no id" };
  }

  await db
    .prepare(
      `INSERT INTO audit_logs
        (actor, action, entity_type, entity_id, after_json)
       VALUES ('automation:crm-reply-monitor', 'email_reply.captured', 'contact_event', ?, ?)`,
    )
    .bind(
      eventId,
      stringifyJson({
        message_id_header: reply.messageIdHeader,
        contact_id: contact.id,
        sender,
        subject: reply.subject,
        email_ts: reply.emailTs,
      }),
    )
    .run();

  await db
    .prepare(
      `INSERT INTO email_reply_ingest_log
        (message_id_header, contact_id, event_id, sender_email, subject, status)
       VALUES (?, ?, ?, ?, ?, 'captured')`,
    )
    .bind(
      reply.messageIdHeader,
      contact.id,
      eventId,
      sender,
      reply.subject ?? null,
    )
    .run();

  return { status: "captured", contactId: contact.id, eventId };
}

async function recordSkipLog(
  db: MinimalD1Database,
  args: {
    messageIdHeader: string;
    subject?: string | null;
    status: "skipped_no_match" | "skipped_self" | "error";
    sender: string | null;
    errorMessage?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO email_reply_ingest_log
        (message_id_header, sender_email, subject, status, error_message)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      args.messageIdHeader,
      args.sender,
      args.subject ?? null,
      args.status,
      args.errorMessage ?? null,
    )
    .run();
}
