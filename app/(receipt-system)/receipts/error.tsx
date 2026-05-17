"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function ReceiptsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[receipts] page error", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-12 text-center">
      <div className="max-w-lg rounded-2xl border border-red-200 bg-red-50 p-6 text-left">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-red-700">
          Receipts · page error
        </div>
        <div className="mt-2 text-lg font-semibold text-gray-900">
          Something went wrong while loading this page.
        </div>
        <p className="mt-2 text-sm text-gray-600">
          The receipts module hit an unexpected error. The detail below is the
          actual exception — share it with David if it keeps happening.
        </p>
        <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-white p-3 font-mono text-[12px] text-red-700">
{error.message || "Unknown error"}
{error.digest ? `\n\ndigest: ${error.digest}` : ""}
        </pre>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600"
          >
            Try again
          </button>
          <Link
            href="/receipts"
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
