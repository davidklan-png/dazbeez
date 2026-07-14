// Merchant canonicalization — survive OCR-garbled convenience-store chain
// names in matching (duplicate grouping + IC-card top-up venue detection).
//
// WHY: the MLX extractor (lib/receipts/extraction.ts parseMerchant, VLM +
// regex fallback) occasionally emits garbled chain spellings. In 2026-06 a
// PASMO top-up receipt was stored as "セブンーエレブン" (long-vowel ー, エ for
// イ, no branch) while its re-photograph was "セブン-イレブン 東中野末広橋店".
// Two photos of one charge, never clustered by computeDuplicateReceiptWarnings
// (different merchant string → different group key), and the garbled form
// missed the IC-card venue list entirely (IC warning undercounted, 7 not 8).
//
// This module normalizes those variants to a canonical chain token for
// MATCHING ONLY. It never rewrites the stored/displayed merchant — display
// keeps the raw string the operator sees. Read-side only; see PR A backlog
// note for the write-side (canonical_merchant column) trade-off.
//
// Data-driven: extend the CHAINS table, not the code, as new garbles appear.

/** The convenience-store chains we canonicalize. */
export type MerchantChain =
  | "seven_eleven"
  | "lawson"
  | "familymart"
  | "newdays";

/** Canonical display token per chain (the form we match/group on). */
export const CHAIN_CANONICAL: Record<MerchantChain, string> = {
  seven_eleven: "セブン-イレブン",
  lawson: "ローソン",
  familymart: "ファミリーマート",
  newdays: "NewDays",
};

// Raw variant needles per chain. These are the READABLE forms; they are
// normalized (below) once at load time, so list a variant however it appears
// in the wild — normalize() unifies separators, case, and width before the
// substring test. Add garbles here as extraction produces them.
const CHAINS: { chain: MerchantChain; needles: string[] }[] = [
  {
    chain: "seven_eleven",
    // The prod garble "セブンーエレブン" (ー + エ) is listed explicitly because
    // separator-stripping alone can't map エ → イ.
    needles: [
      "セブン-イレブン",
      "セブンーエレブン",
      "セブンイレブン",
      "Seven-Eleven",
      "7-Eleven",
      "7 Eleven",
    ],
  },
  { chain: "lawson", needles: ["ローソン", "LAWSON", "Lawson"] },
  {
    chain: "familymart",
    needles: ["ファミリーマート", "ファミマ", "FamilyMart", "Family Mart"],
  },
  { chain: "newdays", needles: ["NewDays", "New Days", "ニューデイズ"] },
];

// Width/case/separator unification applied to BOTH the input merchant and the
// needles so a substring test is robust to extraction noise.
//
// NFKC folds full-width ASCII (Ａ→A, ７→7, －→-) and half-width katakana to
// full-width. We then lower-case and strip every separator-like rune the
// extractor has emitted between/within chain names: whitespace, the hyphen-
// minus (U+002D), the hyphen/dash family (U+2010–U+2015), the katakana
// prolonged-sound mark ー (U+30FC), and the katakana middle dot ・ (U+30FB).
// We deliberately do NOT strip other kana, so branch suffixes (東中野末広橋店)
// survive — canonicalizeMerchant returns only the chain token, but the raw
// merchant is preserved verbatim for display.
//
// The class is built from explicit code points (not a literal "/[...]/") so a
// literal "-" can't be misparsed as a range operator next to the \s shorthand.
const SEPARATOR_CODE_POINTS = [
  0x002d, // hyphen-minus "-"
  0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, // hyphen / dash family
  0x30fc, // katakana prolonged-sound mark "ー"
  0x30fb, // katakana middle dot "・"
];
const SEPARATOR_RE = new RegExp(
  "[\\s" +
    SEPARATOR_CODE_POINTS.map((cp) => "\\u" + cp.toString(16).padStart(4, "0")).join("") +
    "]",
  "gu",
);

export function normalizeMerchantKey(merchant: string): string {
  return merchant.normalize("NFKC").toLowerCase().replace(SEPARATOR_RE, "");
}

// Pre-normalized needles, looked up once.
const NORMALIZED_CHAINS: { chain: MerchantChain; needles: string[] }[] =
  CHAINS.map((c) => ({
    chain: c.chain,
    needles: c.needles.map(normalizeMerchantKey).filter(Boolean),
  }));

/**
 * Identify the convenience-store chain a merchant string refers to, or null if
 * it isn't one of the known chains. Substring match against normalized needles
 * (so a branch suffix or surrounding text doesn't defeat it). First chain in
 * declaration order wins on overlap (the chains are orthographic and don't
 * share normalized needles).
 */
export function detectMerchantChain(
  merchant: string | null | undefined,
): MerchantChain | null {
  if (!merchant) return null;
  const n = normalizeMerchantKey(merchant);
  if (!n) return null;
  for (const c of NORMALIZED_CHAINS) {
    if (c.needles.some((needle) => n.includes(needle))) return c.chain;
  }
  return null;
}

/**
 * Return the canonical chain token if the merchant is a known chain, else the
 * merchant unchanged. Use this to build MATCHING KEYS (duplicate grouping) —
 * it collapses garbled/variant spellings of the same chain to one token so
 * re-photographs and extraction variants cluster together. Branch info is
 * intentionally dropped from the key (two photos of one slip often disagree on
 * whether the branch was captured); the duplicate warning is non-blocking and
 * advisory, so the rare same-chain-different-branch same-amount-same-day false
 * positive is acceptable (operator confirms distinct). Never use this for
 * display — display the raw stored merchant.
 */
export function canonicalizeMerchant(merchant: string | null | undefined): string {
  if (!merchant) return merchant ?? "";
  const chain = detectMerchantChain(merchant);
  return chain ? CHAIN_CANONICAL[chain] : merchant;
}
