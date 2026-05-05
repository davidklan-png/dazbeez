"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const NETANSWER_URL = "https://www.saisoncard.co.jp/customer-support/netanswer/";

interface ImportResult {
  ok: boolean;
  duplicate?: boolean;
  needsReplaceConfirm?: boolean;
  artifactId?: string;
  existingArtifactId?: string;
  statementMonth: string;
  importStatus?: string;
  cardName?: string | null;
  paymentDueDate?: string | null;
  statementTotalCents?: number | null;
  parsedTotalCents?: number;
  transactionCount?: number;
  imported?: number;
  skipped?: number;
  replaced?: boolean;
  businessTripCandidates?: number;
  message?: string;
  validationErrors?: string[];
  error?: string;
}

export function AmexImportForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [statementMonth, setStatementMonth] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingReplace, setPendingReplace] = useState<{
    existingArtifactId: string;
    statementMonth: string;
  } | null>(null);

  async function submit(replaceConfirmed: boolean) {
    if (!file) { setError("Please select a CSV file."); return; }
    if (!statementMonth) { setError("Please select the statement month."); return; }

    setError(null);
    setResult(null);
    setSubmitting(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("statementMonth", statementMonth);
      if (replaceConfirmed) formData.append("replaceConfirmed", "true");

      const res = await fetch("/api/receipts/amex/import", {
        method: "POST",
        body: formData,
      });

      const json = (await res.json()) as ImportResult;

      if (res.status === 409 && json.needsReplaceConfirm) {
        setPendingReplace({
          existingArtifactId: json.existingArtifactId ?? "",
          statementMonth: json.statementMonth,
        });
        return;
      }

      if (res.status === 422 && json.validationErrors) {
        setError(json.validationErrors[0] ?? "Validation failed.");
        return;
      }

      if (!res.ok) {
        setError(json.error ?? "Import failed.");
        return;
      }

      setResult(json);
      setPendingReplace(null);
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submit(false);
  }

  async function handleConfirmReplace() {
    await submit(true);
  }

  function handleCancelReplace() {
    setPendingReplace(null);
    setFile(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600">
          Download the CSV from Netアンサー Web明細, then upload it here.
        </p>
        <a
          href={NETANSWER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-amber-600 underline hover:text-amber-700"
        >
          Open Netアンサー login ↗
        </a>
      </div>

      {/* Replace confirmation */}
      {pendingReplace && (
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm">
          <p className="font-medium text-yellow-800">
            A statement for {pendingReplace.statementMonth} already exists. Replace it?
          </p>
          <p className="mt-0.5 text-xs text-yellow-700">
            The existing CSV artifact is preserved for audit. Line items will be superseded.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={handleConfirmReplace}
              disabled={submitting}
              className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
            >
              {submitting ? "Replacing…" : "Yes, replace"}
            </button>
            <button
              type="button"
              onClick={handleCancelReplace}
              disabled={submitting}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!pendingReplace && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Statement month <span className="text-red-500">*</span>
            </label>
            <input
              type="month"
              value={statementMonth}
              onChange={(e) => setStatementMonth(e.target.value)}
              className="mt-2 block w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              AMEX CSV file <span className="text-red-500">*</span>
            </label>
            <p className="mt-0.5 text-xs text-gray-500">
              Netアンサー Web明細 CSV · max 5 MB · Shift-JIS/CP932 supported
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-2 block w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-xl bg-amber-500 px-4 py-3 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
          >
            {submitting ? "Importing…" : "Import CSV"}
          </button>
        </form>
      )}

      {/* Import result summary */}
      {result && (
        <ImportResultSummary result={result} />
      )}
    </div>
  );
}

function ImportResultSummary({ result }: { result: ImportResult }) {
  if (result.duplicate) {
    return (
      <div className="rounded-xl border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
        {result.message}
      </div>
    );
  }

  const total = result.statementTotalCents
    ? `¥${result.statementTotalCents.toLocaleString()}`
    : "—";

  return (
    <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm">
      <p className="mb-2 font-semibold text-green-800">
        {result.replaced ? "Statement replaced successfully." : "Statement imported successfully."}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-green-800">
        <dt className="font-medium">Statement month</dt>
        <dd>{result.statementMonth}</dd>
        {result.paymentDueDate && (
          <>
            <dt className="font-medium">Payment due date</dt>
            <dd>{result.paymentDueDate}</dd>
          </>
        )}
        {result.cardName && (
          <>
            <dt className="font-medium">Card</dt>
            <dd className="truncate">{result.cardName}</dd>
          </>
        )}
        <dt className="font-medium">Rows imported</dt>
        <dd>{result.transactionCount ?? result.imported}</dd>
        <dt className="font-medium">Total</dt>
        <dd>{total}</dd>
        <dt className="font-medium">Status</dt>
        <dd className="capitalize">{result.importStatus ?? "parsed"}</dd>
      </dl>
      {(result.businessTripCandidates ?? 0) > 0 && (
        <p className="mt-2 text-xs text-green-700">
          {result.businessTripCandidates} business trip candidate
          {result.businessTripCandidates !== 1 ? "s" : ""} detected.
        </p>
      )}
    </div>
  );
}
