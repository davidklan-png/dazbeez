'use server'

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertAdminPageAccess } from "@/lib/admin-page-auth-request";
import { getNfcAdminApiConfig, getNfcContactDeleteUrl } from "@/lib/admin-nfc-dashboard";

export async function deleteNfcContact(contactId: number) {
  await assertAdminPageAccess();
  const { apiKey } = getNfcAdminApiConfig();

  if (!apiKey) {
    throw new Error("NFC admin API key is not configured on the server.");
  }

  const response = await fetch(getNfcContactDeleteUrl(contactId), {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to delete NFC contact ${contactId}: ${response.status} ${body.slice(0, 160)}`);
  }

  revalidatePath("/admin");
}

export async function updateNfcVCard(formData: FormData) {
  await assertAdminPageAccess();
  const { apiKey, vcardUrl } = getNfcAdminApiConfig();

  if (!apiKey) {
    throw new Error("NFC admin API key is not configured on the server.");
  }

  const payload = {
    fileName: String(formData.get("fileName") ?? ""),
    familyName: String(formData.get("familyName") ?? ""),
    givenName: String(formData.get("givenName") ?? ""),
    fullName: String(formData.get("fullName") ?? ""),
    organization: String(formData.get("organization") ?? ""),
    title: String(formData.get("title") ?? ""),
    email: String(formData.get("email") ?? ""),
    website: String(formData.get("website") ?? ""),
    linkedin: String(formData.get("linkedin") ?? ""),
  };

  const response = await fetch(vcardUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to update NFC vCard: ${response.status} ${body.slice(0, 160)}`);
  }

  redirect("/admin");
}
