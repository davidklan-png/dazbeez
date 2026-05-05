import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveSnippet,
  EXCLUDED_SENDERS,
  ingestReply,
  isExcludedSender,
  type MinimalD1Database,
  type ParsedReply,
} from "@/lib/crm-reply-monitor";

type QueryRecord = { sql: string; args: unknown[] };

interface FakeOpts {
  existingLogs?: Map<string, { status: string }>;
  contactsByEmail?: Map<string, { id: number; name: string | null; company_id: number | null }>;
  nextEventId?: number;
}

function createFakeDb(opts: FakeOpts = {}) {
  const logs = opts.existingLogs ?? new Map<string, { status: string }>();
  const contacts = opts.contactsByEmail ?? new Map();
  let nextEventId = opts.nextEventId ?? 500;
  const queries: QueryRecord[] = [];
  const inserts: QueryRecord[] = [];

  const db: MinimalD1Database = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T = unknown>() {
              queries.push({ sql, args });
              if (/FROM email_reply_ingest_log/i.test(sql)) {
                const key = String(args[0]);
                const hit = logs.get(key);
                return (hit ? { status: hit.status } : null) as T | null;
              }
              if (/FROM contacts/i.test(sql)) {
                const key = String(args[0]);
                const hit = contacts.get(key);
                return (hit ?? null) as T | null;
              }
              return null as T | null;
            },
            async run() {
              inserts.push({ sql, args });
              if (/INSERT INTO contact_events_v2/i.test(sql)) {
                const id = nextEventId++;
                return { meta: { last_row_id: id } };
              }
              if (/INSERT OR IGNORE INTO email_reply_ingest_log/i.test(sql)) {
                const key = String(args[0]);
                if (!logs.has(key)) {
                  logs.set(key, { status: String(args[3]) });
                }
                return { meta: {} };
              }
              if (/INSERT INTO email_reply_ingest_log/i.test(sql)) {
                const key = String(args[0]);
                logs.set(key, { status: "captured" });
                return { meta: {} };
              }
              return { meta: {} };
            },
          };
        },
      };
    },
  };

  return { db, queries, inserts, logs };
}

function baseReply(overrides: Partial<ParsedReply> = {}): ParsedReply {
  return {
    messageIdHeader: "<abc123@mail.example.com>",
    threadId: null,
    subject: "Re: Great meeting you",
    from: "christopher.reed@fortress.com",
    fromName: "Christopher Reed",
    to: ["david@dazbeez.com"],
    cc: [],
    emailTs: "2026-04-23T02:15:00.000Z",
    labels: [],
    bodyPlain: "Thanks David, good to connect. Let's set up a call next week.",
    snippet: "Thanks David, good to connect.",
    displayUrl: null,
    rawSize: 1234,
    ...overrides,
  };
}

test("isExcludedSender: david@dazbeez.com and david.klan@gmail.com are excluded", () => {
  for (const email of EXCLUDED_SENDERS) {
    assert.equal(isExcludedSender(email), true);
    assert.equal(isExcludedSender(email.toUpperCase()), true);
  }
  assert.equal(isExcludedSender("random@example.com"), false);
  assert.equal(isExcludedSender(null), false);
  assert.equal(isExcludedSender(""), false);
});

test("deriveSnippet collapses whitespace and truncates", () => {
  const body = "Line one\n\nLine two   with   spaces\n".repeat(20);
  const snippet = deriveSnippet(body, 50);
  assert.ok(snippet.length <= 50);
  assert.ok(!/\n/.test(snippet));
  assert.ok(snippet.endsWith("\u2026"));
});

test("ingestReply: skips david@dazbeez.com sender without writing event", async () => {
  const { db, inserts } = createFakeDb();
  const outcome = await ingestReply(
    db,
    baseReply({ from: "david@dazbeez.com" }),
  );
  assert.equal(outcome.status, "skipped_self");
  const eventInserts = inserts.filter((q) => /contact_events_v2/i.test(q.sql));
  assert.equal(eventInserts.length, 0);
  const logInserts = inserts.filter((q) => /email_reply_ingest_log/i.test(q.sql));
  assert.equal(logInserts.length, 1);
  assert.match(logInserts[0].sql, /INSERT OR IGNORE/);
});

