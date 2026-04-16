interface FakeContactRow {
  id: number;
  token: string;
  name: string;
  email: string;
  source: string;
  linkedin_url: string | null;
  company: string | null;
  cf_country: string | null;
  cf_city: string | null;
  user_agent: string | null;
  created_at: string;
}

interface FakeTapRow {
  id: number;
  token: string;
  cf_country: string | null;
  cf_city: string | null;
  user_agent: string | null;
}

interface FakeNotificationFailureRow {
  id: number;
  contact_id: number;
  token: string;
  channel: string;
  error_message: string;
  payload_json: string;
}

import { generateKeyPairSync, createSign } from 'node:crypto';

interface FakeContactMethodRow {
  id: number;
  contact_id: number;
  method: 'google' | 'linkedin' | 'manual';
}

interface FakeContactEventRow {
  id: number;
  contact_id: number;
  token: string;
  source: 'google' | 'linkedin' | 'manual';
  name: string;
  email: string;
  created_at: string;
}

interface FakeVCardProfileRow {
  file_name: string;
  family_name: string;
  given_name: string;
  full_name: string;
  organization: string;
  title: string;
  email: string;
  website: string;
  linkedin: string;
}

export interface FakeDbState {
  cards: Map<string, { token: string; label: string }>;
  contacts: FakeContactRow[];
  taps: FakeTapRow[];
  notificationFailures: FakeNotificationFailureRow[];
  contactMethods: FakeContactMethodRow[];
  contactEvents: FakeContactEventRow[];
  vcardProfile: FakeVCardProfileRow;
  failInsertContact: boolean;
}

export function createFakeDbState(
  cards: Array<{ token: string; label: string }> = [],
  options: {
    contacts?: Array<Partial<FakeContactRow> & { token: string; name: string; email: string; source: string }>;
    vcardProfile?: Partial<FakeVCardProfileRow>;
    failInsertContact?: boolean;
  } = {},
): FakeDbState {
  return {
    cards: new Map(cards.map((card) => [card.token, card])),
    contacts: (options.contacts ?? []).map((contact, index) => ({
      id: contact.id ?? index + 1,
      token: contact.token,
      name: contact.name,
      email: contact.email,
      source: contact.source,
      linkedin_url: contact.linkedin_url ?? null,
      company: contact.company ?? null,
      cf_country: contact.cf_country ?? null,
      cf_city: contact.cf_city ?? null,
      user_agent: contact.user_agent ?? null,
      created_at: contact.created_at ?? `2026-04-13 00:00:0${index}`,
    })),
    taps: [],
    notificationFailures: [],
    contactMethods: (options.contacts ?? []).map((contact, index) => ({
      id: index + 1,
      contact_id: contact.id ?? index + 1,
      method: contact.source as 'google' | 'linkedin' | 'manual',
    })),
    contactEvents: (options.contacts ?? []).map((contact, index) => ({
      id: index + 1,
      contact_id: contact.id ?? index + 1,
      token: contact.token,
      source: contact.source as 'google' | 'linkedin' | 'manual',
      name: contact.name,
      email: contact.email.toLowerCase(),
      created_at: contact.created_at ?? `2026-04-13 00:00:0${index}`,
    })),
    vcardProfile: {
      file_name: options.vcardProfile?.file_name ?? 'david-klan.vcf',
      family_name: options.vcardProfile?.family_name ?? 'Klan',
      given_name: options.vcardProfile?.given_name ?? 'David',
      full_name: options.vcardProfile?.full_name ?? 'David Klan',
      organization: options.vcardProfile?.organization ?? 'Dazbeez',
      title: options.vcardProfile?.title ?? 'AI, Automation & Data Consultant',
      email: options.vcardProfile?.email ?? 'david@dazbeez.com',
      website: options.vcardProfile?.website ?? 'https://dazbeez.com',
      linkedin: options.vcardProfile?.linkedin ?? 'https://www.linkedin.com/in/david-klan',
    },
    failInsertContact: options.failInsertContact ?? false,
  };
}

