// Shared browser acknowledgement and request-token boundary.
export function isReceiptRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isReceiptRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes("DZ_RECEIPT_REVISION_CONFLICT");
}

export const RECEIPT_CONFLICT_MESSAGE =
  "This receipt changed elsewhere or is no longer available. Your edits are kept here. Reload and review the current receipt before editing again.";

export class ReceiptNotFoundError extends Error {
  constructor(id: string) {
    super(`Receipt ${id} not found.`);
  }
}