test("ingestReply: skips david.klan@gmail.com sender", async () => {
  const { db } = createFakeDb();
  const outcome = await ingestReply(
    db,
    baseReply({ from: "david.klan@gmail.com" }),
  );
  assert.equal(outcome.status, "skipped_self");
});

test("ingestReply: no matching contact logs skipped_no_match", async () => {
  const { db, inserts } = createFakeDb();
  const outcome = await ingestReply(db, baseReply());
  assert.equal(outcome.status, "skipped_no_match");
  if (outcome.status === "skipped_no_match") {
    assert.equal(outcome.sender, "christopher.reed@fortress.com");
  }
  const logInserts = inserts.filter((q) => /email_reply_ingest_log/i.test(q.sql));
  assert.equal(logInserts.length, 1);
  const eventInserts = inserts.filter((q) => /contact_events_v2/i.test(q.sql));
  assert.equal(eventInserts.length, 0);
});

test("ingestReply: matched contact writes exactly one event, audit log, and ingest log row", async () => {
  const contactsByEmail = new Map([
    ["christopher.reed@fortress.com", { id: 12, name: "Christopher Reed", company_id: 7 }],
  ]);
  const { db, inserts } = createFakeDb({ contactsByEmail, nextEventId: 999 });
  const outcome = await ingestReply(db, baseReply());

  assert.equal(outcome.status, "captured");
  if (outcome.status === "captured") {
    assert.equal(outcome.contactId, 12);
    assert.equal(outcome.eventId, 999);
  }

  const events = inserts.filter((q) => /INSERT INTO contact_events_v2/i.test(q.sql));
  assert.equal(events.length, 1);
  assert.equal(events[0].args[0], 12); // contact_id
  assert.equal(events[0].args[1], 7); // company_id
  assert.equal(events[0].args[3], "christopher.reed@fortress.com"); // normalized email

  const payloadJson = String(events[0].args[5]);
  const payload = JSON.parse(payloadJson);
  assert.equal(payload.message_id_header, "<abc123@mail.example.com>");
  assert.equal(payload.captured_via, "cloudflare_email_worker");
  assert.equal(payload.from_normalized, "christopher.reed@fortress.com");

  const audits = inserts.filter((q) => /INSERT INTO audit_logs/i.test(q.sql));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].args[0], 999); // entity_id = event id

  const logs = inserts.filter((q) => /INSERT INTO email_reply_ingest_log/i.test(q.sql));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].args[0], "<abc123@mail.example.com>");
  assert.equal(logs[0].args[1], 12);
  assert.equal(logs[0].args[2], 999);
});

test("ingestReply: duplicate Message-ID short-circuits without inserting", async () => {
  const existingLogs = new Map([
    ["<abc123@mail.example.com>", { status: "captured" }],
  ]);
  const contactsByEmail = new Map([
    ["christopher.reed@fortress.com", { id: 12, name: "Christopher Reed", company_id: 7 }],
  ]);
  const { db, inserts } = createFakeDb({ existingLogs, contactsByEmail });
  const outcome = await ingestReply(db, baseReply());

  assert.equal(outcome.status, "skipped_dedupe");
  assert.equal(inserts.length, 0);
});

test("ingestReply: missing Message-ID returns error without writing", async () => {
  const { db, inserts } = createFakeDb();
  const outcome = await ingestReply(db, baseReply({ messageIdHeader: "" }));
  assert.equal(outcome.status, "error");
  assert.equal(inserts.length, 0);
});

test("ingestReply: uppercase sender email is normalized before matching", async () => {
  const contactsByEmail = new Map([
    ["christopher.reed@fortress.com", { id: 12, name: "Christopher Reed", company_id: 7 }],
  ]);
  const { db } = createFakeDb({ contactsByEmail });
  const outcome = await ingestReply(
    db,
    baseReply({ from: "Christopher.Reed@FORTRESS.com" }),
  );
  assert.equal(outcome.status, "captured");
});
