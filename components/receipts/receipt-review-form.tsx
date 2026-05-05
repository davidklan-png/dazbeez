"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AttendeeEditor } from "@/components/receipts/attendee-editor";
import { ReceiptImageViewer } from "@/components/receipts/receipt-image-viewer";
import type { ReceiptRecord, ReceiptAttendee, ExtractionResult } from "@/lib/receipts/types";

const EXPENSE_TYPES = [
  { value: "meeting-no-alcohol", label: "Meeting (no alcohol)" },
  { value: "entertainment-alcohol", label: "Entertainment (alcohol)" },
  { value: "transportation", label: "Transportation" },
  { value: "books", label: "Books" },
  { value: "research", label: "Research" },
  { value: "insurance", label: "Insurance" },
  { value: "misc", label: "Miscellaneous" },
] as const;

const PAYMENT_PATHS = [
  { value: "AMEX", label: "AMEX" },
  { value: "CASH", label: "Cash" },
  { value: "DIGITAL", label: "Digital" },
] as const;

const CURRENCIES = ["JPY", "USD", "EUR", "GBP", "AUD", "CNY"] as const;

type ExpenseType = (typeof EXPENSE_TYPES)[number]["value"];

const ATTENDEE_REQUIRED_TYPES: ExpenseType[] = [
  "meeting-no-alcohol",
  "entertainment-alcohol",
];

interface ReceiptReviewFormProps {
  receipt: ReceiptRecord;
  initialAttendees: ReceiptAttendee[];
}

