// The operator's selected "work month" is carried across receipts pages via a
// single `month=YYYY-MM` query parameter — there is no D1 persistence, cookie,
// or global user preference. This module is the one authority for parsing that
// param into a usable value and stamping it onto receipts links.
//
// Client-safe and dependency-free: no server-only, runtime-binding, React, or
// Next.js imports. The constants below are the validation/href authority for
// the work month — they are not a config object, env override, parsing helper
// for arbitrary input, or clamp function.

const WORK_MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * True only for an exact `YYYY-MM` (e.g. "2026-06"). Rejects the review
 * queue's `"all"` recent-window sentinel, the empty string, and any malformed
 * value. Acts as a type guard so callers can narrow `string | null | undefined`
 * without a separate cast. Kept aligned with the review/export pages' own
 * `/^\d{4}-\d{2}$/` regex so navigation can't smuggle a value a destination
 * would treat differently.
 */
export function isValidWorkMonth(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && WORK_MONTH_RE.test(value);
}

/**
 * Resolve the active work month from a raw query value. Returns the validated
 * `YYYY-MM`, or `null` when there is no active work month (`all`, malformed, or
 * missing). `null` is the "do not propagate" signal every caller threads into
 * `withWorkMonth` — that is what keeps `month=all` and garbage out of URLs.
 */
export function resolveWorkMonth(
  value: string | null | undefined,
): string | null {
  return isValidWorkMonth(value) ? value : null;
}

/**
 * Stamp `?month=YYYY-MM` onto a path when there is a valid work month, else
 * return the path UNCHANGED (including its query string and fragment). The
 * single source of truth for "carry the month into a receipts link": every
 * nav/shortcut that should preserve context calls this, so the rule lives in
 * one place.
 *
 * Contract:
 *   - Invalid / null / `all` month → path returned verbatim (query + hash kept).
 *   - Unrelated query params are preserved in place.
 *   - An existing `month` param is REPLACED, never duplicated (so a link that
 *     already carries a concrete month is updated, not corrupted with two).
 *   - A URL fragment (`#…`) is preserved after the query string.
 *
 * Parsing is deliberately manual (split on the first `?` and first `#`) rather
 * than `new URL()`, because callers pass bare paths (`/receipts/review/…`) with
 * no origin. `URLSearchParams` is used only to round-trip the query safely.
 */
export function withWorkMonth(
  path: string,
  month: string | null | undefined,
): string {
  const m = resolveWorkMonth(month);
  if (!m) return path;

  // Split off the fragment (everything after the first '#'), then the query
  // (everything after the first '?'). Re-joining with the captured separators
  // preserves any stray '#'/`?' inside the fragment/query verbatim.
  const hashIndex = path.indexOf("#");
  const beforeHash = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : path.slice(hashIndex);

  const queryIndex = beforeHash.indexOf("?");
  const pathname = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const existingQuery =
    queryIndex === -1 ? "" : beforeHash.slice(queryIndex + 1);

  const params = new URLSearchParams(existingQuery);
  params.set("month", m);
  const query = params.toString();
  const queryStr = query ? `?${query}` : "";

  return `${pathname}${queryStr}${hash}`;
}
