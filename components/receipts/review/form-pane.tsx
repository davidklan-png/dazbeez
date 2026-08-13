"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Btn } from "@/components/ui/btn";
import { Pill } from "@/components/ui/pill";
import { Field, TextInput } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import { ArrowRightIcon } from "@/components/ui/icons";
import { FormGroup } from "@/components/receipts/ui/form-group";
import { PaymentPathSeg } from "@/components/receipts/ui/payment-path-seg";
import { AttendeeEditor } from "@/components/receipts/attendee-editor";
import {
  useQueueControls,
  useQueuePosition,
} from "@/components/receipts/review/queue-controls";
import { useKeyboardShortcuts } from "@/lib/receipts/keyboard";
import { isPendingProcessing } from "@/lib/receipts/extraction-state";
import type { ReceiptLockInfo } from "@/lib/receipts/receipt-locks";
import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";
import {
  EXPENSE_CATEGORIES,
  getCategoryByCode,
  requiresAttendees as categoryRequiresAttendees,
  formatCategoryLabel,
} from "@/lib/receipts/categories";
import { findCategorySuggestion, type CategoryRule } from "@/lib/receipts/category-rules";
import {
  canMarkReviewed,
  canPromoteToReviewed,
} from "@/lib/receipts/receipt-status-policy";
import { resolveWorkMonth, withWorkMonth } from "@/lib/receipts/work-month";
import { formatReviewMonthLabel } from "@/lib/receipts/review-queue-filter";
import type {
  PaymentPath,
  ReceiptAttendee,
  ReceiptRecord,
  ReceiptStatus,
} from "@/lib/receipts/types";
import { SaveBadge, type SaveState } from "./save-badge";
import { useExtraction } from "./use-extraction";

const SAVE_DEBOUNCE_MS = 450;

export interface FormPaneProps {
  receipt: ReceiptRecord;
  initialAttendees: ReceiptAttendee[];
  queueIndex: number | null; // 1-based for "3 of 23"; null when not in the working set
  queueTotal: number;
  /** "View in <its month>" target when the receipt is out of the working set
   *  because its transaction_date is in a different month (backlog #17). */
  switchToMonth?: string | null;
  nextReceiptId: string | null;
  prevReceiptId: string | null;
  hasAmexMatch: boolean;
  reReviewNeeded: boolean;
  /** ADR 0006 §D6: open statement months (valid override targets). */
  overrideTargetMonths: string[];
  /** The receipt's natural cycle month (label only). */
  naturalStatementMonth: string | null;
  /** Split-lock surface (receipt-locks.ts). When locked, the form renders a
   *  banner and disables every mutating control so the operator never types
   *  into a sealed receipt and discovers the 409 at save. Defaults to unlocked
   *  so callers that don't pass it behave as before. */
  lock?: ReceiptLockInfo;
  /** Active category pattern rules (ADR: category-rules). When the receipt has
   *  no category, a matching rule surfaces a SUGGESTION affordance — never a
   *  pre-selected dropdown. Optional: callers that don't pass it get no
   *  suggestions (behaves as before). */
  categoryRules?: CategoryRule[];
}

