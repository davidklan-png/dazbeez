import { getCloudflareContext } from "@opennextjs/cloudflare";

export type ContactSubmission = {
  firstName: string;
  lastName: string;
  email: string;
  company?: string;
  phoneNumber?: string;
  service?: string;
  message: string;
  submittedAt: string;
  source?: string;
};

export async function appendSubmission(entry: ContactSubmission): Promise<void> {
  const { env } = getCloudflareContext();

  await env.DB.prepare(
    `INSERT INTO contact_submissions
      (first_name, last_name, email, company, phone_number, service, message, source, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      entry.firstName,
      entry.lastName,
      entry.email,
      entry.company ?? null,
      entry.phoneNumber ?? null,
      entry.service ?? null,
      entry.message,
      entry.source ?? null,
      entry.submittedAt,
    )
    .run();
}
