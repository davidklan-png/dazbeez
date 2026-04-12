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

export async function insertContact(
  db: D1Database,
  data: ContactInput,
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO contacts (token, name, email, source, linkedin_url, company, cf_country, cf_city, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      data.token,
      data.name,
      data.email,
      data.source,
      data.linkedin_url ?? null,
      data.company ?? null,
      data.cf_country ?? null,
      data.cf_city ?? null,
      data.user_agent ?? null,
    )
    .run();

  // D1 returns last_row_id for AUTOINCREMENT tables
  return (result.meta.last_row_id as number) ?? 0;
}
