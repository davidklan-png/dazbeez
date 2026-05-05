// Single source of truth for expense categories.
// Used by UI components, DB functions, extraction, and export — never duplicated elsewhere.

export type ExpenseCategoryCode =
  | "employee_welfare"
  | "advertising_promotion"
  | "entertainment"
  | "meeting"
  | "travel_transportation"
  | "communications"
  | "sales_commissions"
  | "supplies"
  | "utilities"
  | "newspapers_books"
  | "membership_dues"
  | "payment_fees"
  | "rent_lease"
  | "insurance";

export interface ExpenseCategory {
  code: ExpenseCategoryCode;
  jaName: string;
  enName: string;
  requiresAttendees: boolean;
  defaultBusinessTripEligible: boolean;
  displayOrder: number;
}

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  { code: "employee_welfare",      jaName: "福利厚生費",   enName: "Employee welfare expenses",          requiresAttendees: false, defaultBusinessTripEligible: false, displayOrder: 10  },
  { code: "advertising_promotion", jaName: "広告宣伝費",   enName: "Advertising and promotion expenses",  requiresAttendees: false, defaultBusinessTripEligible: false, displayOrder: 20  },
  { code: "entertainment",         jaName: "交際費",       enName: "Entertainment expenses",              requiresAttendees: true,  defaultBusinessTripEligible: false, displayOrder: 30  },
  { code: "meeting",               jaName: "会議費",       enName: "Meeting expenses",                    requiresAttendees: true,  defaultBusinessTripEligible: false, displayOrder: 40  },
  { code: "travel_transportation", jaName: "旅費交通費",   enName: "Travel and transportation expenses",  requiresAttendees: false, defaultBusinessTripEligible: true,  displayOrder: 50  },
  { code: "communications",        jaName: "通信費",       enName: "Communications expenses",             requiresAttendees: false, defaultBusinessTripEligible: false, displayOrder: 60  },
  { code: "sales_commissions",     jaName: "販売手数料",   enName: "Sales commissions",                   requiresAttendees: false, defaultBusinessTripEligible: false, displayOrder: 70  },
  { code: "supplies",              jaName: "消耗品費",     enName: "Supplies and consumables",            requiresAttendees: false, defaultBusinessTripEligible: false, displayOrder: 80  },
  { code: "utilities",             jaName: "水道光熱費",   enName: "Utilities",                           requiresAttendees: false, defaultBusinessTripEligible: false, displayOrder: 90  },
  { code: "newspapers_books",      jaName: "新聞図書費",   enName: "Newspapers and books",                requiresAttendees: false, defaultBusinessTripEligible: false, displayOrder: 100 },
  { code: "membership_dues",       jaName: "諸会費",       enName: "Membership dues",                     requiresAttendees: false, defaultBusinessTripEligible: false, displayOrder: 110 },
  { code: "payment_fees",          jaName: "支払手数料",   enName: "Payment and service fees",            requiresAttendees: false, defaultBusinessTripEligible: false, displayOrder: 120 },
  { code: "rent_lease",            jaName: "賃借料",       enName: "Rent and lease expenses",             requiresAttendees: false, defaultBusinessTripEligible: false, displayOrder: 130 },
  { code: "insurance",             jaName: "保険料",       enName: "Insurance premiums",                  requiresAttendees: false, defaultBusinessTripEligible: false, displayOrder: 140 },
];

export const EXPENSE_CATEGORY_CODES = new Set<string>(EXPENSE_CATEGORIES.map((c) => c.code));

export function getCategoryByCode(code: string): ExpenseCategory | undefined {
  return EXPENSE_CATEGORIES.find((c) => c.code === code);
}

export function requiresAttendees(code: string | null | undefined): boolean {
  if (!code) return false;
  return getCategoryByCode(code)?.requiresAttendees ?? false;
}

export function isBusinessTripEligible(code: string | null | undefined): boolean {
  if (!code) return false;
  return getCategoryByCode(code)?.defaultBusinessTripEligible ?? false;
}

export function isCanonicalCode(value: unknown): value is ExpenseCategoryCode {
  return typeof value === "string" && EXPENSE_CATEGORY_CODES.has(value);
}

// ─── Backward compatibility mapping ───────────────────────────────────────────
// Old values → canonical code. null means "ambiguous — show suggestion, require confirmation".

export const LEGACY_CATEGORY_MAP: Record<string, ExpenseCategoryCode | null> = {
  // Old receipt expense_type values
  "meeting-no-alcohol":    "meeting",
  "entertainment-alcohol": "entertainment",
  "transportation":        "travel_transportation",
  "travel":                "travel_transportation",
  "business_trip":         "travel_transportation",
  "books":                 "newspapers_books",
  "research":              "newspapers_books",
  "insurance":             "insurance",
  // Old AMEX intermediate codes (migration 0005)
  "meeting_no_alcohol":    "meeting",
  "entertainment_alcohol": "entertainment",
  "telecom":               "communications",
  "software":              null,       // ambiguous — show suggestion, require confirmation
  "office_supplies":       "supplies",
  "misc":                  null,       // require review
  "unknown":               null,       // require review
  "UNKNOWN":               null,
};

export function mapLegacyCategory(old: string | null | undefined): {
  code: ExpenseCategoryCode | null;
  ambiguous: boolean;
} {
  if (!old || old === "UNKNOWN" || old === "unknown") {
    return { code: null, ambiguous: false };
  }
  if (isCanonicalCode(old)) return { code: old, ambiguous: false };
  if (old in LEGACY_CATEGORY_MAP) {
    const mapped = LEGACY_CATEGORY_MAP[old]!;
    // software/misc are null → ambiguous
    const ambiguous = LEGACY_CATEGORY_MAP[old] === null && old !== "unknown" && old !== "UNKNOWN";
    return { code: mapped, ambiguous };
  }
  return { code: null, ambiguous: true };
}

// ─── Display helpers ───────────────────────────────────────────────────────────

export function formatCategoryLabel(code: string | null | undefined): string {
  if (!code) return "— Select category —";
  const cat = getCategoryByCode(code);
  if (!cat) return code;
  return `${cat.jaName} — ${cat.enName}`;
}
