import { headers } from "next/headers";
import { assertAdminPageAccessFromHeaders, getAdminPageUsernameFromHeaders } from "@/lib/admin-page-auth";

export async function assertAdminPageAccess() {
  const requestHeaders = await headers();
  assertAdminPageAccessFromHeaders(requestHeaders);
}

export async function getAdminActor() {
  const requestHeaders = await headers();
  assertAdminPageAccessFromHeaders(requestHeaders);
  return getAdminPageUsernameFromHeaders(requestHeaders) ?? "admin";
}
