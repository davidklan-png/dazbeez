/**
 * Maximum number of characters the contact-form message textarea accepts.
 * Matches the `maxLength` attribute on the `<textarea>` in
 * components/contact-form.tsx, so a URL-prefilled value can never start out
 * past the limit the UI already enforces.
 */
export const CONTACT_MESSAGE_MAX_LENGTH = 4000;

/**
 * Normalize a `message` value coming from the contact page's URL search params
 * into a safe plain-text prefill for the message textarea.
 *
 * - Accepts the raw `string | string[] | undefined` shape Next.js exposes for
 *   query params (repeated `?message=a&message=b` arrives as `["a","b"]`); when
 *   given an array it uses the first value.
 * - Trims surrounding whitespace and returns "" for missing/blank/invalid
 *   input, so an absent or malformed param leaves the message blank.
 * - Clamps to {@link CONTACT_MESSAGE_MAX_LENGTH} using UTF-16 code units, the
 *   same unit the textarea's `maxLength` and character counter use.
 * - Preserves Unicode (incl. Japanese) and internal line breaks.
 *
 * The value is treated strictly as plain textarea text — it is never rendered
 * as HTML and never auto-submits the form.
 */
export function normalizeMessagePrefill(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string") return "";
  const trimmed = first.trim();
  if (trimmed.length === 0) return "";
  return trimmed.slice(0, CONTACT_MESSAGE_MAX_LENGTH);
}
