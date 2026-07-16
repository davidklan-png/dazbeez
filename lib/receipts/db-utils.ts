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
 * Cloudflare D1's current maximum bound parameters per query.
 * See: https://developers.cloudflare.com/d1/platform/limits/
 */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * Fixed, non-ID bindings deliberately reserved within the D1 bind budget.
 * Query shapes requiring more fixed bindings must use a smaller local chunk.
 */
export const D1_ID_CHUNK_FIXED_BIND_HEADROOM = 10;

/**
 * Default chunk for D1 `IN` queries with one binding per ID. Derived from the
 * bind budget minus the reserved headroom so that queries binding a few fixed
 * values alongside the ID list stay within the D1 limit.
 */
export const D1_ID_CHUNK_SIZE = D1_MAX_BOUND_PARAMS - D1_ID_CHUNK_FIXED_BIND_HEADROOM;
