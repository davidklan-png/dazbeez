import { headers } from "next/headers";
import {
  getReceiptsActor,
  isReceiptsAuthorizedLight,
  isReceiptsAuthorized,
} from "@/lib/receipts/auth";

// Used by the layout on every receipts page render. Keeps to cheap checks
// only (HMAC cookie, CF Access header presence) so it doesn't hit the Worker
// CPU limit with RSA operations on every page load.
export async function assertReceiptsPageAccess(): Promise<void> {
  const requestHeaders = await headers();
  const ok = await isReceiptsAuthorizedLight(requestHeaders);
  if (!ok) throw new Error("Unauthorized receipts request.");
}

// Used by pages that need to know who is acting (actor shown in UI,
// written to audit log). Runs the full check including DB revocation.
export async function getReceiptsPageActor(): Promise<string> {
  const requestHeaders = await headers();
  const ok = await isReceiptsAuthorized(requestHeaders);
  if (!ok) throw new Error("Unauthorized receipts request.");
  return getReceiptsActor(requestHeaders);
}
