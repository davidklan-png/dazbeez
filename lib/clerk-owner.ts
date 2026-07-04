import { auth, clerkClient } from "@clerk/nextjs/server";

/**
 * Shape of the Clerk session JWT's `publicMetadata` claim. Clerk's
 * `CustomJwtSessionClaims` is `{ [k: string]: unknown }`, so we narrow here.
 */
type SessionClaimsWithRole = {
  publicMetadata?: { role?: string };
};

/**
 * Returns the actor email if the current Clerk session's user has
 * `publicMetadata.role === "owner"`, otherwise throws. Single source of
 * truth for /admin and cross-user device revoke. The role is read from
 * `sessionClaims.publicMetadata` (no network call) since Clerk includes
 * publicMetadata in the session JWT by default; the email requires a
 * `clerkClient.users.getUser()` lookup.
 */
export async function requireOwnerActor(): Promise<string> {
  const session = await auth();
  const role = (session.sessionClaims as SessionClaimsWithRole | undefined)
    ?.publicMetadata?.role;
  if (!session.userId || role !== "owner") {
    throw new Error("Unauthorized: owner role required.");
  }
  const client = await clerkClient();
  const user = await client.users.getUser(session.userId);
  const email = user.emailAddresses.find(
    (e) => e.id === user.primaryEmailAddressId,
  )?.emailAddress;
  return email ?? user.username ?? session.userId;
}
