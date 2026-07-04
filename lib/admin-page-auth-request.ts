import { requireOwnerActor } from "@/lib/clerk-owner";

export async function assertAdminPageAccess(): Promise<void> {
  await requireOwnerActor();
}

export async function getAdminActor(): Promise<string> {
  return requireOwnerActor();
}
