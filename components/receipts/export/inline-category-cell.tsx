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

import { useRef, useState } from "react";
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
  const router = useRouter();
  const [value, setValue] = useState(props.code ?? "");
  const [trackedCode, setTrackedCode] = useState(props.code ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  // Follow server-resolved code changes after a router.refresh() (our own save,
  // or another tab's edit) — but never clobber an in-flight optimistic value.
  // Adjusting state during render with a prop-change guard is the React-
  // recommended way to sync to a prop without a setState-in-effect.
  if (props.code !== trackedCode) {
    setTrackedCode(props.code ?? "");
    if (status !== "saving") setValue(props.code ?? "");
  }

  const needsAttendees = requiresAttendees(value);

  async function handleChange(next: string) {
    if (!props.editable || !props.route) return;
    if (next === value) return;
    const prev = value;
    setValue(next); // optimistic
    setStatus("saving");
    setErrorMsg(null);
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    const url =
      props.route.kind === "receipt"
        ? `/api/receipts/${props.route.id}`
        : `/api/receipts/amex/lines/${props.route.id}`;
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCategoryPatchBody(next)),
        signal: ctrl.signal,
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setValue(prev); // roll back the optimistic change, visibly
        setStatus("error");
        setErrorMsg(json.error ?? "Category save failed.");
        return;
      }
      setStatus("idle");
      // Refresh so gates / tiles / blocker counts / the resolved category all
      // re-render from the new DB state.
      router.refresh();
    } catch (err) {
      if ((err as DOMException | undefined)?.name === "AbortError") return;
      setValue(prev);
      setStatus("error");
      setErrorMsg("Network error — category not saved.");
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
            disabled={status === "saving"}
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

      {/* Uncategorized nudge — only when the operator can actually act. */}
      {props.editable && !value && (
        <Pill tone="amber" size="sm">
          category needed
        </Pill>
      )}

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
        </div>
      )}
    </div>
  );
}