export function createFakeD1Database(state: FakeDbState): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT token, label FROM cards')) {
                const token = params[0] as string;
                return (state.cards.get(token) ?? null) as T;
              }

              if (sql.includes('FROM vcard_profile') && sql.includes('WHERE id = 1')) {
                return state.vcardProfile as T;
              }

              if (sql.includes('SELECT id, linkedin_url, company') && sql.includes('FROM contacts')) {
                const token = params[0] as string;
                const email = params[1] as string;
                return (
                  state.contacts.find((contact) => contact.token === token && contact.email === email) ?? null
                ) as T;
              }

              if (sql.includes('FROM contacts') && sql.includes('WHERE id = ?')) {
                const id = params[0] as number;
                const contact = state.contacts.find((row) => row.id === id) ?? null;
                if (!contact) {
                  return null as T;
                }

                const sources = state.contactMethods
                  .filter((method) => method.contact_id === contact.id)
                  .map((method) => method.method)
                  .join(',');
                return ({
                  ...contact,
                  sources,
                }) as T;
              }

              return null as T;
            },
            async all<T>() {
              if (sql.includes('FROM contacts') && sql.includes('ORDER BY created_at DESC, id DESC')) {
                const token = (params[0] as string | undefined) ?? null;
                const rows = state.contacts
                  .filter((contact) => !token || contact.token === token)
                  .slice()
                  .sort((a, b) => (b.created_at === a.created_at ? b.id - a.id : b.created_at.localeCompare(a.created_at)))
                  .map((contact) => ({
                    ...contact,
                    sources: state.contactMethods
                      .filter((method) => method.contact_id === contact.id)
                      .map((method) => method.method)
                      .join(','),
                  }));
                return { results: rows as T[] };
              }

              if (sql.includes('FROM cards') && sql.includes('tap_count') && sql.includes('contact_count')) {
                const token = (params[0] as string | undefined) ?? null;
                const rows = Array.from(state.cards.values())
                  .filter((card) => !token || card.token === token)
                  .map((card) => ({
                    token: card.token,
                    label: card.label,
                    tap_count: state.taps.filter((tap) => tap.token === card.token).length,
                    contact_count: state.contacts.filter((contact) => contact.token === card.token).length,
                  }));
                return { results: rows as T[] };
              }

              if (sql.includes('FROM contact_events') && sql.includes('ORDER BY created_at DESC, id DESC')) {
                const token = (params[0] as string | undefined) ?? null;
                const rows = state.contactEvents
                  .filter((event) => !token || event.token === token)
                  .slice()
                  .sort((a, b) => (b.created_at === a.created_at ? b.id - a.id : b.created_at.localeCompare(a.created_at)));
                return { results: rows as T[] };
              }

              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO taps')) {
                state.taps.push({
                  id: state.taps.length + 1,
                  token: params[0] as string,
                  cf_country: (params[1] as string | null) ?? null,
                  cf_city: (params[2] as string | null) ?? null,
                  user_agent: (params[3] as string | null) ?? null,
                });

                return { meta: { last_row_id: state.taps.length, changes: 1 } };
              }

              if (sql.includes('INSERT INTO contacts')) {
                if (state.failInsertContact) {
                  throw new Error('Simulated D1 insert failure');
                }

                const contact = {
                  id: state.contacts.length + 1,
                  token: params[0] as string,
                  name: params[1] as string,
                  email: (params[2] as string).toLowerCase(),
                  source: params[3] as string,
                  linkedin_url: (params[4] as string | null) ?? null,
                  company: (params[5] as string | null) ?? null,
                  cf_country: (params[6] as string | null) ?? null,
                  cf_city: (params[7] as string | null) ?? null,
                  user_agent: (params[8] as string | null) ?? null,
                  created_at: `2026-04-13 00:00:${String(state.contacts.length).padStart(2, '0')}`,
                } satisfies FakeContactRow;

                const existing = state.contacts.find(
                  (row) => row.token === contact.token && row.email === contact.email,
                );
                if (existing) {
                  throw new Error('UNIQUE constraint failed: contacts.token, contacts.email');
                }

                state.contacts.push(contact);
                return { meta: { last_row_id: contact.id, changes: 1 } };
              }

              if (sql.includes('UPDATE contacts')) {
                const id = params[6] as number;
                const contact = state.contacts.find((row) => row.id === id);
                if (!contact) {
                  return { meta: { changes: 0 } };
                }

                contact.name = params[0] as string;
                contact.linkedin_url = (params[1] as string | null) ?? contact.linkedin_url;
                contact.company = (params[2] as string | null) ?? contact.company;
                contact.cf_country = (params[3] as string | null) ?? null;
                contact.cf_city = (params[4] as string | null) ?? null;
                contact.user_agent = (params[5] as string | null) ?? null;
                return { meta: { changes: 1 } };
              }

              if (sql.includes('INSERT INTO notification_failures')) {
                state.notificationFailures.push({
                  id: state.notificationFailures.length + 1,
                  contact_id: params[0] as number,
                  token: params[1] as string,
                  channel: params[2] as string,
                  error_message: params[3] as string,
                  payload_json: params[4] as string,
                });
                return { meta: { last_row_id: state.notificationFailures.length, changes: 1 } };
              }

              if (sql.includes('INSERT OR IGNORE INTO contact_methods')) {
                const contactId = params[0] as number;
                const method = params[1] as 'google' | 'linkedin' | 'manual';
                const existing = state.contactMethods.find(
                  (row) => row.contact_id === contactId && row.method === method,
                );
                if (!existing) {
                  state.contactMethods.push({
                    id: state.contactMethods.length + 1,
                    contact_id: contactId,
                    method,
                  });
                }
                return { meta: { changes: existing ? 0 : 1 } };
              }

              if (sql.includes('INSERT INTO contact_events')) {
                const event = {
                  id: state.contactEvents.length + 1,
                  contact_id: params[0] as number,
                  token: params[1] as string,
                  source: params[2] as 'google' | 'linkedin' | 'manual',
                  name: params[3] as string,
                  email: (params[4] as string).toLowerCase(),
                  created_at: `2026-04-13 00:01:${String(state.contactEvents.length).padStart(2, '0')}`,
                } satisfies FakeContactEventRow;
                state.contactEvents.push(event);
                return { meta: { last_row_id: event.id, changes: 1 } };
              }

              if (sql.includes('INSERT INTO vcard_profile')) {
                state.vcardProfile = {
                  file_name: params[1] as string,
                  family_name: params[2] as string,
                  given_name: params[3] as string,
                  full_name: params[4] as string,
                  organization: params[5] as string,
                  title: params[6] as string,
                  email: params[7] as string,
                  website: params[8] as string,
                  linkedin: params[9] as string,
                };
                return { meta: { changes: 1 } };
              }

              if (sql.includes('DELETE FROM contact_events WHERE contact_id = ?')) {
                const id = params[0] as number;
                const before = state.contactEvents.length;
                state.contactEvents = state.contactEvents.filter((event) => event.contact_id !== id);
                return { meta: { changes: before - state.contactEvents.length } };
              }

              if (sql.includes('DELETE FROM contact_methods WHERE contact_id = ?')) {
                const id = params[0] as number;
                const before = state.contactMethods.length;
                state.contactMethods = state.contactMethods.filter((method) => method.contact_id !== id);
                return { meta: { changes: before - state.contactMethods.length } };
              }

              if (sql.includes('DELETE FROM notification_failures WHERE contact_id = ?')) {
                const id = params[0] as number;
                const before = state.notificationFailures.length;
                state.notificationFailures = state.notificationFailures.filter((failure) => failure.contact_id !== id);
                return { meta: { changes: before - state.notificationFailures.length } };
              }

              if (sql.includes('DELETE FROM contacts WHERE id = ?')) {
                const id = params[0] as number;
                const before = state.contacts.length;
                state.contacts = state.contacts.filter((contact) => contact.id !== id);
                return { meta: { changes: before - state.contacts.length } };
              }

              throw new Error(`Unhandled SQL in test fake: ${sql}`);
            },
          };
        },
      };
    },
  } as D1Database;
}

