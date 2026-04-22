import {
  DEFAULT_CONTACT_CARD,
  normalizeContactCardProfile,
  type ContactCardProfile,
} from './vcard';
import {
  normalizeEmail,
  normalizeLinkedinUrl,
  type KnownAttendee,
} from './personalization';

export async function logTap(
  db: D1Database,
  token: string,
  country: string | null,
  city: string | null,
  userAgent: string | null,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO taps (token, cf_country, cf_city, user_agent) VALUES (?, ?, ?, ?)',
    )
    .bind(token, country, city, userAgent)
    .run();
}

export async function getCard(
  db: D1Database,
  token: string,
): Promise<{ token: string; label: string } | null> {
  return db
    .prepare('SELECT token, label FROM cards WHERE token = ?')
    .bind(token)
    .first<{ token: string; label: string }>();
}

export async function getContactById(
  db: D1Database,
  id: number,
): Promise<{
  id: number;
  token: string;
  name: string;
  email: string;
  source: string;
  sources: string[];
  linkedin_url: string | null;
  company: string | null;
  cf_country: string | null;
  cf_city: string | null;
  created_at: string;
} | null> {
  const result = await db
    .prepare(
      `SELECT id,
              token,
              name,
              email,
              source,
              COALESCE(
                (SELECT GROUP_CONCAT(method, ',') FROM contact_methods WHERE contact_id = contacts.id),
                source
              ) AS sources,
              linkedin_url,
              company,
              cf_country,
              cf_city,
              created_at
       FROM contacts
       WHERE id = ?`,
    )
    .bind(id)
    .first<{
      id: number;
      token: string;
      name: string;
      email: string;
      source: string;
      sources: string;
      linkedin_url: string | null;
      company: string | null;
      cf_country: string | null;
      cf_city: string | null;
      created_at: string;
    }>();

  return result
    ? {
        ...result,
        sources: result.sources.split(',').filter(Boolean),
      }
    : null;
}

export interface ContactInput {
  token: string;
  name: string;
  email: string;
  source: 'google' | 'linkedin' | 'manual';
  linkedin_url?: string;
  company?: string;
  cf_country?: string | null;
  cf_city?: string | null;
  user_agent?: string | null;
}

export interface ContactSaveResult {
  id: number;
  isNew: boolean;
}

export interface ContactEventRow {
  id: number;
  contact_id: number;
  token: string;
  source: 'google' | 'linkedin' | 'manual';
  name: string;
  email: string;
  created_at: string;
}

export async function getVCardProfile(
  db: D1Database,
): Promise<ContactCardProfile> {
  const row = await db
    .prepare(
      `SELECT file_name,
              family_name,
              given_name,
              full_name,
              organization,
              title,
              email,
              website,
              linkedin
       FROM vcard_profile
       WHERE id = 1`,
    )
    .bind()
    .first<{
      file_name: string;
      family_name: string;
      given_name: string;
      full_name: string;
      organization: string;
      title: string;
      email: string;
      website: string;
      linkedin: string;
    }>();

  if (!row) {
    return DEFAULT_CONTACT_CARD;
  }

  return normalizeContactCardProfile({
    fileName: row.file_name,
    familyName: row.family_name,
    givenName: row.given_name,
    fullName: row.full_name,
    organization: row.organization,
    title: row.title,
    email: row.email,
    website: row.website,
    linkedin: row.linkedin,
  });
}

export async function upsertVCardProfile(
  db: D1Database,
  profile: Partial<ContactCardProfile>,
): Promise<ContactCardProfile> {
  const normalized = normalizeContactCardProfile(profile);

  await db
    .prepare(
      `INSERT INTO vcard_profile (
         id,
         file_name,
         family_name,
         given_name,
         full_name,
         organization,
         title,
         email,
         website,
         linkedin
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         file_name = excluded.file_name,
         family_name = excluded.family_name,
         given_name = excluded.given_name,
         full_name = excluded.full_name,
         organization = excluded.organization,
         title = excluded.title,
         email = excluded.email,
         website = excluded.website,
         linkedin = excluded.linkedin`,
    )
    .bind(
      1,
      normalized.fileName,
      normalized.familyName,
      normalized.givenName,
      normalized.fullName,
      normalized.organization,
      normalized.title,
      normalized.email,
      normalized.website,
      normalized.linkedin,
    )
    .run();

  return normalized;
}

async function findContactByIdentity(
  db: D1Database,
  email: string,
  linkedinUrl?: string | null,
): Promise<{
  id: number;
  linkedin_url: string | null;
  company: string | null;
} | null> {
  const byEmail = await db
    .prepare(
      `SELECT id, linkedin_url, company
       FROM contacts
       WHERE email_lower = ? OR email = ?
       LIMIT 1`,
    )
    .bind(email, email)
    .first<{
      id: number;
      linkedin_url: string | null;
      company: string | null;
    }>();

  if (byEmail) {
    return byEmail;
  }

  const normalizedLinkedin = normalizeLinkedinUrl(linkedinUrl);
  if (!normalizedLinkedin) {
    return null;
  }

  return db
    .prepare(
      `SELECT id, linkedin_url, company
       FROM contacts
       WHERE linkedin_url = ?
       LIMIT 1`,
    )
    .bind(normalizedLinkedin)
    .first<{
      id: number;
      linkedin_url: string | null;
      company: string | null;
    }>();
}

