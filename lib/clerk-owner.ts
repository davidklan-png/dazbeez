import { auth, clerkClient } from "@clerk/nextjs/server";

/**
 * Shape of the Clerk session JWT's `publicMetadata` claim. Clerk's
 * `CustomJwtSessionClaims` is `{ [k: string]: unknown }`, so we narrow here.
 */
type SessionClaimsWithRole = {
  publicMetadata?: { role?: string };
};

/**
 * Thrown when the current Clerk session is NOT an owner — either no signed-in
 * user, or `publicMetadata.role !== "owner"`. This is a narrow, typed error so
 * callers can branch on `instanceof OwnerAuthorizationError` (route handlers
 * return 403; admin pages call `notFound()`) instead of matching arbitrary
 * error text.
 */
export class OwnerAuthorizationError extends Error {
  constructor(message = "Owner role required.") {
    super(message);
    this.name = "OwnerAuthorizationError";
  }
}

/**
 * Pure predicate: does the given Clerk session claim carry the owner role?
 * Single source of truth for "owner" — used by `requireOwnerActor` (throws)
 * and `isReceiptsOwner` (boolean). The role lives in
 * `sessionClaims.publicMetadata`, which Clerk includes in the session JWT, so
 * this needs no network call.
 */
export function isOwnerRole(sessionClaims: unknown): boolean {
  const role = (
    sessionClaims as SessionClaimsWithRole | undefined
  )?.publicMetadata?.role;
  return role === "owner";
}

/**
 * Returns the actor email if the current Clerk session's user has
 * `publicMetadata.role === "owner"`, otherwise throws
 * `OwnerAuthorizationError`. Owner privilege for `/admin`, admin API routes,
 * and cross-user device revoke. Clerk middleware (`auth.protect()`) already
 * verifies the caller is signed in before this runs; this enforces the owner
 * role. The email requires a `clerkClient.users.getUser()` lookup.
 */
export async function requireOwnerActor(): Promise<string> {
  const session = await auth();
  if (!session.userId || !isOwnerRole(session.sessionClaims)) {
    throw new OwnerAuthorizationError();
  }
  const client = await clerkClient();
  const user = await client.users.getUser(session.userId);
  const email = user.emailAddresses.find(
    (e) => e.id === user.primaryEmailAddressId,
  )?.emailAddress;
  return email ?? user.username ?? session.userId;
}
