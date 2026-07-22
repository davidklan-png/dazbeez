// Owner role for the receipts module.
//
// Owners get an admin view of the Trusted Devices settings page: every enrolled
// mobile device across all users, with the ability to revoke any of them.
// Everyone else stays scoped to their own devices.
//
// Ownership is a Clerk `publicMetadata.role === "owner"` field on the user.
// The role check is shared with `requireOwnerActor` via `isOwnerRole` in
// `lib/clerk-owner.ts` (single source of truth for "owner").

import { auth } from "@clerk/nextjs/server";
import { isOwnerRole } from "@/lib/clerk-owner";

/**
 * True if the current Clerk session's user has `publicMetadata.role ===
 * "owner"`. Reads from `sessionClaims` (no network call).
 */
export async function isReceiptsOwner(): Promise<boolean> {
  const session = await auth();
  return isOwnerRole(session.sessionClaims);
}
