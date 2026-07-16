export function nowIso(): string {
  return new Date().toISOString();
}

export function newUuid(): string {
  return crypto.randomUUID();
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Default chunk for D1 `IN` queries with one binding per ID. Ninety leaves
 * headroom for queries that also bind a small number of fixed values.
 * Query shapes with different bind math may use smaller local chunks.
 */
export const D1_ID_CHUNK_SIZE = 90;
