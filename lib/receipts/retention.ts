export const RECEIPT_RETENTION_YEARS = 10;
export const RECEIPT_RETENTION_POLICY = "tax-record-10y";

export function retentionUntilIso(fromIso?: string | null): string {
  const from = fromIso ? new Date(fromIso) : new Date();
  const base = Number.isNaN(from.getTime()) ? new Date() : from;
  const retainedUntil = new Date(base);
  retainedUntil.setUTCFullYear(
    retainedUntil.getUTCFullYear() + RECEIPT_RETENTION_YEARS,
  );
  return retainedUntil.toISOString();
}

export function retentionMetadata(fromIso?: string | null): Record<string, string> {
  return {
    retentionPolicy: RECEIPT_RETENTION_POLICY,
    retentionYears: String(RECEIPT_RETENTION_YEARS),
    retentionUntil: retentionUntilIso(fromIso),
    legalHold: "true",
  };
}
