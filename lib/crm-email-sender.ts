import { getCrmDb, getResendApiKey } from "@/lib/cloudflare-runtime";
import { stringifyJson } from "@/lib/crm-json";
import type { DraftStatus } from "@/lib/crm-types";

interface SendableDraftRow {
  id: number;
  status: DraftStatus;
  subject_line: string;
  plain_text_body: string;
  contact_name: string;
  contact_email: string | null;
}

export async function sendApprovedDraft(args: {
  draftId: number;
  actor: string;
}): Promise<void> {
  const db = getCrmDb();
  const resendApiKey = getResendApiKey();
  const draft = await db
    .prepare(
      `SELECT email_drafts.id,
              email_drafts.status,
              email_drafts.subject_line,
              email_drafts.plain_text_body,
              contacts.name AS contact_name,
              contacts.email AS contact_email
       FROM email_drafts
       INNER JOIN contacts ON contacts.id = email_drafts.contact_id
       WHERE email_drafts.id = ?
       LIMIT 1`,
    )
    .bind(args.draftId)
    .first<SendableDraftRow>();

  if (!draft) {
    throw new Error(`Email draft ${args.draftId} was not found.`);
  }

  if (draft.status === "approved") {
    throw new Error(`Email draft ${args.draftId} is already approved and was likely already sent.`);
  }

  if (draft.status === "archived") {
    throw new Error(`Email draft ${args.draftId} is archived and cannot be sent.`);
  }

  if (!draft.contact_email) {
    throw new Error(`Email draft ${args.draftId} cannot be sent because the contact has no email address.`);
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "David Klan <david@dazbeez.com>",
      to: [`${draft.contact_name} <${draft.contact_email}>`],
      subject: draft.subject_line,
      text: draft.plain_text_body,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Resend send failed for email draft ${args.draftId} with status ${response.status}. ${body.slice(0, 240)}`,
    );
  }

  await db
    .prepare(
      `UPDATE email_drafts
       SET status = 'approved',
           approved_by = ?,
           approved_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(args.actor, args.draftId)
    .run();

  await db
    .prepare(
      `INSERT INTO audit_logs (actor, action, entity_type, entity_id, after_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      args.actor,
      "email_draft.sent",
      "email_draft",
      args.draftId,
      stringifyJson({
        contact_email: draft.contact_email,
        subject_line: draft.subject_line,
      }),
    )
    .run();
}
