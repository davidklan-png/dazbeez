// Owner allowlist for the receipts module.
//
// Owners get an admin view of the Trusted Devices settings page: every enrolled
// device across all users, with the ability to revoke any of them. Everyone
// else stays scoped to their own devices. Configure via the
// RECEIPTS_OWNER_EMAILS secret (comma-separated emails); defaults to the
// project owner so the feature works before the secret is set.

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

/** True if the actor (CF Access email) is a designated receipts owner. */
export function isReceiptsOwner(actor: string | null | undefined): boolean {
  if (!actor) return false;
  return getReceiptsOwnerEmails().includes(actor.trim().toLowerCase());
}
