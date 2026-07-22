import { auth, clerkClient } from "@clerk/nextjs/server";

// Receipts web auth — Clerk only.
//
// Authentication for `/receipts/*` and `/api/receipts/*` is enforced by
// `middleware.ts` via `clerkMiddleware` + `auth.protect()`. The helpers below
// are the handler/page-level identity resolvers that run after Clerk has
// already verified a signed-in session:
//   - isReceiptsAuthorizedLight: a no-DB redirect gate used by receipt pages
//     (defense in depth behind Clerk middleware).
//   - requireReceiptsActor: resolves the acting operator (primary email,
//     username, then Clerk user id) for route handlers and audit logging.
//
// The legacy Cloudflare Access JWT chain and the receipts Basic-auth fallback
// that used to live here were removed in Phase 4B — Clerk middleware owns all
// sign-in enforcement now. The old "remember this browser" HMAC device cookie
// was retired earlier (Phase 3); browser trust is gone entirely and device
// trust is mobile-only (lib/receipts/trusted-devices.ts).

// Middleware-safe: no DB calls. Identity comes from the Clerk session.
export async function isReceiptsAuthorizedLight(
  _requestHeaders: Headers,
): Promise<boolean> {
  const session = await auth();
  return !!session.userId;
}

// Single-pass: verifies auth and returns the actor. Identity comes from Clerk.
// By the time we get here Clerk middleware has gated the route, so the userId
// check is defense-in-depth.
export async function requireReceiptsActor(
  _requestHeaders: Headers,
): Promise<string> {
  const session = await auth();
  if (!session.userId) {
    throw new Error("Unauthorized receipts request.");
  }
  const client = await clerkClient();
  const user = await client.users.getUser(session.userId);
  const email = user.emailAddresses.find(
    (e) => e.id === user.primaryEmailAddressId,
  )?.emailAddress;
  return email ?? user.username ?? session.userId;
}
