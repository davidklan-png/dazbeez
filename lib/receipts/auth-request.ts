import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  isReceiptsAuthorizedLight,
  requireReceiptsActor,
} from "@/lib/receipts/auth";

// Used by receipt pages before rendering protected content. Keeps to cheap
// checks only (HMAC cookie, CF Access header presence) so page loads avoid
// unnecessary D1 work and Worker CPU pressure.
export async function assertReceiptsPageAccess(): Promise<void> {
  const requestHeaders = await headers();
  const ok = await isReceiptsAuthorizedLight(requestHeaders);
  if (!ok) redirect("/receipts/enroll");
}

// Used by pages that need to know who is acting (actor shown in UI,
// written to audit log). Runs the full check including DB revocation —
// single pass, one verifyDeviceCookie round-trip.
export async function getReceiptsPageActor(): Promise<string> {
  return requireReceiptsActor(await headers());
}