async function recordContactEvent(
  db: D1Database,
  data: {
    contactId: number;
    token: string;
    source: ContactInput['source'];
    name: string;
    email: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO contact_events (contact_id, token, source, name, email)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      data.contactId,
      data.token,
      data.source,
      data.name,
      data.email,
    )
    .run();
}

async function updateContact(
  db: D1Database,
  id: number,
  data: ContactInput,
): Promise<void> {
  await db
    .prepare(
      `UPDATE contacts
       SET name = ?,
           token = COALESCE(token, ?),
           email = COALESCE(email, ?),
           email_lower = COALESCE(email_lower, ?),
           linkedin_url = COALESCE(?, linkedin_url),
           company = COALESCE(?, company),
           cf_country = ?,
           cf_city = ?,
           user_agent = ?,
           source = COALESCE(source, ?),
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(
      data.name,
      data.token,
      data.email,
      data.email,
      data.linkedin_url ?? null,
      data.company ?? null,
      data.cf_country ?? null,
      data.cf_city ?? null,
      data.user_agent ?? null,
      data.source,
      id,
    )
    .run();
}

async function recordContactMethod(
  db: D1Database,
  contactId: number,
  method: ContactInput['source'],
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO contact_methods (contact_id, method)
       VALUES (?, ?)`,
    )
    .bind(contactId, method)
    .run();
}

export async function saveContact(
  db: D1Database,
  data: ContactInput,
): Promise<ContactSaveResult> {
  const normalizedEmail = data.email.trim().toLowerCase();
  const normalizedData: ContactInput = {
    ...data,
    email: normalizedEmail,
  };
  const existing = await findContactByIdentity(db, normalizedData.email, normalizedData.linkedin_url);
  if (existing) {
    await updateContact(db, existing.id, normalizedData);
    await recordContactMethod(db, existing.id, normalizedData.source);
    await recordContactEvent(db, {
      contactId: existing.id,
      token: normalizedData.token,
      source: normalizedData.source,
      name: normalizedData.name,
      email: normalizedData.email,
    });
    return { id: existing.id, isNew: false };
  }

  try {
    const result = await db
      .prepare(
        `INSERT INTO contacts (token, name, email, email_lower, source, linkedin_url, company, cf_country, cf_city, user_agent, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', datetime('now'))`,
      )
      .bind(
        normalizedData.token,
        normalizedData.name,
        normalizedData.email,
        normalizedData.email,
        normalizedData.source,
        normalizedData.linkedin_url ?? null,
        normalizedData.company ?? null,
        normalizedData.cf_country ?? null,
        normalizedData.cf_city ?? null,
        normalizedData.user_agent ?? null,
      )
      .run();

    const id = (result.meta.last_row_id as number) ?? 0;
    await recordContactMethod(db, id, normalizedData.source);
    await recordContactEvent(db, {
      contactId: id,
      token: normalizedData.token,
      source: normalizedData.source,
      name: normalizedData.name,
      email: normalizedData.email,
    });

    return {
      id,
      isNew: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes('unique')) {
      throw error;
    }

    const duplicate = await findContactByIdentity(db, normalizedData.email, normalizedData.linkedin_url);
    if (!duplicate) {
      throw error;
    }

    await updateContact(db, duplicate.id, normalizedData);
    await recordContactMethod(db, duplicate.id, normalizedData.source);
    await recordContactEvent(db, {
      contactId: duplicate.id,
      token: normalizedData.token,
      source: normalizedData.source,
      name: normalizedData.name,
      email: normalizedData.email,
    });
    return { id: duplicate.id, isNew: false };
  }
}

/**
 * Look up an event attendee by (email, linkedin_url). Email wins; LinkedIn
 * URL is a fallback for OAuth taps where we have a LinkedIn URL but no
 * pre-seeded email. Returns null when no match (the generic flow).
 */
export async function getKnownAttendee(
  db: D1Database,
  email: string | null | undefined,
  linkedinUrl: string | null | undefined,
): Promise<KnownAttendee | null> {
  const emailLower = normalizeEmail(email);
  if (emailLower) {
    const byEmail = await db
      .prepare(
        `SELECT id, email_lower, linkedin_url, display_name, event_slug,
                tier, role_company, opener, david_notes, cta_type, topic_hint
         FROM known_attendees
         WHERE email_lower = ?`,
      )
      .bind(emailLower)
      .first<KnownAttendee>();
    if (byEmail) return byEmail;
  }

  const linkedinNormalized = normalizeLinkedinUrl(linkedinUrl);
  if (linkedinNormalized) {
    const byLinkedin = await db
      .prepare(
        `SELECT id, email_lower, linkedin_url, display_name, event_slug,
                tier, role_company, opener, david_notes, cta_type, topic_hint
         FROM known_attendees
         WHERE linkedin_url = ?`,
      )
      .bind(linkedinNormalized)
      .first<KnownAttendee>();
    if (byLinkedin) return byLinkedin;
  }

  return null;
}

