"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAdminActor } from "@/lib/admin-page-auth-request";
import { getCrmDb } from "@/lib/cloudflare-runtime";
import { sendApprovedDraft } from "@/lib/crm-email-sender";
import { processApprovedBatch, updateBatchCardReview, updateSetting } from "@/lib/crm";
import { parseJsonValue, stringifyJson } from "@/lib/crm-json";
import type { ExtractedContactFields } from "@/lib/crm-types";

function toNullable(value: FormDataEntryValue | null) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function parseSettingsPayload(formData: FormData) {
  try {
    return JSON.parse(String(formData.get("payload") ?? "{}")) as unknown;
  } catch {
    throw new Error("Settings were not saved — the JSON is invalid. Fix the syntax and try again.");
  }
}

function parseDraftContent(formData: FormData) {
  const subjectLine = String(formData.get("subjectLine") ?? "").trim();
  const plainTextBody = String(formData.get("plainTextBody") ?? "").replace(/\r\n/g, "\n").trim();

  if (!subjectLine) {
    throw new Error("Draft subject is required.");
  }

  if (!plainTextBody) {
    throw new Error("Draft body is required.");
  }

  return { subjectLine, plainTextBody };
}

async function updateDraftContent(args: {
  draftId: number;
  actor: string;
  subjectLine: string;
  plainTextBody: string;
}) {
  const db = getCrmDb();
  const draft = await db
    .prepare(
      `SELECT contact_id, status, subject_line, plain_text_body
       FROM email_drafts
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(args.draftId)
    .first<{
      contact_id: number;
      status: string;
      subject_line: string;
      plain_text_body: string;
    }>();

  if (!draft) {
    throw new Error(`Email draft ${args.draftId} was not found.`);
  }

  if (draft.status === "approved") {
    throw new Error(`Email draft ${args.draftId} has already been sent and can no longer be edited.`);
  }

  if (draft.status === "archived") {
    throw new Error(`Email draft ${args.draftId} is archived and cannot be edited.`);
  }

  await db
    .prepare(
      `UPDATE email_drafts
       SET subject_line = ?,
           plain_text_body = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(args.subjectLine, args.plainTextBody, args.draftId)
    .run();

  await db
    .prepare(
      `INSERT INTO audit_logs (actor, action, entity_type, entity_id, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.actor,
      "email_draft.updated",
      "email_draft",
      args.draftId,
      stringifyJson({
        subject_line: draft.subject_line,
        plain_text_body: draft.plain_text_body,
      }),
      stringifyJson({
        subject_line: args.subjectLine,
        plain_text_body: args.plainTextBody,
      }),
    )
    .run();

  return {
    contactId: draft.contact_id,
  };
}

export async function saveBatchCardReviewAction(formData: FormData) {
  const actor = await getAdminActor();
  const batchCardId = Number(formData.get("batchCardId") ?? 0);
  const batchId = Number(formData.get("batchId") ?? 0);
  const sourceContactId = Number(formData.get("sourceContactId") ?? 0) || null;
  const invalidReason = toNullable(formData.get("invalidReason"));
  const notes = toNullable(formData.get("notes"));
  const markApproved = String(formData.get("markApproved") ?? "") === "true";
  const confidence = parseJsonValue(String(formData.get("confidenceJson") ?? "{}"), {});

  const normalized: ExtractedContactFields = {
    full_name: toNullable(formData.get("full_name")),
    first_name: toNullable(formData.get("first_name")),
    last_name: toNullable(formData.get("last_name")),
    full_name_native: toNullable(formData.get("full_name_native")),
    job_title: toNullable(formData.get("job_title")),
    department: toNullable(formData.get("department")),
    company_name: toNullable(formData.get("company_name")),
    company_name_native: toNullable(formData.get("company_name_native")),
    email: toNullable(formData.get("email")),
    phone: toNullable(formData.get("phone")),
    mobile: toNullable(formData.get("mobile")),
    website: toNullable(formData.get("website")),
    linkedin_url: toNullable(formData.get("linkedin_url")),
    address: toNullable(formData.get("address")),
    postal_code: toNullable(formData.get("postal_code")),
    city: toNullable(formData.get("city")),
    state_prefecture: toNullable(formData.get("state_prefecture")),
    country: toNullable(formData.get("country")),
    notes_from_card: toNullable(formData.get("notes_from_card")),
    raw_ocr_text: String(formData.get("raw_ocr_text") ?? ""),
    pronouns: toNullable(formData.get("pronouns")),
    furigana: toNullable(formData.get("furigana")),
    emails: [],
    phone_numbers: [],
  };

  await updateBatchCardReview({
    actor,
    batchCardId,
    normalized,
    confidence,
    sourceContactId,
    invalidReason,
    notes,
    markApproved,
  });

  revalidatePath(`/admin/batches/${batchId}`);
  redirect(`/admin/batches/${batchId}`);
}

export async function processApprovedBatchAction(formData: FormData) {
  const actor = await getAdminActor();
  const batchId = Number(formData.get("batchId") ?? 0);
  await processApprovedBatch({ actor, batchId });
  revalidatePath(`/admin/batches/${batchId}`);
  revalidatePath("/admin");
  revalidatePath("/admin/contacts");
  revalidatePath("/admin/companies");
  revalidatePath("/admin/drafts");
  redirect(`/admin/batches/${batchId}`);
}

export async function updateDraftEmailAction(formData: FormData) {
  const actor = await getAdminActor();
  const draftId = Number(formData.get("draftId") ?? 0);
  const { subjectLine, plainTextBody } = parseDraftContent(formData);
  const draft = await updateDraftContent({
    draftId,
    actor,
    subjectLine,
    plainTextBody,
  });

  revalidatePath(`/admin/contacts/${draft.contactId}`);
  revalidatePath("/admin/contacts");
  revalidatePath("/admin/drafts");
  redirect(`/admin/contacts/${draft.contactId}`);
}

export async function sendDraftEmailAction(formData: FormData) {
  const actor = await getAdminActor();
  const draftId = Number(formData.get("draftId") ?? 0);
  const { subjectLine, plainTextBody } = parseDraftContent(formData);
  const draft = await updateDraftContent({
    draftId,
    actor,
    subjectLine,
    plainTextBody,
  });

  await sendApprovedDraft({ draftId, actor });
  revalidatePath(`/admin/contacts/${draft.contactId}`);
  revalidatePath("/admin/contacts");
  revalidatePath("/admin/drafts");
  redirect(`/admin/contacts/${draft.contactId}`);
}

export async function updateProfileSettingsAction(formData: FormData) {
  const actor = await getAdminActor();
  await updateSetting({
    actor,
    key: "dazbeez_profile",
    value: parseSettingsPayload(formData),
  });
  revalidatePath("/admin/settings");
  redirect("/admin/settings");
}

export async function updateThresholdSettingsAction(formData: FormData) {
  const actor = await getAdminActor();
  await updateSetting({
    actor,
    key: "crm_thresholds",
    value: parseSettingsPayload(formData),
  });
  revalidatePath("/admin/settings");
  redirect("/admin/settings");
}

export async function updateIntegrationSettingsAction(formData: FormData) {
  const actor = await getAdminActor();
  await updateSetting({
    actor,
    key: "crm_integrations",
    value: parseSettingsPayload(formData),
  });
  revalidatePath("/admin/settings");
  redirect("/admin/settings");
}
