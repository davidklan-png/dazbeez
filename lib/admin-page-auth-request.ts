import { headers } from "next/headers";
import { assertAdminPageAccessFromHeaders } from "@/lib/admin-page-auth";

export async function assertAdminPageAccess() {
  const requestHeaders = await headers();
  assertAdminPageAccessFromHeaders(requestHeaders);
}
