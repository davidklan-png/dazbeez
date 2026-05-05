"use client";

import { useState } from "react";
import { ReceiptDropButton, type PaymentChip } from "@/components/receipts/receipt-drop-button";
import { ReceiptCaptureSuccess } from "@/components/receipts/receipt-capture-success";

interface ReceiptCaptureFormProps {
  initialPayment?: PaymentChip;
  rapidMode?: boolean;
}

type UploadState =
  | { phase: "idle" }
  | { phase: "uploading" }
  | { phase: "success"; receiptId: string; reviewUrl: string }
  | { phase: "error"; message: string };

export function ReceiptCaptureForm({
  initialPayment,
  rapidMode = false,
}: ReceiptCaptureFormProps) {
  const [state, setState] = useState<UploadState>({ phase: "idle" });

  function handleSuccess(receiptId: string, reviewUrl: string) {
    setState({ phase: "success", receiptId, reviewUrl });
  }

  function handleError(message: string) {
    if (message) setState({ phase: "error", message });
    else setState({ phase: "idle" });
  }

  function handleAddAnother() {
    setState({ phase: "idle" });
  }

  const uploading = state.phase === "uploading";

  return (
    <div className="space-y-4">
      {state.phase === "success" ? (
        <ReceiptCaptureSuccess
          receiptId={state.receiptId}
          reviewUrl={state.reviewUrl}
          rapidMode={rapidMode}
          onAddAnother={handleAddAnother}
        />
      ) : (
        <>
          <ReceiptDropButton
            initialPayment={initialPayment}
            onSuccess={handleSuccess}
            onError={handleError}
            uploading={uploading}
            setUploading={(v) =>
              setState(v ? { phase: "uploading" } : { phase: "idle" })
            }
          />

          {state.phase === "uploading" && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm text-amber-700">
              Photo captured. Uploading receipt…
            </div>
          )}

          {state.phase === "error" && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {state.message}
            </div>
          )}
        </>
      )}
    </div>
  );
}
