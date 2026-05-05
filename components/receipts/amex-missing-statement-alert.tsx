"use client";

import { useState } from "react";
import Link from "next/link";

const NETANSWER_URL = "https://www.saisoncard.co.jp/customer-support/netanswer/";

interface Props {
  statementMonth: string;
  expectedReadyDate: string;
}

export function AmexMissingStatementAlert({ statementMonth, expectedReadyDate }: Props) {
  const [dismissed, setDismissed] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  async function handleDismiss() {
    setDismissing(true);
    try {
      await fetch("/api/receipts/alerts/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alertType: "amex_statement_missing",
          alertKey: statementMonth,
        }),
      });
      setDismissed(true);
    } catch {
      // silently fail — just hide it client-side
      setDismissed(true);
    } finally {
      setDismissing(false);
    }
  }

  if (dismissed) return null;

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
      <div>
        <p className="font-semibold text-amber-800">
          AMEX statement for {statementMonth} should now be available in Netアンサー, but it has
          not been uploaded yet.
        </p>
        <p className="mt-0.5 text-xs text-amber-700">
          Expected ready from {expectedReadyDate}.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <a
          href={NETANSWER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100"
        >
          Open Netアンサー
        </a>
        <Link
          href="/receipts/amex"
          className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600"
        >
          Upload AMEX CSV
        </Link>
        <button
          type="button"
          onClick={handleDismiss}
          disabled={dismissing}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-60"
        >
          {dismissing ? "Dismissing…" : "Dismiss for now"}
        </button>
      </div>
    </div>
  );
}
