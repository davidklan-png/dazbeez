"use client";

import Link from "next/link";

interface ReceiptCaptureSuccessProps {
  receiptId: string;
  reviewUrl: string;
  rapidMode: boolean;
  onAddAnother: () => void;
}

export function ReceiptCaptureSuccess({
  receiptId: _receiptId,
  reviewUrl,
  rapidMode,
  onAddAnother,
}: ReceiptCaptureSuccessProps) {
  return (
    <div className="space-y-4 rounded-2xl border border-green-200 bg-green-50 p-5 text-center">
      <div className="flex justify-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl">
          ✓
        </span>
      </div>
      <div>
        <p className="font-semibold text-green-800">Receipt saved.</p>
        <p className="mt-0.5 text-sm text-green-600">
          Accounting details can be added later from the review queue.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={onAddAnother}
          className={`w-full rounded-xl px-4 py-2.5 text-sm font-semibold ${
            rapidMode
              ? "bg-amber-500 text-white hover:bg-amber-600"
              : "border border-amber-300 bg-white text-amber-700 hover:bg-amber-50"
          }`}
        >
          Add another receipt
        </button>
        <Link
          href={reviewUrl}
          className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-center text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Add details now
        </Link>
        <Link
          href="/receipts"
          className="text-sm text-gray-500 underline hover:text-gray-700"
        >
          Done
        </Link>
      </div>
    </div>
  );
}
