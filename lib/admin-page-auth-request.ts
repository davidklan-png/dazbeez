import { notFound } from "next/navigation";
import { OwnerAuthorizationError, requireOwnerActor } from "@/lib/clerk-owner";

// Clerk owner-role guards for admin pages and server actions.
//
// Clerk middleware (`auth.protect()`) already stops signed-out requests before
// they reach admin code. These helpers enforce the owner role for the signed-in
// case:
//   - assertAdminPageAccess: admin pages/layout. A signed-in non-owner is
//     handled intentionally via `notFound()` (a deliberate 404 / concealment),
//     never an unhandled 500.
//   - getAdminActor: admin server actions that need the actor email. A
//     non-owner throws `OwnerAuthorizationError`, failing the action before any
//     mutation (defense in depth; the admin UI is owner-only).

export async function assertAdminPageAccess(): Promise<void> {
  try {
    await requireOwnerActor();
  } catch (error) {
    if (error instanceof OwnerAuthorizationError) {
      notFound();
    }
    throw error;
  }
}

export async function getAdminActor(): Promise<string> {
  return requireOwnerActor();
}
