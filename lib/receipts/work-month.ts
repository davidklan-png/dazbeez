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
 * Append `?month=YYYY-MM` to a path when there is a valid work month, else
 * return the path unchanged. The single source of truth for "carry the month
 * into a receipts link": every nav/shortcut that should preserve context calls
 * this, so the rule lives in one place.
 *
 * - Preserves an existing query string (`/receipts/capture?payment=CASH` →
 *   `…&month=2026-06`), so shortcut links keep their own params.
 * - Never propagates `month=all` or invalid input (returns the path bare).
 * - Never duplicates an existing `month` param: destinations that already own
 *   their month (Review/Reconcile/Export read `searchParams` directly) build
 *   their own hrefs and don't route through here.
 */
export function withWorkMonth(
  path: string,
  month: string | null | undefined,
): string {
  const m = resolveWorkMonth(month);
  if (!m) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}month=${m}`;
}
