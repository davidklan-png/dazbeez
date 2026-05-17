"use client";

import { useCallback, useRef, useState } from "react";
import { maybeResizeImage } from "@/lib/receipts/client-image";
import type { PaymentPath } from "@/lib/receipts/types";

export type CaptureExtraction = {
  merchant?: string | null;
  amount?: number | null;
  currency?: string | null;
  transactionDate?: string | null;
  expenseType?: string | null;
};

export type CapturePhase =
  | { kind: "idle" }
  | { kind: "uploading"; pct: number; fileName: string; fileSizeBytes: number }
  | {
      kind: "saved";
      receiptId: string;
      reviewUrl: string;
      ocrStatus: "running" | "done" | "timeout" | "error";
      extracted?: CaptureExtraction;
      capturedAt: number;
    }
  | { kind: "error"; message: string };

const OCR_POLL_INTERVAL_MS = 800;
const OCR_TIMEOUT_MS = 12_000;

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

        const receiptId = json.receiptId;
        const reviewUrl = json.reviewUrl ?? `/receipts/review/${receiptId}`;

        setPhase({
          kind: "saved",
          receiptId,
          reviewUrl,
          ocrStatus: "running",
          capturedAt: Date.now(),
        });

        // Fire-and-poll OCR. Best-effort; UI degrades to "no preview" if it doesn't land in time.
        void runOcrAndPoll(receiptId, reviewUrl, abort.signal, setPhase);
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

async function runOcrAndPoll(
  receiptId: string,
  reviewUrl: string,
  signal: AbortSignal,
  setPhase: (next: CapturePhase) => void,
) {
  try {
    await fetch(`/api/receipts/${receiptId}/extract`, {
      method: "POST",
      signal,
    });
  } catch {
    // ignore; we still poll the record
  }

  const started = Date.now();
  while (!signal.aborted) {
    if (Date.now() - started > OCR_TIMEOUT_MS) {
      setPhase({
        kind: "saved",
        receiptId,
        reviewUrl,
        ocrStatus: "timeout",
        capturedAt: started,
      });
      return;
    }
    try {
      const res = await fetch(`/api/receipts/${receiptId}`, { signal });
      if (res.ok) {
        const data = (await res.json()) as {
          receipt?: {
            merchant?: string | null;
            amountMinor?: number | null;
            currency?: string | null;
            transactionDate?: string | null;
            expenseType?: string | null;
            extractionJson?: string | null;
          };
        };
        const r = data.receipt;
        if (r && (r.merchant || r.amountMinor || r.extractionJson)) {
          setPhase({
            kind: "saved",
            receiptId,
            reviewUrl,
            ocrStatus: "done",
            capturedAt: started,
            extracted: {
              merchant: r.merchant ?? null,
              amount: r.amountMinor ?? null,
              currency: r.currency ?? null,
              transactionDate: r.transactionDate ?? null,
              expenseType: r.expenseType ?? null,
            },
          });
          return;
        }
      }
    } catch {
      // network blip; retry until timeout
    }
    await wait(OCR_POLL_INTERVAL_MS, signal);
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
