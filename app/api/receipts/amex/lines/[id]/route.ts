import { NextResponse } from "next/server";
import { assertReceiptsAccessFromHeaders, getReceiptsActor } from "@/lib/receipts/auth";
import { updateAmexLineCategory } from "@/lib/receipts/db";
import { isCanonicalCode } from "@/lib/receipts/categories";
import type {
  AmexCategoryStatus,
  AmexExpenseCategory,
  AmexReceiptStatus,
  AmexBusinessTripStatus,
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

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    await assertReceiptsAccessFromHeaders(request.headers);
    const actor = await getReceiptsActor(request.headers);
    const { id } = await params;

    const body = (await request.json()) as {
      expenseCategory?: string;
      expenseCategoryCode?: string;
      categoryStatus?: string;
      receiptStatus?: string;
      receiptMissingReason?: string | null;
      businessTripStatus?: string;
    };

    // Validate canonical category code if provided
    if (body.expenseCategoryCode && !isCanonicalCode(body.expenseCategoryCode)) {
      return NextResponse.json(
        { error: `Invalid expense category code: ${body.expenseCategoryCode}` },
        { status: 400 },
      );
    }

    // Validate each enum field if provided — previously these were cast
    // straight from arbitrary string body input into typed enums and
    // forwarded to the DB, where invalid values could silently land.
    if (
      body.expenseCategory !== undefined &&
      !VALID_EXPENSE_CATEGORIES.includes(body.expenseCategory as AmexExpenseCategory)
    ) {
      return NextResponse.json(
        { error: `Invalid expenseCategory: ${body.expenseCategory}` },
        { status: 400 },
      );
    }
    if (
      body.categoryStatus !== undefined &&
      !VALID_CATEGORY_STATUSES.includes(body.categoryStatus as AmexCategoryStatus)
    ) {
      return NextResponse.json(
        { error: `Invalid categoryStatus: ${body.categoryStatus}` },
        { status: 400 },
      );
    }
    if (
      body.receiptStatus !== undefined &&
      !VALID_RECEIPT_STATUSES.includes(body.receiptStatus as AmexReceiptStatus)
    ) {
      return NextResponse.json(
        { error: `Invalid receiptStatus: ${body.receiptStatus}` },
        { status: 400 },
      );
    }
    if (
      body.businessTripStatus !== undefined &&
      !VALID_BUSINESS_TRIP_STATUSES.includes(
        body.businessTripStatus as AmexBusinessTripStatus,
      )
    ) {
      return NextResponse.json(
        { error: `Invalid businessTripStatus: ${body.businessTripStatus}` },
        { status: 400 },
      );
    }

    await updateAmexLineCategory(
      id,
      {
        expenseCategory: body.expenseCategory as AmexExpenseCategory | undefined,
        expenseCategoryCode: body.expenseCategoryCode ?? undefined,
        categoryStatus: body.categoryStatus as AmexCategoryStatus | undefined,
        receiptStatus: body.receiptStatus as AmexReceiptStatus | undefined,
        receiptMissingReason: body.receiptMissingReason,
        businessTripStatus: body.businessTripStatus as AmexBusinessTripStatus | undefined,
      },
      actor,
    );

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/amex/lines/[id]] PATCH failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Update failed." },
      { status: 500 },
    );
  }
}
