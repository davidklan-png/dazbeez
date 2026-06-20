"use client";

import { useCallback, useRef, useState } from "react";
import { maybeResizeImage } from "@/lib/receipts/client-image";
import type { PaymentPath } from "@/lib/receipts/types";

// ADR 0001: extraction is store-and-forward. Capture no longer runs OCR inline
// — the image is uploaded, enqueued, and processed later by the Mac MLX
// consumer. So the capture client just confirms "captured (pending processing)"
// and re-arms for the next shot; there is nothing to review here.

export type CapturePhase =
  | { kind: "idle" }
  | { kind: "uploading"; pct: number; fileName: string; fileSizeBytes: number }
  | { kind: "saved"; receiptId: string; reviewUrl: string; capturedAt: number }
  | { kind: "error"; message: string };

export function useReceiptUpload() {
  const [phase, setPhase] = useState<CapturePhase>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const upload = useCallback(
    async (file: File, paymentPath: PaymentPath | null) => {
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;

      setPhase({ kind: "uploading", pct: 5, fileName: file.name, fileSizeBytes: file.size });

      try {
        const uploadFile = await maybeResizeImage(file);
        setPhase({
          kind: "uploading",
          pct: 30,
          fileName: uploadFile.name,
          fileSizeBytes: uploadFile.size,
        });

        const fd = new FormData();
        fd.append("file", uploadFile);
        fd.append("source", "mobile_capture");
        if (paymentPath) fd.append("paymentPath", paymentPath);

        const res = await fetch("/api/receipts/upload", {
          method: "POST",
          body: fd,
          signal: abort.signal,
        });

        const json = (await res.json()) as {
          ok?: boolean;
          receiptId?: string;
          reviewUrl?: string;
          error?: string;
        };

        if (!res.ok || !json.receiptId) {
          setPhase({
            kind: "error",
            message: json.error ?? "Upload failed. Please try again.",
          });
          return;
        }

        // Captured and enqueued. Done — extraction happens later in the queue.
        setPhase({
          kind: "saved",
          receiptId: json.receiptId,
          reviewUrl: json.reviewUrl ?? `/receipts/review/${json.receiptId}`,
          capturedAt: Date.now(),
        });
      } catch (error) {
        if ((error as DOMException | undefined)?.name === "AbortError") return;
        setPhase({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Network error — please try again.",
        });
      }
    },
    [],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setPhase({ kind: "idle" });
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setPhase({ kind: "idle" });
  }, []);

  return { phase, upload, reset, cancel };
}