export function FormPane(props: FormPaneProps) {
  const router = useRouter();
  const { receipt } = props;

  // Split-lock: when sealed by a finalized export or reconciliation the entire
  // form is read-only (banner + every mutating control disabled, autosave and
  // the `s` shortcut suppressed). The server 409 path stays the backstop.
  const isLocked = props.lock?.locked ?? false;
  const lockKind = props.lock?.kind ?? null;
  const lockMonth = props.lock?.month ?? null;

  // Position in the client-sorted + searched queue (hybrid model: month/lock
  // chosen server-side, sort/search client-side). Falls back to the
  // server-computed values when the receipt is filtered out of `visible`
  // (e.g. the active receipt doesn't match the current text search).
  const { queryParams } = useQueueControls();
  // Concrete work month derived from the queue's preserved query string — used
  // ONLY to carry the month into Reconcile/Export from the locked banner, never
  // the review scope/filter (those stay within review via `queryParams`).
  const workMonth = useMemo(
    () => resolveWorkMonth(new URLSearchParams(queryParams).get("month")),
    [queryParams],
  );
  const queuePos = useQueuePosition(receipt.id);
  const queueIndex = queuePos.index >= 0 ? queuePos.index : props.queueIndex;
  const queueTotal = queuePos.index >= 0 ? queuePos.total : props.queueTotal;
  const nextReceiptId = queuePos.index >= 0 ? queuePos.nextId : props.nextReceiptId;
  // null when the receipt is outside the working set (queuePos missed it AND the
  // server passed null — backlog #17: an undated capture that extracted into a
  // prior month). Render "not in this view" and disable save-and-advance + Skip
  // rather than fabricating a position / navigating to queueItems[0].
  const inView = queueIndex !== null;

  // OCR runs on the Mac processor, not here. While the receipt is still pending
  // there is no stored OCR text, so the reprocess button (which only re-parses
  // stored text — it does NOT run OCR) can do nothing. Disable + relabel it so
  // it stops promising an action it can't perform (ADR 0001).
  const pendingProcessing = isPendingProcessing(receipt);

  // Audit finding B5: surface structured-parse failures stored on the
  // receipt's extraction_json. Without this the operator can't tell
  // "model emitted nothing parseable" from "receipt genuinely has no
  // structured data".
  const structuredParseFailed = (() => {
    if (!receipt.extraction_json) return false;
    try {
      const parsed = JSON.parse(receipt.extraction_json) as {
        structuredParseFailed?: boolean;
      };
      return parsed.structuredParseFailed === true;
    } catch {
      return false;
    }
  })();

  // ─── form state ─────────────────────────────────────────────────────
  const [paymentPath, setPaymentPath] = useState<PaymentPath>(receipt.payment_path);
  const [expenseCategoryCode, setExpenseCategoryCode] = useState(
    receipt.expense_category_code ?? "",
  );
  const [transactionDate, setTransactionDate] = useState(
    receipt.transaction_date ?? "",
  );
  const [merchant, setMerchant] = useState(receipt.merchant ?? "");
  const [amountDisplay, setAmountDisplay] = useState(
    formatAmountInput(receipt.amount_minor, receipt.currency),
  );
  const [currency, setCurrency] = useState(receipt.currency || "JPY");
  const [businessPurpose, setBusinessPurpose] = useState(
    receipt.business_purpose ?? "",
  );
  const [attendees, setAttendees] = useState<string[]>(
    props.initialAttendees.map((a) => a.attendee_name),
  );
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  // Audit B4: post-save warnings from the API (e.g. compliance recompute
  // failed). Save succeeded, so this is a toast — not an error state.
  const [apiWarnings, setApiWarnings] = useState<string[]>([]);
  const [overrideBusy, setOverrideBusy] = useState(false);

  // Attendee directory (migration 0022): loaded client-side from D1 on mount
  // and passed to AttendeeEditor. The editor lets the operator register a new
  // attendee inline (company/title); a freshly-registered entry is merged into
  // this list so it resolves for the rest of the session without a reload.
  const [directory, setDirectory] = useState<ReceiptAttendeeDirectoryEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/receipts/attendee-directory");
        if (!res.ok) return;
        const json = (await res.json().catch(() => ({}))) as {
          entries?: ReceiptAttendeeDirectoryEntry[];
        };
        if (!cancelled && Array.isArray(json.entries)) {
          setDirectory(json.entries);
        }
      } catch {
        // Non-fatal: the editor still works as free-text without the datalist.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── OCR extraction (delegated to the useExtraction hook) ───────────
  const {
    busy: extractionBusy,
    feedback: extractionFeedback,
    run: handleExtract,
  } = useExtraction(receipt.id, (ex) => {
    let filled = 0;
    if (ex.transactionDate && !transactionDate) {
      setTransactionDate(ex.transactionDate);
      filled++;
    }
    if (ex.merchant && !merchant) {
      setMerchant(ex.merchant);
      filled++;
    }
    if (ex.currency && ex.currency !== currency && currency === "JPY") {
      setCurrency(ex.currency);
      filled++;
    }
    if (ex.amountMinor != null && !amountDisplay) {
      setAmountDisplay(formatAmountInput(ex.amountMinor, ex.currency ?? currency));
      filled++;
    }
    if (ex.businessPurpose && !businessPurpose) {
      setBusinessPurpose(ex.businessPurpose);
      filled++;
    }
    return filled;
  });

  const needsAttendees = categoryRequiresAttendees(expenseCategoryCode);
  const category = getCategoryByCode(expenseCategoryCode);

  // Category pattern rule suggestion (ADR: category-rules). Only when no
  // category is set yet, and only matching against the receipt's identity:
  // email-source receipts match sender rules (captured_by = sender address);
  // everything else matches merchant rules only (captured_by is the operator,
  // not a sender, so it's excluded). NEVER a pre-selected dropdown — the
  // Accept button below calls the same setExpenseCategoryCode the manual
  // <select> uses, so the autosave PATCH is byte-identical to a human pick.
  const categorySuggestion =
    !expenseCategoryCode && (props.categoryRules?.length ?? 0) > 0
      ? findCategorySuggestion(
          {
            merchant: props.receipt.merchant,
            fromAddress:
              props.receipt.source_type === "email_attachment" ||
              props.receipt.source_type === "email_body"
                ? props.receipt.captured_by
                : null,
          },
          props.categoryRules ?? [],
        )
      : null;

  // ─── refs for keyboard focus ────────────────────────────────────────
  const categoryRef = useRef<HTMLSelectElement | null>(null);
  const attendeeAddRef = useRef<HTMLDivElement | null>(null);

  // ─── autosave (debounced PATCH) ─────────────────────────────────────
  const initialRenderRef = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);

  const triggerSave = useCallback(
    (markReviewed: boolean) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        inFlightRef.current?.abort();
        const ctrl = new AbortController();
        inFlightRef.current = ctrl;
        setSave({ kind: "saving" });

        let amountMinor: number | null = null;
        if (amountDisplay.trim()) {
          const parsed = parseFloat(amountDisplay.replace(/[^0-9.]/g, ""));
          if (!isNaN(parsed)) {
            amountMinor =
              currency === "JPY" ? Math.round(parsed) : Math.round(parsed * 100);
          }
        }

        try {
          const res = await fetch(`/api/receipts/${receipt.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              paymentPath,
              expenseCategoryCode: expenseCategoryCode || null,
              transactionDate: transactionDate || null,
              merchant: merchant.trim() || null,
              amountMinor,
              currency,
              businessPurpose: businessPurpose.trim() || null,
              attendees: attendees.map((a) => a.trim()).filter(Boolean),
              // Audit 2026-07-21 Phase 1: ordinary autosaves NEVER send status —
              // a stale client value must not be able to overwrite a lifecycle
              // status an internal flow (reconcile/export) has since advanced.
              // "reviewed" is sent only by the explicit Mark-reviewed path below,
              // and only when the receipt is still in a pre-review state.
              ...(markReviewed && canPromoteToReviewed(receipt.status)
                ? { status: "reviewed" as ReceiptStatus }
                : {}),
            }),
            signal: ctrl.signal,
          });
          const json = (await res.json().catch(() => ({}))) as {
            error?: string;
            warnings?: string[];
          };
          if (!res.ok) {
            setSave({
              kind: "error",
              message: json.error ?? "Save failed",
            });
            return;
          }
          setApiWarnings(json.warnings ?? []);
          setSave({ kind: "saved", at: Date.now() });
          // Do not refresh the route after ordinary field autosaves. A refresh
          // can interrupt an active WebKit IME conversion and steal focus from
          // any text field; the local form state is already authoritative for
          // the editor. Explicit actions and navigation still refresh normally.
        } catch (error) {
          if ((error as DOMException | undefined)?.name === "AbortError") return;
          setSave({ kind: "error", message: "Network error" });
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [
      receipt.id,
      receipt.status,
      paymentPath,
      expenseCategoryCode,
      transactionDate,
      merchant,
      amountDisplay,
      currency,
      businessPurpose,
      attendees,
    ],
  );

  // ADR 0006 §D6: discretionary export_statement_month override. Explicit (not
  // autosaved) — a confirm states the consequence, then a dedicated PATCH. The
  // server guards the target month is export-open (two-lock model).
  async function handleOverride(target: string) {
    const current = receipt.export_statement_month ?? null;
    if (!target || target === current) return;
    const ok = window.confirm(
      `Reassign this receipt's statement month to ${target}?\n\n` +
        `It will ship in ${target}'s export${current ? ` instead of ${current}` : ""}. This change is audited.`,
    );
    if (!ok) return;
    setOverrideBusy(true);
    try {
      const res = await fetch(`/api/receipts/${receipt.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exportStatementMonth: target }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setSave({ kind: "error", message: json.error ?? "Override failed" });
        return;
      }
      router.refresh();
    } catch {
      setSave({ kind: "error", message: "Network error" });
    } finally {
      setOverrideBusy(false);
    }
  }

  useEffect(() => {
    if (initialRenderRef.current) {
      initialRenderRef.current = false;
      return;
    }
    // Sealed receipt: never fire the autosave debounce. The fields are disabled
    // so they can't change, but this guards against programmatic state changes
    // and is the explicit "suppress entirely" the lock requires.
    if (isLocked) return;
    triggerSave(false);
  }, [
    paymentPath,
    expenseCategoryCode,
    transactionDate,
    merchant,
    amountDisplay,
    currency,
    businessPurpose,
    attendees,
    isLocked,
    triggerSave,
  ]);

  // ─── keyboard shortcuts ─────────────────────────────────────────────
  const onMarkReviewed = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    // Trigger an immediate save with reviewed status, then navigate
    void (async () => {
      setSave({ kind: "saving" });
      try {
        let amountMinor: number | null = null;
        if (amountDisplay.trim()) {
          const parsed = parseFloat(amountDisplay.replace(/[^0-9.]/g, ""));
          if (!isNaN(parsed))
            amountMinor =
              currency === "JPY"
                ? Math.round(parsed)
                : Math.round(parsed * 100);
        }
        const res = await fetch(`/api/receipts/${receipt.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paymentPath,
            expenseCategoryCode: expenseCategoryCode || null,
            transactionDate: transactionDate || null,
            merchant: merchant.trim() || null,
            amountMinor,
            currency,
            businessPurpose: businessPurpose.trim() || null,
            attendees: attendees.map((a) => a.trim()).filter(Boolean),
            // Promote to reviewed only when still in a pre-review state. For an
            // already-reviewed/reconciled/exported/archived receipt the server
            // would reject the downgrade; we simply don't send it. Fields still
            // save and the operator advances to the next queue item.
            ...(canPromoteToReviewed(receipt.status)
              ? { status: "reviewed" as ReceiptStatus }
              : {}),
          }),
        });
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setSave({ kind: "error", message: json.error ?? "Save failed" });
          return;
        }
        const okJson = (await res.json().catch(() => ({}))) as {
          warnings?: string[];
        };
        setApiWarnings(okJson.warnings ?? []);
        setSave({ kind: "saved", at: Date.now() });
        if (nextReceiptId) {
          router.push(`/receipts/review/${nextReceiptId}${queryParams}`);
        } else {
          router.push(`/receipts/review${queryParams}`);
        }
      } catch {
        setSave({ kind: "error", message: "Network error" });
      }
    })();
  }, [
    receipt.id,
    receipt.status,
    paymentPath,
    expenseCategoryCode,
    transactionDate,
    merchant,
    amountDisplay,
    currency,
    businessPurpose,
    attendees,
    nextReceiptId,
    queryParams,
    router,
  ]);

  useKeyboardShortcuts({
    s: (e) => {
      // Same shared gate as the button (canMarkReviewed): a reconciled/reviewed/
      // exported/archived receipt must not save-and-advance through a shortcut
      // presented as "Mark reviewed" (architect review 2026-07-21).
      if (!canMarkReviewed(receipt.status, isLocked) || !inView) return;
      e.preventDefault();
      onMarkReviewed();
    },
    c: (e) => {
      if (isLocked) return;
      e.preventDefault();
      categoryRef.current?.focus();
    },
    a: (e) => {
      if (isLocked) return;
      e.preventDefault();
      const input = attendeeAddRef.current?.querySelector("input");
      if (input instanceof HTMLInputElement) input.focus();
    },
  });

  async function handleDelete() {
    if (!window.confirm(`Soft-delete receipt ${receipt.id.slice(0, 8)}…?`))
      return;
    try {
      const res = await fetch(`/api/receipts/${receipt.id}`, {
        method: "DELETE",
      });
      // Return to the SAME review view (month/scope/filter preserved), not the
      // bare queue — deleting one receipt shouldn't drop the operator out of
      // the work month they were in.
      if (res.ok) router.push(`/receipts/review${queryParams}`);
    } catch {
      // ignore
    }
  }

  const transactionLabel = useMemo(() => {
    const captured = receipt.captured_at ?? "";
    const date = receipt.transaction_date || captured.slice(0, 10);
    if (!date) return "—";
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) return date;
    return parsed.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }, [receipt.transaction_date, receipt.captured_at]);

  return (
    <div className="flex h-full flex-col overflow-auto bg-white">
      <header className="border-b border-gray-150 px-6 pb-3.5 pt-[18px]">
        <div className="flex items-center gap-2.5">
          <h1 className="text-lg font-bold text-gray-900">
            {merchant.trim() || "Unnamed receipt"}
          </h1>
          {props.hasAmexMatch && (
            <Pill tone="green" size="sm" dot>
              Auto-matched to AMEX
            </Pill>
          )}
          {props.reReviewNeeded && (
            <Pill tone="amber" size="sm" dot>
              Re-review needed
            </Pill>
          )}
          <span className="flex-1" />
          <SaveBadge state={save} />
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-xs text-gray-500">
          <span className="tabular-nums">
            {amountDisplay
              ? `${currency === "JPY" ? "¥" : currency + " "}${amountDisplay}`
              : "—"}
          </span>
          <span>·</span>
          <span>{transactionLabel}</span>
          <span>·</span>
          <span>
            {queueIndex !== null ? `${queueIndex} of ${queueTotal}` : "not in this view"}
          </span>
          {!inView && props.switchToMonth && (
            <Link
              href={`/receipts/review/${receipt.id}?month=${props.switchToMonth}`}
              className="font-medium text-amber-600 underline-offset-2 hover:text-amber-700 hover:underline"
            >
              View in {formatReviewMonthLabel(props.switchToMonth)}
            </Link>
          )}
        </div>
      </header>

      {isLocked && (
        <div className="mx-6 mt-3 flex items-start gap-2 rounded-lg border border-gray-300 bg-gray-100 px-3 py-2 text-xs text-gray-700">
          <span className="mt-px font-semibold text-gray-700">Sealed.</span>
          <span>
            {lockKind === "reconciliation" ? (
              <>
                The {lockMonth} AMEX reconciliation is finalized. Reopen it — or
                open a correction export draft for {lockMonth} — to edit.{" "}
                <Link
                  href={withWorkMonth("/receipts/reconcile", workMonth)}
                  className="font-semibold text-gray-900 underline"
                >
                  Go to reconcile →
                </Link>
              </>
            ) : (
              <>
                The {lockMonth} export is finalized. Open a revision to edit.{" "}
                <Link
                  href={withWorkMonth("/receipts/export", workMonth)}
                  className="font-semibold text-gray-900 underline"
                >
                  Go to export →
                </Link>
              </>
            )}
          </span>
        </div>
      )}

      {apiWarnings.length > 0 && (
        <div
          role="status"
          className="mx-6 mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold">Saved with warnings</p>
              <ul className="mt-0.5 list-disc pl-5">
                {apiWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
            <button
              type="button"
              onClick={() => setApiWarnings([])}
              className="shrink-0 rounded px-1.5 py-0.5 text-amber-700 hover:bg-amber-100"
              aria-label="Dismiss warnings"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 px-6 pb-6 pt-1">
        <FormGroup
          step="1"
          title="Identification"
          subtitle="Verify OCR's read"
          done={Boolean(merchant && amountDisplay && transactionDate)}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Merchant">
              <TextInput
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
                disabled={isLocked}
              />
            </Field>
            <Field label="Date">
              <TextInput
                type="date"
                value={transactionDate}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setTransactionDate(e.target.value)}
                disabled={isLocked}
                mono
              />
            </Field>
            <Field label="Amount">
              <TextInput
                inputMode="decimal"
                value={amountDisplay}
                prefix={currency === "JPY" ? "¥" : currency}
                suffix={currency}
                onChange={(e) => setAmountDisplay(e.target.value)}
                disabled={isLocked}
                mono
              />
            </Field>
          </div>
          <div className="mt-3">
            <Btn
              kind="ghost"
              size="sm"
              onClick={handleExtract}
              disabled={isLocked || extractionBusy || pendingProcessing}
            >
              {pendingProcessing
                ? "Waiting for processor…"
                : extractionBusy
                  ? "Re-parsing…"
                  : "Re-parse OCR text"}
            </Btn>
            {pendingProcessing && !extractionFeedback && (
              <span className="ml-2 text-[11.5px] text-gray-500">
                OCR runs on the Mac processor — this receipt is still in the
                queue.
              </span>
            )}
            {extractionFeedback && (
              <span className="ml-2 text-[11.5px] text-gray-500">
                {extractionFeedback}
              </span>
            )}
            {structuredParseFailed && (
              <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                Structured parse failed — raw text available
              </span>
            )}
          </div>
        </FormGroup>

        <FormGroup
          step="2"
          title="Classification"
          subtitle="Payment path + category drive tax treatment"
          active={!expenseCategoryCode || paymentPath === "UNKNOWN"}
          done={Boolean(expenseCategoryCode) && paymentPath !== "UNKNOWN"}
        >
          <Field label="Payment path">
            <PaymentPathSeg
              value={paymentPath}
              onChange={setPaymentPath}
              disabled={isLocked}
            />
          </Field>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Category" hint={`${EXPENSE_CATEGORIES.length}-item JP catalog`}>
              <select
                ref={categoryRef}
                value={expenseCategoryCode}
                onChange={(e) => setExpenseCategoryCode(e.target.value)}
                disabled={isLocked}
                className="h-[38px] w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 focus:border-amber-500 focus:outline-none disabled:bg-gray-50 disabled:text-gray-500"
              >
                <option value="">— Select category —</option>
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {formatCategoryLabel(c.code)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tax rate">
              <TextInput value="10% (standard)" readOnly />
            </Field>
          </div>
          {!expenseCategoryCode && categorySuggestion && !isLocked ? (
            <button
              type="button"
              onClick={() => setExpenseCategoryCode(categorySuggestion.categoryCode)}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-800 transition-colors hover:bg-amber-100"
              title={`Matched ${categorySuggestion.rule.matchType} rule: ${categorySuggestion.rule.matchValue}`}
            >
              <span>Suggested: {formatCategoryLabel(categorySuggestion.categoryCode)}</span>
              <span className="font-semibold underline">Accept</span>
            </button>
          ) : null}
          {category && (
            <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-gray-50 px-3 py-2.5 text-[12px] text-gray-600">
              <span className="text-green-500">✓</span>
              <span>
                {needsAttendees
                  ? `${category.enName} requires attendees & business purpose.`
                  : `${category.enName} does not require attendees.`}
              </span>
            </div>
          )}
        </FormGroup>

        <FormGroup
          step="3"
          title="Documentation"
          subtitle={
            needsAttendees
              ? "Required for this category"
              : "Required only for entertainment & meeting categories"
          }
          optional={!needsAttendees}
          active={needsAttendees && attendees.filter(Boolean).length === 0}
        >
          <Field
            label="Business purpose"
            hint={needsAttendees ? "Required" : "Optional"}
          >
            <TextInput
              value={businessPurpose}
              onChange={(e) => setBusinessPurpose(e.target.value)}
              disabled={isLocked}
              placeholder="e.g. Client dinner — Acme product review"
            />
          </Field>
          <div className="mt-3" ref={attendeeAddRef}>
            <Field
              label="Attendees"
              hint={`${attendees.filter(Boolean).length} added`}
              required={needsAttendees}
            >
              <AttendeeEditor
                attendees={attendees}
                onChange={setAttendees}
                directory={directory}
                disabled={isLocked}
                onRegister={(entry) =>
                  setDirectory((prev) =>
                    prev.some((e) => e.id === entry.id) ? prev : [...prev, entry],
                  )
                }
              />
            </Field>
          </div>
        </FormGroup>

        {(paymentPath === "CASH" || paymentPath === "DIGITAL") && (
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
              Statement month
            </div>
            <p className="mt-1 text-[12px] text-gray-500">
              The export month this receipt ships in (ADR 0008). Natural month (calendar of its date):{" "}
              <span className="font-medium text-gray-700">
                {props.naturalStatementMonth ?? "— no date"}
              </span>
              . Override moves it to a different open month — audited, sealed months blocked.
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <select
                value={receipt.export_statement_month ?? ""}
                onChange={(e) => handleOverride(e.target.value)}
                disabled={isLocked || overrideBusy}
                className="h-[36px] rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 focus:border-amber-500 focus:outline-none disabled:bg-gray-50 disabled:text-gray-500"
              >
                <option value="">
                  {receipt.export_statement_month ?? "— unassigned —"}
                </option>
                {props.overrideTargetMonths
                  .filter((m) => m !== receipt.export_statement_month)
                  .map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
              </select>
              {overrideBusy && <span className="text-[12px] text-gray-400">Reassigning…</span>}
            </div>
          </div>
        )}

        <div className="mt-5 flex items-center gap-2.5 rounded-xl bg-gray-50 p-3.5">
          <Btn
            kind="primary"
            size="md"
            onClick={onMarkReviewed}
            disabled={!canMarkReviewed(receipt.status, isLocked) || !inView}
            rightIcon={<ArrowRightIcon size={14} className="text-white" />}
          >
            Mark reviewed → next
          </Btn>
          <span className="text-[11px] text-gray-400">
            <Kbd>s</Kbd>
          </span>
          {nextReceiptId && (
            <Btn
              kind="ghost"
              size="md"
              onClick={() =>
                router.push(`/receipts/review/${nextReceiptId}${queryParams}`)
              }
            >
              Skip
            </Btn>
          )}
          <span className="flex-1" />
          <Btn kind="danger" size="sm" onClick={handleDelete} disabled={isLocked}>
            Delete
          </Btn>
        </div>
      </div>
    </div>
  );
}

function formatAmountInput(amount: number | null, currency: string | null) {
  if (amount == null) return "";
  if (!currency || currency === "JPY") return String(amount);
  return (amount / 100).toFixed(2);
}