export async function logNotificationFailure(
  db: D1Database,
  data: {
    contactId: number;
    token: string;
    channel: 'discord' | 'email';
    errorMessage: string;
    payloadJson: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notification_failures (contact_id, token, channel, error_message, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      data.contactId,
      data.token,
      data.channel,
      data.errorMessage,
      data.payloadJson,
    )
    .run();
}

export async function listContacts(
  db: D1Database,
  token?: string | null,
): Promise<
  Array<{
    id: number;
    token: string;
    name: string;
    email: string;
    source: string;
    sources: string[];
    company: string | null;
    linkedin_url: string | null;
    cf_country: string | null;
    cf_city: string | null;
    created_at: string;
  }>
> {
  const statement = token
    ? db.prepare(
        `SELECT id,
                token,
                name,
                email,
                source,
                COALESCE(
                  (SELECT GROUP_CONCAT(method, ',') FROM contact_methods WHERE contact_id = contacts.id),
                  source
                ) AS sources,
                company,
                linkedin_url,
                cf_country,
                cf_city,
                created_at
         FROM contacts
         WHERE token = ?
            OR EXISTS (
              SELECT 1
              FROM contact_events
              WHERE contact_events.contact_id = contacts.id
                AND contact_events.token = ?
            )
         ORDER BY created_at DESC, id DESC`,
      ).bind(token, token)
    : db.prepare(
        `SELECT id,
                token,
                name,
                email,
                source,
                COALESCE(
                  (SELECT GROUP_CONCAT(method, ',') FROM contact_methods WHERE contact_id = contacts.id),
                  source
                ) AS sources,
                company,
                linkedin_url,
                cf_country,
                cf_city,
                created_at
         FROM contacts
         ORDER BY created_at DESC, id DESC`,
      );

  const result = await statement.all<{
    id: number;
    token: string;
    name: string;
    email: string;
    source: string;
    sources: string;
    company: string | null;
    linkedin_url: string | null;
    cf_country: string | null;
    cf_city: string | null;
    created_at: string;
  }>();

  return (result.results ?? []).map((row) => ({
    ...row,
    sources: row.sources.split(',').filter(Boolean),
  }));
}

export async function listCardMetrics(
  db: D1Database,
  token?: string | null,
): Promise<
  Array<{
    token: string;
    label: string;
    tap_count: number;
    contact_count: number;
  }>
> {
  const statement = token
    ? db.prepare(
        `SELECT cards.token,
                cards.label,
                (SELECT COUNT(*) FROM taps WHERE taps.token = cards.token) AS tap_count,
                (
                  SELECT COUNT(DISTINCT contact_events.contact_id)
                  FROM contact_events
                  WHERE contact_events.token = cards.token
                ) AS contact_count
         FROM cards
         WHERE cards.token = ?
         ORDER BY cards.created_at DESC`,
      ).bind(token)
    : db.prepare(
        `SELECT cards.token,
                cards.label,
                (SELECT COUNT(*) FROM taps WHERE taps.token = cards.token) AS tap_count,
                (
                  SELECT COUNT(DISTINCT contact_events.contact_id)
                  FROM contact_events
                  WHERE contact_events.token = cards.token
                ) AS contact_count
         FROM cards
         ORDER BY cards.created_at DESC`,
      );

  const result = await statement.all<{
    token: string;
    label: string;
    tap_count: number;
    contact_count: number;
  }>();

  return result.results ?? [];
}

export async function listContactEvents(
  db: D1Database,
  token?: string | null,
): Promise<ContactEventRow[]> {
  const statement = token
    ? db.prepare(
        `SELECT id,
                contact_id,
                token,
                source,
                name,
                email,
                created_at
         FROM contact_events
         WHERE token = ?
         ORDER BY created_at DESC, id DESC`,
      ).bind(token)
    : db.prepare(
        `SELECT id,
                contact_id,
                token,
                source,
                name,
                email,
                created_at
         FROM contact_events
         ORDER BY created_at DESC, id DESC`,
      );

  const result = await statement.all<ContactEventRow>();
  return result.results ?? [];
}

export async function deleteContactById(
  db: D1Database,
  id: number,
): Promise<boolean> {
  await db
    .prepare('DELETE FROM contact_events WHERE contact_id = ?')
    .bind(id)
    .run();
  await db
    .prepare('DELETE FROM contact_methods WHERE contact_id = ?')
    .bind(id)
    .run();
  await db
    .prepare('DELETE FROM notification_failures WHERE contact_id = ?')
    .bind(id)
    .run();
  const result = await db
    .prepare('DELETE FROM contacts WHERE id = ?')
    .bind(id)
    .run();

  return Number(result.meta.changes ?? 0) > 0;
}