export function ReceiptReviewForm({
  receipt,
  initialAttendees,
}: ReceiptReviewFormProps) {
  const router = useRouter();

  const [paymentPath, setPaymentPath] = useState(receipt.payment_path);
  const [expenseType, setExpenseType] = useState(receipt.expense_type);
  const [transactionDate, setTransactionDate] = useState(
    receipt.transaction_date ?? "",
  );
  const [merchant, setMerchant] = useState(receipt.merchant ?? "");
  const [amountDisplay, setAmountDisplay] = useState(
    receipt.amount_minor !== null
      ? receipt.currency === "JPY"
        ? String(receipt.amount_minor)
        : (receipt.amount_minor / 100).toFixed(2)
      : "",
  );
  const [currency, setCurrency] = useState(receipt.currency);
  const [businessPurpose, setBusinessPurpose] = useState(
    receipt.business_purpose ?? "",
  );
  const [attendees, setAttendees] = useState<string[]>(
    initialAttendees.map((a) => a.attendee_name),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  type ExtractionPhase =
    | { phase: "idle" }
    | { phase: "extracting" }
    | { phase: "done"; filled: number; suggestions: Record<string, string> }
    | { phase: "error"; message: string };

  const [extraction, setExtraction] = useState<ExtractionPhase>({ phase: "idle" });

  const needsAttendees = ATTENDEE_REQUIRED_TYPES.includes(
    expenseType as ExpenseType,
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    if (needsAttendees && attendees.filter((a) => a.trim()).length === 0) {
      setError("At least one attendee is required for this expense type.");
      return;
    }

    let amountMinor: number | null = null;
    if (amountDisplay.trim()) {
      const parsed = parseFloat(amountDisplay.replace(/[^0-9.]/g, ""));
      if (!isNaN(parsed)) {
        amountMinor = currency === "JPY" ? Math.round(parsed) : Math.round(parsed * 100);
      }
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/receipts/${receipt.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentPath,
          expenseType,
          transactionDate: transactionDate || null,
          merchant: merchant.trim() || null,
          amountMinor,
          currency,
          businessPurpose: businessPurpose.trim() || null,
          attendees: attendees.filter((a) => a.trim()),
          status: "reviewed",
        }),
      });

      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(json.error ?? "Save failed.");
        return;
      }

      setSaved(true);
      router.push("/receipts/review");
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleExtract() {
    setExtraction({ phase: "extracting" });
    try {
      const res = await fetch(`/api/receipts/${receipt.id}/extract`, { method: "POST" });
      const json = (await res.json()) as { ok?: boolean; extracted?: ExtractionResult; error?: string };

      if (!res.ok || !json.extracted) {
        setExtraction({ phase: "error", message: json.error ?? "Extraction failed." });
        return;
      }

      const ex = json.extracted;
      const suggestions: Record<string, string> = {};
      let filled = 0;

      // Apply extracted values to blank/UNKNOWN fields; record conflicts as suggestions.
      if (ex.transactionDate) {
        if (!transactionDate) { setTransactionDate(ex.transactionDate); filled++; }
        else if (transactionDate !== ex.transactionDate)
          suggestions["Date"] = ex.transactionDate;
      }
      if (ex.merchant) {
        if (!merchant) { setMerchant(ex.merchant); filled++; }
        else if (merchant !== ex.merchant) suggestions["Merchant"] = ex.merchant;
      }
      if (ex.currency && ex.currency !== currency) {
        if (currency === "JPY") { setCurrency(ex.currency); filled++; }
        else suggestions["Currency"] = ex.currency;
      }
      if (ex.amountMinor !== null) {
        const exDisplay =
          (ex.currency ?? currency) === "JPY"
            ? String(ex.amountMinor)
            : (ex.amountMinor / 100).toFixed(2);
        if (!amountDisplay) { setAmountDisplay(exDisplay); filled++; }
        else if (amountDisplay !== exDisplay) suggestions["Amount"] = exDisplay;
      }
      if (ex.expenseType && ex.expenseType !== "UNKNOWN") {
        if (expenseType === "UNKNOWN") { setExpenseType(ex.expenseType); filled++; }
        else if (expenseType !== ex.expenseType) suggestions["Expense type"] = ex.expenseType;
      }
      if (ex.businessPurpose) {
        if (!businessPurpose) { setBusinessPurpose(ex.businessPurpose); filled++; }
        else if (businessPurpose !== ex.businessPurpose)
          suggestions["Business purpose"] = ex.businessPurpose;
      }

      setExtraction({ phase: "done", filled, suggestions });
    } catch {
      setExtraction({ phase: "error", message: "Network error — extraction failed." });
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Receipt preview */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Receipt preview
        </p>
        <ReceiptImageViewer
          receiptId={receipt.id}
          contentType={receipt.original_content_type}
        />
        <dl className="mt-3 space-y-1 text-xs text-gray-500">
          <div className="flex gap-2">
            <dt className="font-medium">Status:</dt>
            <dd className="capitalize">{receipt.status}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium">Captured:</dt>
            <dd>{receipt.captured_at.slice(0, 16).replace("T", " ")}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium">File size:</dt>
            <dd>{(receipt.original_size_bytes / 1024).toFixed(0)} KB</dd>
          </div>
        </dl>
      </div>

      {/* Edit form */}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Receipt details
          </p>

          {/* Payment path */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700">
              Payment method
            </label>
            <div className="mt-2 flex gap-3">
              {PAYMENT_PATHS.map((p) => (
                <label key={p.value} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="paymentPath"
                    value={p.value}
                    checked={paymentPath === p.value}
                    onChange={() => setPaymentPath(p.value as typeof receipt.payment_path)}
                    className="accent-amber-500"
                  />
                  {p.label}
                </label>
              ))}
            </div>
          </div>

          {/* Expense type */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700">
              Expense type
            </label>
            <select
              value={expenseType}
              onChange={(e) => setExpenseType(e.target.value as typeof receipt.expense_type)}
              className="mt-2 block w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
            >
              {EXPENSE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {/* Date */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700">
              Transaction date
            </label>
            <input
              type="date"
              value={transactionDate}
              onChange={(e) => setTransactionDate(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
              className="mt-2 block w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
            />
          </div>

          {/* Merchant */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700">Merchant</label>
            <input
              type="text"
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
              className="mt-2 block w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
            />
          </div>

          {/* Amount + currency */}
          <div className="mb-4 flex gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700">Amount</label>
              <input
                type="number"
                inputMode="decimal"
                value={amountDisplay}
                onChange={(e) => setAmountDisplay(e.target.value)}
                min="0"
                step={currency === "JPY" ? "1" : "0.01"}
                className="mt-2 block w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
              />
            </div>
            <div className="w-28">
              <label className="block text-sm font-medium text-gray-700">Currency</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="mt-2 block w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Business purpose */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700">
              Business purpose
            </label>
            <textarea
              value={businessPurpose}
              onChange={(e) => setBusinessPurpose(e.target.value)}
              rows={2}
              className="mt-2 block w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
            />
          </div>

          {/* Attendees */}
          {needsAttendees && (
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700">
                Attendees <span className="text-red-500">*</span>
              </label>
              <div className="mt-2">
                <AttendeeEditor attendees={attendees} onChange={setAttendees} />
              </div>
            </div>
          )}

          {/* AI extraction */}
          <div className="mb-4">
            <button
              type="button"
              onClick={handleExtract}
              disabled={extraction.phase === "extracting" || saving}
              className="w-full rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-60"
            >
              {extraction.phase === "extracting" ? "Extracting…" : "Extract details with AI"}
            </button>

            {extraction.phase === "done" && extraction.filled > 0 && (
              <p className="mt-1.5 text-center text-xs text-green-600">
                {extraction.filled} field{extraction.filled !== 1 ? "s" : ""} filled from receipt image.
              </p>
            )}

            {extraction.phase === "done" && extraction.filled === 0 && Object.keys(extraction.suggestions).length === 0 && (
              <p className="mt-1.5 text-center text-xs text-gray-500">
                AI could not read details from this image. Fill in manually.
              </p>
            )}

            {extraction.phase === "done" && Object.keys(extraction.suggestions).length > 0 && (
              <div className="mt-2 rounded-xl border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                <p className="mb-1 font-semibold">AI suggestions (your values were kept):</p>
                {Object.entries(extraction.suggestions).map(([field, value]) => (
                  <p key={field}>{field}: <span className="font-mono">{value}</span></p>
                ))}
              </div>
            )}

            {extraction.phase === "error" && (
              <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {extraction.message}
              </div>
            )}
          </div>

          {error && (
            <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          {saved && (
            <div className="mb-3 rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
              Saved successfully.
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-xl bg-amber-500 px-4 py-3 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save & mark reviewed"}
          </button>
        </div>
      </form>
    </div>
  );
}
