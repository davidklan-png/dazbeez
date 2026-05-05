import PostalMime from "postal-mime";
import {
  deriveSnippet,
  ingestReply,
  type IngestOutcome,
  type ParsedReply,
} from "../../../lib/crm-reply-monitor";

interface Env {
  CRM_DB: D1Database;
  FORWARD_TO: string;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const forwardTo = env.FORWARD_TO;

    let rawBytes: Uint8Array | null = null;
    try {
      rawBytes = await readRaw(message.raw, message.rawSize);
    } catch (err) {
      console.error("[email-reply-capture] failed to read raw message", err);
    }

    if (rawBytes) {
      ctx.waitUntil(captureAndLog(env.CRM_DB, message, rawBytes));
    }

    try {
      await message.forward(forwardTo);
    } catch (err) {
      console.error("[email-reply-capture] forward failed", {
        to: forwardTo,
        from: message.from,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
};

async function captureAndLog(
  db: D1Database,
  message: ForwardableEmailMessage,
  rawBytes: Uint8Array,
): Promise<void> {
  try {
    const parsed = await PostalMime.parse(rawBytes);
    const reply = toParsedReply(parsed, message, rawBytes.byteLength);
    const outcome = await ingestReply(db, reply);
    logOutcome(reply, outcome);
  } catch (err) {
    console.error("[email-reply-capture] ingest failed", {
      from: message.from,
      to: message.to,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function toParsedReply(
  parsed: Awaited<ReturnType<typeof PostalMime.parse>>,
  message: ForwardableEmailMessage,
  rawSize: number,
): ParsedReply {
  const fromAddress = parsed.from?.address ?? message.from ?? "";
  const fromName = parsed.from?.name ?? null;

  const toList = addressesFrom(parsed.to);
  const ccList = addressesFrom(parsed.cc);
  const toFinal = toList.length > 0 ? toList : message.to ? [message.to] : [];

  const bodyPlain = pickPlainBody(parsed);
  const snippet = deriveSnippet(bodyPlain);

  const messageIdHeader =
    parsed.messageId?.trim() ||
    message.headers.get("message-id")?.trim() ||
    "";

  const emailTs = parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString();

  return {
    messageIdHeader,
    threadId: parsed.inReplyTo ?? null,
    subject: parsed.subject ?? message.headers.get("subject") ?? "",
    from: fromAddress,
    fromName,
    to: toFinal,
    cc: ccList,
    emailTs,
    labels: [],
    bodyPlain,
    snippet,
    displayUrl: null,
    rawSize,
  };
}

function addressesFrom(list: unknown): string[] {
  if (!list) return [];
  const items = Array.isArray(list) ? list : [list];
  const addrs: string[] = [];
  for (const entry of items) {
    if (entry && typeof entry === "object" && "address" in entry) {
      const addr = (entry as { address?: unknown }).address;
      if (typeof addr === "string" && addr) addrs.push(addr);
    }
  }
  return addrs;
}

function pickPlainBody(parsed: Awaited<ReturnType<typeof PostalMime.parse>>): string {
  if (parsed.text && parsed.text.trim()) return parsed.text;
  if (parsed.html) return stripHtml(parsed.html);
  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readRaw(stream: ReadableStream<Uint8Array>, expectedSize: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(expectedSize || total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return offset === out.byteLength ? out : out.subarray(0, offset);
}

function logOutcome(reply: ParsedReply, outcome: IngestOutcome): void {
  const base = {
    message_id_header: reply.messageIdHeader,
    from: reply.from,
    subject: reply.subject,
  };
  if (outcome.status === "captured") {
    console.log("[email-reply-capture] captured", { ...base, contact_id: outcome.contactId, event_id: outcome.eventId });
  } else if (outcome.status === "skipped_dedupe") {
    console.log("[email-reply-capture] duplicate", base);
  } else if (outcome.status === "skipped_self") {
    console.log("[email-reply-capture] self-send skipped", base);
  } else if (outcome.status === "skipped_no_match") {
    console.log("[email-reply-capture] no matching contact", { ...base, sender: outcome.sender });
  } else {
    console.error("[email-reply-capture] error", { ...base, error: outcome.error });
  }
}
