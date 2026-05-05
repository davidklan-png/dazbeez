import { headers } from "next/headers";
import {
  assertReceiptsAccessFromHeaders,
  getReceiptsActor,
} from "@/lib/receipts/auth";

export async function assertReceiptsPageAccess(): Promise<void> {
  const requestHeaders = await headers();
  await assertReceiptsAccessFromHeaders(requestHeaders);
}

export async function getReceiptsPageActor(): Promise<string> {
  const requestHeaders = await headers();
  await assertReceiptsAccessFromHeaders(requestHeaders);
  return getReceiptsActor(requestHeaders);
}
