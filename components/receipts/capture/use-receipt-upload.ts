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

// Result of a single upload attempt. The desktop path (multi-file drop) reads
// this to update its per-row state; the mobile path ignores the return value
// and relies on `phase` (only one upload is ever in flight on mobile, so phase
// stays coherent there).
export type UploadResult =
  | { ok: true; receiptId: string; reviewUrl: string }
  | { ok: false; message: string };

export function useReceiptUpload() {
  const [phase, setPhase] = useState<CapturePhase>({ kind: "idle" });
  // Each upload() gets its OWN controller; cancel()/reset() aborts all of
  // them. The previous design kept a single controller and aborted it on
  // every new upload — which silently killed all but the last file when the
  // desktop drop handler called upload() N times back-to-back.
  const controllersRef = useRef<Set<AbortController>>(new Set());

  const upload = useCallback(
    async (
      file: File,
      paymentPath: PaymentPath | null,
    ): Promise<UploadResult> => {
      const abort = new AbortController();
      controllersRef.current.add(abort);

      setPhase({
        kind: "uploading",
        pct: 5,
        fileName: file.name,
        fileSizeBytes: file.size,
      });

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
        // NOTE: provenance mislabel — desktop uploads also send source=
        // "mobile_capture" here. The upload route accepts any string for
        // source (free-form column, no validation) so it doesn't break, but
        // the value is wrong for desktop. Tracked for a follow-up.
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
          const message =
            json.error ?? "Upload failed. Please try again.";
          setPhase({ kind: "error", message });
          return { ok: false, message };
        }

        // Captured and enqueued. Done — extraction happens later in the queue.
        const reviewUrl =
          json.reviewUrl ?? `/receipts/review/${json.receiptId}`;
        setPhase({
          kind: "saved",
          receiptId: json.receiptId,
          reviewUrl,
          capturedAt: Date.now(),
        });
        return { ok: true, receiptId: json.receiptId, reviewUrl };
      } catch (error) {
        if ((error as DOMException | undefined)?.name === "AbortError") {
          // Explicit cancel/reset already set phase to idle — don't clobber
          // it with an error. Caller still sees a result it can act on.
          return { ok: false, message: "Cancelled" };
        }
        const message =
          error instanceof Error
            ? error.message
            : "Network error — please try again.";
        setPhase({ kind: "error", message });
        return { ok: false, message };
      } finally {
        controllersRef.current.delete(abort);
      }
    },
    [],
  );

  const abortAll = useCallback(() => {
    controllersRef.current.forEach((c) => c.abort());
    controllersRef.current.clear();
  }, []);

  const reset = useCallback(() => {
    abortAll();
    setPhase({ kind: "idle" });
  }, [abortAll]);

  const cancel = useCallback(() => {
    abortAll();
    setPhase({ kind: "idle" });
  }, [abortAll]);

  return { phase, upload, reset, cancel };
}
