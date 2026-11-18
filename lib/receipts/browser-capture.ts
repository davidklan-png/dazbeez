import type { ExpenseType, PaymentPath, SourceType } from "./types";
import type { Source } from "./upload-policy";

export function isValidBrowserCaptureId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

// Key the selection before resizing; a repeated attempt keeps its logical identity.
export function browserCaptureId(file: File, ids: WeakMap<File, string>): string {
  let id = ids.get(file);
  if (!id) {
    id = crypto.randomUUID();
    ids.set(file, id);
  }
  return id;
}

export async function browserCaptureFingerprint(input: {
  sha256: string;
  contentType: string;
  filename: string;
  source: Source;
  sourceType: SourceType;
  paymentPath: PaymentPath;
  expenseType?: ExpenseType;
}): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([
    1, input.sha256, input.contentType, input.filename, input.source,
    input.sourceType, input.paymentPath, input.expenseType ?? null,
  ]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
