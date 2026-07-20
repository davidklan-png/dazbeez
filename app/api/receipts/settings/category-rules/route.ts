import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { isCanonicalCode, type ExpenseCategoryCode } from "@/lib/receipts/categories";
import {
  listCategoryRules,
  addCategoryRule,
  removeCategoryRule,
  listDismissals,
  addDismissal,
  listCategorizedReceiptsForProposals,
  computeCategoryProposals,
  type CategoryMatchType,
} from "@/lib/receipts/category-rules";

// Settings backing for category pattern rules. Clerk-only (human-facing Settings
// page; the Mac consumer never calls this). After every mutation we return the
// fresh { rules, proposals } snapshot so the client re-renders from truth.

function isMatchType(v: unknown): v is CategoryMatchType {
  return v === "sender" || v === "merchant";
}

async function snapshot() {
  const db = getReceiptsDb();
  const [rules, receipts, dismissals] = await Promise.all([
    listCategoryRules(db),
    listCategorizedReceiptsForProposals(db),
    listDismissals(db),
  ]);
  const proposals = computeCategoryProposals(
    receipts,
    rules.map((r) => ({
      matchType: r.match_type,
      matchValue: r.match_value,
      expenseCategoryCode: r.expense_category_code,
    })),
    dismissals.map((d) => ({
      matchType: d.match_type,
      matchValue: d.match_value,
      expenseCategoryCode: d.expense_category_code,
    })),
  );
  return { rules, proposals };
}

export async function GET(request: Request) {
  try {
    await requireReceiptsActor(request.headers);
    return NextResponse.json(await snapshot(), { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/settings/category-rules] GET failed", error);
    return NextResponse.json({ error: "Failed to load category rules." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = new URL(request.url).searchParams.get("action");

    const matchType = body.matchType;
    const matchValue = typeof body.matchValue === "string" ? body.matchValue.trim() : "";
    const code = typeof body.expenseCategoryCode === "string" ? body.expenseCategoryCode : "";

    if (!isMatchType(matchType) || !matchValue || !isCanonicalCode(code)) {
      return NextResponse.json(
        {
          error:
            "matchType (sender|merchant), a non-empty matchValue, and a valid expenseCategoryCode are required.",
        },
        { status: 400 },
      );
    }

    const db = getReceiptsDb();
    if (action === "dismiss") {
      await addDismissal(db, { matchType, matchValue, expenseCategoryCode: code }, actor);
    } else {
      const sourceReceiptIds = Array.isArray(body.sourceReceiptIds)
        ? body.sourceReceiptIds.filter((s): s is string => typeof s === "string")
        : undefined;
      await addCategoryRule(
        db,
        {
          matchType,
          matchValue,
          expenseCategoryCode: code as ExpenseCategoryCode,
          sourceReceiptIds,
        },
        actor,
      );
    }
    return NextResponse.json(await snapshot(), { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/settings/category-rules] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Save failed." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const body = (await request.json().catch(() => ({}))) as { id?: unknown };
    const id =
      typeof body.id === "string" ? body.id : new URL(request.url).searchParams.get("id") ?? "";
    if (!id) {
      return NextResponse.json({ error: "id is required." }, { status: 400 });
    }
    await removeCategoryRule(getReceiptsDb(), id, actor);
    return NextResponse.json(await snapshot(), { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/settings/category-rules] DELETE failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Delete failed." },
      { status: 500 },
    );
  }
}
