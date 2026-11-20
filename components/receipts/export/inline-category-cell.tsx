"use client";

// Inline category display + edit cell for the pre-finalize review page.
//
// One cell per row (side-by-side AMEX lines AND additional-charge cash/digital
// receipts). Shows the RESOLVED category (resolveLineCategory, computed server-
// side in the bundle) as JP name + EN gloss with a source-of-truth badge, and
// offers a dropdown when editable. Edits route by source of truth:
//   - matched AMEX line / cash-digital receipt → PATCH /api/receipts/[id]
//   - no-receipt / unmatched AMEX line        → PATCH /api/receipts/amex/lines/[id]
// A line-level category is NEVER written onto a matched line (the receipt
// shadows it and the manifest would desync) — the server passes the route, the
// cell just PATCHes it. Locks are also decided server-side (export sealed /
// reconciliation sealed) and passed as `editable` + `disabledReason`; the cell
// never offers an edit the API would reject.

import { SaveQueue } from "@/lib/receipts/save-queue";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pill } from "@/components/ui/pill";
import {
  EXPENSE_CATEGORIES,
  formatCategoryLabel,
  requiresAttendees,
} from "@/lib/receipts/categories";
import type { InlineCategoryCellProps } from "@/lib/receipts/category-cell";
import { buildCategoryPatchBody } from "@/lib/receipts/category-cell";

export type { InlineCategoryCellProps };

export function InlineCategoryCell(props: InlineCategoryCellProps) {
  // Route identity owns both the draft and queue; revision refreshes must not bless an old draft.
  const target = props.route ? `${props.route.kind}:${props.route.id}` : "none";
  return <CategoryEditor key={target} {...props} />;
}

function CategoryEditor(props: InlineCategoryCellProps) {
  const router = useRouter();
  const [value, setValue] = useState(props.code ?? "");
  const [trackedCode, setTrackedCode] = useState(props.code ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [queue] = useState(() => props.route ? new SaveQueue({
    url: props.route.kind === "receipt" ? `/api/receipts/${props.route.id}` : `/api/receipts/amex/lines/${props.route.id}`,
    initialRevision: props.route.revision!,
    entity: props.route.kind === "line" ? "AMEX line" : undefined,
    buildBody: () => ({}),
  }) : null);

  useEffect(() => {
    if (!queue || (status !== "saving" && status !== "error")) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [queue, status]);

  // Follow server-resolved code changes after a router.refresh() (our own save,
  // or another tab's edit) — but never clobber an in-flight optimistic value.
  // Adjusting state during render with a prop-change guard is the React-
  // recommended way to sync to a prop without a setState-in-effect.
  if ((props.code ?? "") !== trackedCode) {
    setTrackedCode(props.code ?? "");
    if (status === "idle") setValue(props.code ?? "");
  }

  const needsAttendees = requiresAttendees(value);

  async function handleChange(next: string) {
    if (!props.editable || !props.route || status === "saving" || queue?.halted) return;
    if (next === value) return;
    setValue(next);
    setStatus("saving");
    setErrorMsg(null);
    try {
      if (!queue || props.route.revision === undefined) throw new Error("Reload to review before saving.");
      await queue.mutate("PATCH", buildCategoryPatchBody(next));
      if (!mounted.current) return;
      setStatus("idle");
      router.refresh();
    } catch (error) {
      if (!mounted.current) return;
      setStatus("error");
      setErrorMsg(error instanceof Error ? error.message : "Category save failed.");
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span
          className={
            "shrink-0 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide " +
            (props.sourceLabel === "from receipt"
              ? "bg-green-50 text-green-700"
              : "bg-gray-100 text-gray-600")
          }
          title={
            props.sourceLabel === "from receipt"
              ? "Category resolves from the matched receipt (authoritative)."
              : "Category is set on the AMEX line (no matched receipt)."
          }
        >
          {props.sourceLabel === "from receipt" ? "receipt" : "line"}
        </span>
        {props.editable ? (
          <select
            value={value}
            onChange={(e) => handleChange(e.target.value)}
            disabled={status === "saving" || queue?.halted}
            className="h-[26px] min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-1.5 text-[11.5px] text-gray-900 focus:border-amber-500 focus:outline-none disabled:bg-gray-50"
          >
            <option value="">— Select —</option>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c.code} value={c.code}>
                {formatCategoryLabel(c.code)}
              </option>
            ))}
          </select>
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-[11.5px] text-gray-700"
            title={props.disabledReason ?? undefined}
          >
            {props.code ? (
              `${props.categoryJa ?? ""} — ${props.categoryEn ?? props.code}`.trim()
            ) : (
              <span className="italic text-gray-400">uncategorized</span>
            )}
          </span>
        )}
        {status === "saving" && (
          <span className="shrink-0 text-[9.5px] text-gray-400">saving…</span>
        )}
      </div>

      {/* Uncategorized nudge — only when the operator can actually act. When a
       *  category-rule suggestion exists, offer a one-click Accept that PATCHes
       *  via the SAME handleChange path as a manual dropdown pick (never a
       *  pre-selected dropdown — autosave/optimistic-commit risk). */}
      {props.editable && !value ? (
        props.suggestedCategoryCode ? (
          <button
            type="button"
            onClick={() => handleChange(props.suggestedCategoryCode!)}
            disabled={status === "saving" || queue?.halted}
            className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            <span>Suggested: {formatCategoryLabel(props.suggestedCategoryCode!)}</span>
            <span className="underline">Accept</span>
          </button>
        ) : (
          <Pill tone="amber" size="sm">
            category needed
          </Pill>
        )
      ) : null}

      {/* Attendees-required inline warning. Non-blocking: the finalize gate is
       *  the enforcement point. Shown for any row whose current category
       *  requires attendees but has none recorded. */}
      {needsAttendees && !props.hasAttendees && (
        <span className="text-[10px] text-amber-700">
          {props.categoryEn ?? "This category"} requires attendees — record them on the receipt before finalizing.
        </span>
      )}

      {/* Standard error surfacing (PR #83/#93 convention), per row. */}
      {status === "error" && errorMsg && (
        <div className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[10px] text-red-700">
          {errorMsg}
          {queue?.halted && <button type="button" className="ml-2 underline" onClick={() => {
            if (window.confirm("Discard this category selection and reload for review?")) window.location.reload();
          }}>Reload and review</button>}
        </div>
      )}
    </div>
  );
}
