// Sparse receipt-update helper. Pure + client-safe (no server imports), so it
// unit-tests without D1 mocks and is reusable client-side.
//
// Problem it fixes: a PATCH route that builds an update object with optional
// fields left as `undefined` (own properties present, value undefined). JS's
// `in` operator reports those keys as present, so a presence check like
// `"exportStatementMonth" in input` is TRUE and the column gets bound to
// `undefined ?? null` → NULL (clearing sticky data). Meanwhile JSON.stringify
// OMITS undefined-valued properties, so the generic audit hid the clearing.
//
// compactUndefinedReceiptUpdate drops own properties whose value is undefined,
// preserving explicit null (a legitimate "clear this field" signal) and all
// other values. The route passes the compacted object to updateReceiptRecord so
// the same sparse shape drives both the SQL mutation and the generic audit.
// updateReceiptRecord additionally uses `!== undefined` presence checks as
// defense in depth (other callers may not compact).

export function compactUndefinedReceiptUpdate<T extends object>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const value = input[key as keyof T];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

export type ExportStatementMonthOverride =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "month"; value: string };

/**
 * Parse a raw exportStatementMonth override value (pure). The route rejects
 * `empty` (stored membership is the sticky authority — no unassignment) and
 * `invalid`; for `month` it then checks the month is export-open. The UI only
 * ever sends a concrete target month. Extracted so the rejection policy is
 * unit-testable without auth/D1.
 */
export function parseExportStatementMonthOverride(
  raw: unknown,
): ExportStatementMonthOverride {
  if (raw === null || raw === "") return { kind: "empty" };
  if (typeof raw === "string" && /^\d{4}-\d{2}$/.test(raw)) {
    return { kind: "month", value: raw };
  }
  return { kind: "invalid" };
}
