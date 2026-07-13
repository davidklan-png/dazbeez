"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Btn } from "@/components/ui/btn";
import { Pill } from "@/components/ui/pill";
import { Field, SelectInput, TextInput } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import { ArrowRightIcon } from "@/components/ui/icons";
import { FormGroup } from "@/components/receipts/ui/form-group";
import { PaymentPathSeg } from "@/components/receipts/ui/payment-path-seg";
import { AttendeeEditor } from "@/components/receipts/attendee-editor";
import { useKeyboardShortcuts } from "@/lib/receipts/keyboard";
import { isPendingProcessing } from "@/lib/receipts/extraction-state";
import { RECEIPT_ATTENDEE_DIRECTORY } from "@/lib/receipts/attendee-directory";
import {
  EXPENSE_CATEGORIES,
  getCategoryByCode,
  requiresAttendees as categoryRequiresAttendees,
  formatCategoryLabel,
} from "@/lib/receipts/categories";
import type {
  ExpenseType,
  PaymentPath,
  ReceiptAttendee,
  ReceiptRecord,
  ReceiptStatus,
} from "@/lib/receipts/types";
import { SaveBadge, type SaveState } from "./save-badge";
import { useExtraction } from "./use-extraction";

const EXPENSE_TYPES: Array<{ value: ExpenseType; label: string }> = [
  { value: "UNKNOWN", label: "Unknown" },
  { value: "transportation", label: "Transportation" },
  { value: "travel", label: "Travel" },
  { value: "business_trip", label: "Business trip" },
  { value: "meeting-no-alcohol", label: "Meeting (no alcohol)" },
  { value: "entertainment-alcohol", label: "Entertainment (alcohol)" },
  { value: "office_supplies", label: "Office supplies" },
  { value: "telecom", label: "Telecom / Communications" },
  { value: "software", label: "Software" },
  { value: "books", label: "Books / research" },
  { value: "research", label: "Research" },
  { value: "insurance", label: "Insurance" },
  { value: "misc", label: "Miscellaneous" },
];

const SAVE_DEBOUNCE_MS = 450;

export interface FormPaneProps {
  receipt: ReceiptRecord;
  initialAttendees: ReceiptAttendee[];
  queueIndex: number; // 1-based for "3 of 23"
  queueTotal: number;
  nextReceiptId: string | null;
  prevReceiptId: string | null;
  hasAmexMatch: boolean;
  reReviewNeeded: boolean;
  /** ADR 0006 §D6: open statement months (valid override targets). */
  overrideTargetMonths: string[];
  /** The receipt's natural cycle month (label only). */
  naturalStatementMonth: string | null;
}

export function FormPane(props: FormPaneProps) {
  const router = useRouter();
  const { receipt } = props;

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
  const [expenseType, setExpenseType] = useState<ExpenseType>(receipt.expense_type);
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
    if (ex.expenseType && ex.expenseType !== "UNKNOWN" && expenseType === "UNKNOWN") {
      setExpenseType(ex.expenseType);
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
              expenseType,
              expenseCategoryCode: expenseCategoryCode || null,
              transactionDate: transactionDate || null,
              merchant: merchant.trim() || null,
              amountMinor,
              currency,
              businessPurpose: businessPurpose.trim() || null,
              attendees: attendees.map((a) => a.trim()).filter(Boolean),
              status: (markReviewed
                ? "reviewed"
                : receipt.status) as ReceiptStatus,
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
          // Refresh server-rendered CompliancePanel without manual reload.
          // router.refresh() preserves client state (focused input, useState
          // field values) — React reconciles rather than replacing the DOM.
          router.refresh();
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
      expenseType,
      expenseCategoryCode,
      transactionDate,
      merchant,
      amountDisplay,
      currency,
      businessPurpose,
      attendees,
      router,
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
    triggerSave(false);
  }, [
    paymentPath,
    expenseType,
    expenseCategoryCode,
    transactionDate,
    merchant,
    amountDisplay,
    currency,
    businessPurpose,
    attendees,
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
            expenseType,
            expenseCategoryCode: expenseCategoryCode || null,
            transactionDate: transactionDate || null,
            merchant: merchant.trim() || null,
            amountMinor,
            currency,
            businessPurpose: businessPurpose.trim() || null,
            attendees: attendees.map((a) => a.trim()).filter(Boolean),
            status: "reviewed" as ReceiptStatus,
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
        if (props.nextReceiptId) {
          router.push(`/receipts/review/${props.nextReceiptId}`);
        } else {
          router.push("/receipts/review");
        }
      } catch {
        setSave({ kind: "error", message: "Network error" });
      }
    })();
  }, [
    receipt.id,
    paymentPath,
    expenseType,
    expenseCategoryCode,
    transactionDate,
    merchant,
    amountDisplay,
    currency,
    businessPurpose,
    attendees,
    props.nextReceiptId,
    router,
  ]);

  useKeyboardShortcuts({
    s: (e) => {
      e.preventDefault();
      onMarkReviewed();
    },
    c: (e) => {
      e.preventDefault();
      categoryRef.current?.focus();
    },
    a: (e) => {
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
      if (res.ok) router.push("/receipts/review");
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
            {props.queueIndex} of {props.queueTotal}
          </span>
        </div>
      </header>

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
              />
            </Field>
            <Field label="Date">
              <TextInput
                type="date"
                value={transactionDate}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setTransactionDate(e.target.value)}
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
                mono
              />
            </Field>
            <Field label="Expense type">
              <SelectInput
                value={expenseType}
                onChange={(e) =>
                  setExpenseType(e.target.value as ExpenseType)
                }
                options={EXPENSE_TYPES.map((e) => ({
                  value: e.value,
                  label: e.label,
                }))}
              />
            </Field>
          </div>
          <div className="mt-3">
            <Btn
              kind="ghost"
              size="sm"
              onClick={handleExtract}
              disabled={extractionBusy || pendingProcessing}
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
            <PaymentPathSeg value={paymentPath} onChange={setPaymentPath} />
          </Field>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Category" hint="14-item JP catalog">
              <select
                ref={categoryRef}
                value={expenseCategoryCode}
                onChange={(e) => setExpenseCategoryCode(e.target.value)}
                className="h-[38px] w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 focus:border-amber-500 focus:outline-none"
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
                directory={RECEIPT_ATTENDEE_DIRECTORY}
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
                disabled={overrideBusy}
                className="h-[36px] rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 focus:border-amber-500 focus:outline-none"
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
            rightIcon={<ArrowRightIcon size={14} className="text-white" />}
          >
            Mark reviewed → next
          </Btn>
          <span className="text-[11px] text-gray-400">
            <Kbd>s</Kbd>
          </span>
          {props.nextReceiptId && (
            <Btn
              kind="ghost"
              size="md"
              onClick={() =>
                router.push(`/receipts/review/${props.nextReceiptId}`)
              }
            >
              Skip
            </Btn>
          )}
          <span className="flex-1" />
          <Btn kind="danger" size="sm" onClick={handleDelete}>
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
