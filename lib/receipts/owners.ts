// Owner allowlist for the receipts module.
//
// Owners get an admin view of the Trusted Devices settings page: every enrolled
// device across all users, with the ability to revoke any of them. Everyone
// else stays scoped to their own devices.
//
// Phase 2 Clerk cutover: ownership is now a Clerk `publicMetadata.role`
// ("owner") field on the user, not an env-var allowlist. The legacy
// `getReceiptsOwnerEmails` / `DEFAULT_OWNER_EMAILS` helpers below are dead
// code, deleted in Phase 4.

import { auth } from "@clerk/nextjs/server";

const DEFAULT_OWNER_EMAILS = ["david.klan@gmail.com"];

export function getReceiptsOwnerEmails(): string[] {
  const raw = process.env.RECEIPTS_OWNER_EMAILS?.trim();
  if (!raw) return DEFAULT_OWNER_EMAILS;
  const list = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_OWNER_EMAILS;
}

type SessionClaimsWithRole = {
  publicMetadata?: { role?: string };
};

/**
 * True if the current Clerk session's user has `publicMetadata.role ===
 * "owner"`. Reads from sessionClaims (no network call). Now async — both
 * call sites need `await`. The `_actor` parameter is retained for the
 * 2 existing callers but unused (Phase 4 deletes it).
 */
export async function isReceiptsOwner(
  _actor?: string | null,
): Promise<boolean> {
  const session = await auth();
  const role = (session.sessionClaims as SessionClaimsWithRole | undefined)
    ?.publicMetadata?.role;
  return role === "owner";
}
