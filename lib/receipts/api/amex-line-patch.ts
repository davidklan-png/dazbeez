// Pure parse+validate for PATCH /api/receipts/amex/lines/[id].
//
// Extracted from the route so the contract the DB layer relies on — a SPARSE
// update input carrying only fields the request actually sent — is unit-
// testable without D1. The #67 regression (an always-present key with value
// undefined NULLed out sibling columns on every save) is guarded by the
// "only include a key when present" construction below + the DB layer's
// `"key" in input` checks for nullable fields.

import { isCanonicalCode } from "@/lib/receipts/categories";
import type { updateAmexLineCategory } from "@/lib/receipts/db";
import type {
  AmexBusinessTripStatus,
  AmexCategoryStatus,
  AmexExpenseCategory,
  AmexReceiptStatus,
} from "@/lib/receipts/types";

const VALID_EXPENSE_CATEGORIES: AmexExpenseCategory[] = [
  "meeting_no_alcohol",
  "entertainment_alcohol",
  "transportation",
  "books",
  "research",
  "insurance",
  "software",
  "telecom",
  "office_supplies",
  "travel",
  "business_trip",
  "misc",
  "unknown",
];
const VALID_CATEGORY_STATUSES: AmexCategoryStatus[] = [
  "uncategorized",
  "suggested",
  "confirmed",
];
const VALID_RECEIPT_STATUSES: AmexReceiptStatus[] = [
  "missing_receipt",
  "matched",
  "no_receipt_required",
  "receipt_not_available",
];
const VALID_BUSINESS_TRIP_STATUSES: AmexBusinessTripStatus[] = [
  "not_applicable",
  "candidate",
  "confirmed",
  "excluded",
];

export type AmexLinePatchInput = Parameters<typeof updateAmexLineCategory>[1];

export type AmexLinePatchBody = {
  expenseCategory?: string;
  expenseCategoryCode?: string;
  categoryStatus?: string;
  receiptStatus?: string;
  receiptMissingReason?: string | null;
  businessTripStatus?: string;
};

export type AmexLinePatchResult =
  | { ok: true; input: AmexLinePatchInput }
  | { ok: false; error: string };

/**
 * Validate the PATCH body and build a SPARSE update input — only fields the
 * request sent are included. Returns the first validation error, or the input.
 */
export function parseAmexLinePatch(body: AmexLinePatchBody): AmexLinePatchResult {
  const expenseCategoryCode =
    body.expenseCategoryCode === "" ? null : body.expenseCategoryCode;

  if (expenseCategoryCode && !isCanonicalCode(expenseCategoryCode)) {
    return { ok: false, error: `Invalid expense category code: ${expenseCategoryCode}` };
  }
  if (
    body.expenseCategory !== undefined &&
    !VALID_EXPENSE_CATEGORIES.includes(body.expenseCategory as AmexExpenseCategory)
  ) {
    return { ok: false, error: `Invalid expenseCategory: ${body.expenseCategory}` };
  }
  if (
    body.categoryStatus !== undefined &&
    !VALID_CATEGORY_STATUSES.includes(body.categoryStatus as AmexCategoryStatus)
  ) {
    return { ok: false, error: `Invalid categoryStatus: ${body.categoryStatus}` };
  }
  if (
    body.receiptStatus !== undefined &&
    !VALID_RECEIPT_STATUSES.includes(body.receiptStatus as AmexReceiptStatus)
  ) {
    return { ok: false, error: `Invalid receiptStatus: ${body.receiptStatus}` };
  }
  if (
    body.businessTripStatus !== undefined &&
    !VALID_BUSINESS_TRIP_STATUSES.includes(
      body.businessTripStatus as AmexBusinessTripStatus,
    )
  ) {
    return { ok: false, error: `Invalid businessTripStatus: ${body.businessTripStatus}` };
  }
  if (
    body.receiptMissingReason !== undefined &&
    body.receiptMissingReason !== null &&
    typeof body.receiptMissingReason !== "string"
  ) {
    return { ok: false, error: "receiptMissingReason must be a string or null." };
  }

  const receiptMissingReason =
    typeof body.receiptMissingReason === "string"
      ? body.receiptMissingReason.trim().slice(0, 500) || null
      : body.receiptMissingReason;

  // Sparse: only include a key when present in the body. The DB layer uses
  // `"key" in input` for the nullable fields so an explicit null clears the
  // column — an always-present key with undefined would NULL siblings (#67).
  const input: AmexLinePatchInput = {};
  if (body.expenseCategory !== undefined) {
    input.expenseCategory = body.expenseCategory as AmexExpenseCategory;
  }
  if ("expenseCategoryCode" in body) {
    input.expenseCategoryCode = expenseCategoryCode ?? null;
  }
  if (body.categoryStatus !== undefined) {
    input.categoryStatus = body.categoryStatus as AmexCategoryStatus;
  }
  if (body.receiptStatus !== undefined) {
    input.receiptStatus = body.receiptStatus as AmexReceiptStatus;
  }
  if ("receiptMissingReason" in body) {
    input.receiptMissingReason = receiptMissingReason ?? null;
  }
  if (body.businessTripStatus !== undefined) {
    input.businessTripStatus = body.businessTripStatus as AmexBusinessTripStatus;
  }
  return { ok: true, input };
}
