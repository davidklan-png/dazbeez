"use client";

import { useRef, useState } from "react";

export type PaymentChip = "AMEX" | "CASH" | null;

interface ReceiptDropButtonProps {
  initialPayment?: PaymentChip;
  onSuccess: (receiptId: string, reviewUrl: string) => void;
  onError: (message: string) => void;
  uploading: boolean;
  setUploading: (v: boolean) => void;
}

export function ReceiptDropButton({
  initialPayment,
  onSuccess,
  onError,
  uploading,
  setUploading,
}: ReceiptDropButtonProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [paymentChip, setPaymentChip] = useState<PaymentChip>(
    initialPayment ?? null,
  );

  function handleButtonClick() {
    fileRef.current?.click();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset so the same file can be re-selected if needed
    e.target.value = "";

    setUploading(true);
    onError("");

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("source", "mobile_capture");
      if (paymentChip) formData.append("paymentPath", paymentChip);

      const res = await fetch("/api/receipts/upload", {
        method: "POST",
        body: formData,
      });

      const json = (await res.json()) as {
        ok?: boolean;
        receiptId?: string;
        reviewUrl?: string;
        error?: string;
      };

      if (!res.ok || !json.receiptId) {
        onError(json.error ?? "Upload failed. Please try again.");
        return;
      }

      onSuccess(json.receiptId, json.reviewUrl ?? `/receipts/review/${json.receiptId}`);
    } catch {
      onError("Network error — please try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Hidden file input */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        aria-hidden="true"
        onChange={handleFileChange}
      />

      {/* Primary action button */}
      <button
        type="button"
        onClick={handleButtonClick}
        disabled={uploading}
        className="flex w-full items-center justify-center gap-3 rounded-2xl bg-amber-500 px-6 py-6 text-lg font-semibold text-white shadow-md transition hover:bg-amber-600 active:scale-[0.98] disabled:opacity-60"
      >
        {uploading ? (
          <>
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
            Uploading…
          </>
        ) : (
          <>
            <CameraIcon />
            Take Receipt Photo
          </>
        )}
      </button>

      {/* Optional payment chips */}
      <div>
        <p className="mb-2 text-center text-xs text-gray-400">
          Optional — select before taking photo
        </p>
        <div className="flex justify-center gap-3">
          {(["AMEX", "CASH"] as const).map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => setPaymentChip((c) => (c === chip ? null : chip))}
              className={`rounded-xl border px-5 py-2 text-sm font-medium transition ${
                paymentChip === chip
                  ? "border-amber-500 bg-amber-50 text-amber-700"
                  : "border-gray-200 bg-white text-gray-600 hover:border-amber-300 hover:text-amber-700"
              }`}
            >
              {chip}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function CameraIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="h-6 w-6"
      aria-hidden="true"
    >
      <path d="M12 9a3.75 3.75 0 1 0 0 7.5A3.75 3.75 0 0 0 12 9Z" />
      <path
        fillRule="evenodd"
        d="M9.344 3.071a49.52 49.52 0 0 1 5.312 0c.967.052 1.83.585 2.332 1.39l.821 1.317c.24.383.645.643 1.11.71.386.054.77.113 1.152.177 1.432.239 2.429 1.493 2.429 2.909V18a3 3 0 0 1-3 3h-15a3 3 0 0 1-3-3V9.574c0-1.416.997-2.67 2.429-2.909.382-.064.766-.123 1.151-.178a1.56 1.56 0 0 0 1.11-.71l.822-1.315a2.942 2.942 0 0 1 2.332-1.39ZM6.75 12.75a5.25 5.25 0 1 1 10.5 0 5.25 5.25 0 0 1-10.5 0Zm12-1.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
