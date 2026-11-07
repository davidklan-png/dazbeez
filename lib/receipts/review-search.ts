// Cross-month receipt search for the Review tab (TASK-041). Pure and
// client-safe: the parser + SQL builder are unit-tested without D1; the only
// executor is searchReceiptRecords in db.ts. Display-only scope — this NEVER
// feeds the closing/export working set (review-scope.ts stays the authority).
//
// Deliberately does NOT use the `search_text` column (0014): nothing ever
// writes it, so it is NULL for every live row. Queries hit merchant /
// original_filename / amount_minor / transaction_date directly.

/** What `?q=` parsed into. At least one of the three slots is non-null
 *  whenever parseReviewSearch returns non-null. */
export type ReviewSearchParsed = {
  /** Whitespace-separated tokens that were neither a date nor an amount,
   *  casefolded. Each must match merchant OR original_filename (LIKE). */
  terms: string[];
  /** First amount token (`¥?[\d,]+円?`), in minor units. JPY is 0-decimal, so
   *  minor units == the digits as typed. */
  amountMinor: number | null;
  /** First `YYYY-MM-DD` token — exact transaction_date equality. */
  date: string | null;
};

const DATE_TOKEN = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_TOKEN = /^¥?([\d,]+)円?$/;

/** Parse the raw `q` search input. Returns null when the input is empty after
 *  trim. Token order: a token is a date if it is YYYY-MM-DD, an amount if it
 *  is `¥?digits,commas円?`, otherwise a (casefolded) text term. First date /
 *  amount win; further ones fall through to terms. */
export function parseReviewSearch(raw: string): ReviewSearchParsed | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const terms: string[] = [];
  let amountMinor: number | null = null;
  let date: string | null = null;
  for (const token of trimmed.split(/\s+/)) {
    if (date === null && DATE_TOKEN.test(token)) {
      date = token;
    } else if (amountMinor === null && AMOUNT_TOKEN.test(token)) {
      amountMinor = Number(token.replace(AMOUNT_TOKEN, "$1").replace(/,/g, ""));
    } else {
      terms.push(token.toLowerCase());
    }
  }
  return { terms, amountMinor, date };
}

/** Escape LIKE wildcards so a term containing `%` / `_` / `\` matches
 *  literally (paired with `ESCAPE '\'` in the SQL). */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Build the search WHERE fragment (without leading WHERE) + its positional
 *  binds. Terms AND together; each term must appear in merchant OR
 *  original_filename. Deleted receipts are always excluded. Params order
 *  matches the ? placeholders left-to-right. */
export function buildReviewSearchSql(parsed: ReviewSearchParsed): {
  where: string;
  params: unknown[];
} {
  const conditions: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];
  for (const term of parsed.terms) {
    const like = `%${escapeLike(term)}%`;
    conditions.push(
      "(LOWER(merchant) LIKE ? ESCAPE '\\' OR LOWER(original_filename) LIKE ? ESCAPE '\\')",
    );
    params.push(like, like);
  }
  if (parsed.amountMinor !== null) {
    conditions.push("amount_minor = ?");
    params.push(parsed.amountMinor);
  }
  if (parsed.date !== null) {
    conditions.push("transaction_date = ?");
    params.push(parsed.date);
  }
  return { where: conditions.join(" AND "), params };
}
