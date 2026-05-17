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
import { RECEIPT_ATTENDEE_DIRECTORY } from "@/lib/receipts/attendee-directory";
import {
  EXPENSE_CATEGORIES,
  getCategoryByCode,
  requiresAttendees as categoryRequiresAttendees,
  formatCategoryLabel,
} from "@/lib/receipts/categories";
import type {
  ExpenseType,
  ExtractionResult,
  PaymentPath,
  ReceiptAttendee,
  ReceiptRecord,
  ReceiptStatus,
} from "@/lib/receipts/types";

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
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };

export function FormPane(props: FormPaneProps) {
  const router = useRouter();
  const { receipt } = props;

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
  const [extractionBusy, setExtractionBusy] = useState(false);
  const [extractionFeedback, setExtractionFeedback] = useState<string | null>(
    null,
  );

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
                : receipt.status === "needs_review"
                  ? receipt.status
                  : receipt.status) as ReceiptStatus,
            }),
            signal: ctrl.signal,
          });
          const json = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          if (!res.ok) {
            setSave({
              kind: "error",
              message: json.error ?? "Save failed",
            });
            return;
          }
          setSave({ kind: "saved", at: Date.now() });
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
    ],
  );

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

  // ─── extract helper (button in form) ────────────────────────────────
  async function handleExtract() {
    setExtractionBusy(true);
    setExtractionFeedback(null);
    try {
      const res = await fetch(`/api/receipts/${receipt.id}/extract`, {
        method: "POST",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        extracted?: ExtractionResult;
        error?: string;
      };
      if (!res.ok || !json.extracted) {
        setExtractionFeedback(json.error ?? "Extraction failed.");
        return;
      }
      const ex = json.extracted;
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
      if (ex.amountMinor != null) {
        const next = formatAmountInput(ex.amountMinor, ex.currency ?? currency);
        if (!amountDisplay) {
          setAmountDisplay(next);
          filled++;
        }
      }
      if (ex.expenseType && ex.expenseType !== "UNKNOWN" && expenseType === "UNKNOWN") {
        setExpenseType(ex.expenseType);
        filled++;
      }
      if (ex.businessPurpose && !businessPurpose) {
        setBusinessPurpose(ex.businessPurpose);
        filled++;
      }
      setExtractionFeedback(
        filled === 0 ? "OCR ran — no new fields filled" : `${filled} field${filled === 1 ? "" : "s"} filled from OCR.`,
      );
    } catch {
      setExtractionFeedback("Network error — extraction failed.");
    } finally {
      setExtractionBusy(false);
    }
  }

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
    const date = receipt.transaction_date || receipt.captured_at.slice(0, 10);
    try {
      return new Date(date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return date;
    }
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
              disabled={extractionBusy}
            >
              {extractionBusy ? "Extracting…" : "Re-run OCR extraction"}
            </Btn>
            {extractionFeedback && (
              <span className="ml-2 text-[11.5px] text-gray-500">
                {extractionFeedback}
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

function SaveBadge({ state }: { state: SaveState }) {
  const ago = useElapsedSeconds(state.kind === "saved" ? state.at : null);

  if (state.kind === "saving") {
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] text-amber-700">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        Saving…
      </span>
    );
  }
  if (state.kind === "saved") {
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] text-green-700">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        Saved · {ago}s ago
      </span>
    );
  }
  if (state.kind === "error") {
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] text-red-600">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
        {state.message}
      </span>
    );
  }
  return null;
}

function useElapsedSeconds(at: number | null): number {
  const [now, setNow] = useState<number | null>(at);
  useEffect(() => {
    if (at == null) return;
    const tick = () => setNow(Date.now());
    const start = setTimeout(tick, 0);
    const interval = setInterval(tick, 1000);
    return () => {
      clearTimeout(start);
      clearInterval(interval);
    };
  }, [at]);
  return at == null || now == null
    ? 0
    : Math.max(1, Math.round((now - at) / 1000));
}

function formatAmountInput(amount: number | null, currency: string | null) {
  if (amount == null) return "";
  if (!currency || currency === "JPY") return String(amount);
  return (amount / 100).toFixed(2);
}