export function createPagesContext({
  url,
  method = 'GET',
  headers,
  body,
  params,
  env,
}: {
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  params?: Record<string, string | string[]>;
  env: Record<string, unknown>;
}) {
  const request = new Request(url, { method, headers, body });
  (request as Request & { cf?: Record<string, string> }).cf = {
    country: 'JP',
    city: 'Tokyo',
  };

  const waitUntilCalls: Promise<unknown>[] = [];

  return {
    context: {
      request,
      params: params ?? {},
      env,
      waitUntil(promise: Promise<unknown>) {
        waitUntilCalls.push(promise);
      },
    } as PagesFunction<unknown> extends (context: infer T) => unknown ? T : never,
    waitUntilCalls,
  };
}

export function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: createFakeD1Database(createFakeDbState()),
    GOOGLE_CLIENT_ID: 'google-client-id',
    LINKEDIN_CLIENT_ID: 'linkedin-client-id',
    LINKEDIN_CLIENT_SECRET: 'linkedin-client-secret',
    RESEND_API_KEY: 'resend-api-key',
    DISCORD_WEBHOOK_URL: 'https://discord.example.test/webhook',
    ADMIN_API_KEY: 'admin-secret',
    ...overrides,
  };
}

const { privateKey: googleTestPrivateKey, publicKey: googleTestPublicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

export function createGoogleJwks() {
  const publicJwk = googleTestPublicKey.export({ format: 'jwk' }) as JsonWebKey;

  return {
    keys: [
      {
        ...publicJwk,
        alg: 'RS256',
        kid: 'test-google-key',
        use: 'sig',
      },
    ],
  };
}

export function createIdToken(payload: Record<string, unknown>) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

  const headerSegment = encode({ alg: 'RS256', kid: 'test-google-key', typ: 'JWT' });
  const payloadSegment = encode(payload);
  const signer = createSign('RSA-SHA256');
  signer.update(`${headerSegment}.${payloadSegment}`);
  signer.end();
  const signatureSegment = signer
    .sign(googleTestPrivateKey)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  return `${headerSegment}.${payloadSegment}.${signatureSegment}`;
}
