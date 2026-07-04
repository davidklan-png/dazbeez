import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  isReceiptsAuthorizedLight,
  requireReceiptsActor,
} from "@/lib/receipts/auth";

// Used by receipt pages before rendering protected content. The proxy already
// gates these routes via Clerk, so this is now defense-in-depth: if the proxy
// somehow let an unauthenticated request through, redirect to sign-in.
export async function assertReceiptsPageAccess(): Promise<void> {
  const requestHeaders = await headers();
  const ok = await isReceiptsAuthorizedLight(requestHeaders);
  if (!ok) redirect("/receipts/sign-in");
}

// Used by pages that need to know who is acting (actor shown in UI,
// written to audit log). Identity comes from Clerk via requireReceiptsActor.
// The proxy guarantees a valid session by the time we get here; the try/catch
// is defense-in-depth (clerkClient network failure, etc.) so a transient
// error redirects to sign-in instead of crashing the page.
export async function getReceiptsPageActor(): Promise<string> {
  try {
    return await requireReceiptsActor(await headers());
  } catch {
    redirect("/receipts/sign-in");
  }
}
