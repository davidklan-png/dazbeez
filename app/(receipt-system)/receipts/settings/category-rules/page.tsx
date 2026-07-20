import type { Metadata } from "next";
import { getReceiptsPageActor } from "@/lib/receipts/auth-request";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import {
  listCategoryRules,
  listDismissals,
  listCategorizedReceiptsForProposals,
  computeCategoryProposals,
} from "@/lib/receipts/category-rules";
import { CategoryRulesList } from "@/components/receipts/category-rules-list";

export const metadata: Metadata = {
  title: "Category rules — Receipts",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

// Category pattern rules: the system proposes a rule when ≥3 receipts from the
// same sender/merchant share a category; the operator accepts/dismisses here.
// Accepted rules surface a SUGGESTION (never an auto-set) on future receipts —
// see form-pane.tsx. Nothing is auto-categorized.
export default async function CategoryRulesPage() {
  await getReceiptsPageActor(); // Clerk access gate
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

  return (
    <div className="space-y-6 px-8 py-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-600">
          Settings
        </p>
        <h1 className="mt-2 text-[26px] font-bold text-gray-900">Category rules</h1>
        <p className="mt-1 text-sm text-gray-600">
          When receipts from the same sender or merchant keep getting the same
          category, accept it as a rule. Future matching receipts get a
          pre-filled suggestion you still have to click to apply — nothing is
          auto-categorized.
        </p>
      </div>
      <CategoryRulesList initial={{ rules, proposals }} />
    </div>
  );
}
