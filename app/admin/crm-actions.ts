"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAdminActor } from "@/lib/admin-page-auth-request";
import { processApprovedBatch, updateBatchCardReview, updateSetting } from "@/lib/crm";
import { parseJsonValue } from "@/lib/crm-json";
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
