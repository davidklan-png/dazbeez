"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PaymentPath } from "@/lib/receipts/types";
import type { Source } from "@/lib/receipts/upload-policy";
import { AbortRegistry } from "@/lib/receipts/abort-registry";
import { browserCaptureId } from "@/lib/receipts/browser-capture";
import {
  UploadAttempt,
  type CapturePhase,
  type UploadResult,
} from "@/lib/receipts/upload-attempt";

export type { CapturePhase, UploadResult } from "@/lib/receipts/upload-attempt";

export function useReceiptUpload() {
  const [phase, setPhase] = useState<CapturePhase>({ kind: "idle" });
  const registryRef = useRef(new AbortRegistry());
  const captureIdsRef = useRef(new WeakMap<File, string>());
  const mobileRef = useRef<UploadAttempt | null>(null);

  useEffect(() => () => {
    mobileRef.current?.dispose();
    mobileRef.current = null;
    registryRef.current.abortAll();
  }, []);

  const upload = useCallback(async (
    file: File,
    paymentPath: PaymentPath | null,
    source: Source,
  ): Promise<UploadResult> => {
    // An unresolved mobile selection can only be replaced by explicit discard.
    if (source === "mobile_capture" && mobileRef.current) {
      return { ok: false, message: "Retry or discard the retained photo first." };
    }
    const captureId = source === "mobile_capture"
      ? crypto.randomUUID()
      : browserCaptureId(file, captureIdsRef.current);
    const attempt = new UploadAttempt(file, paymentPath, source, captureId);
    if (source === "mobile_capture") mobileRef.current = attempt;
    const abort = new AbortController();
    abort.signal.addEventListener("abort", () => attempt.dispose(), { once: true });
    registryRef.current.register(abort);
    try {
      // Desktop outcomes belong to their session rows, never the retained mobile photo.
      const result = await attempt.run(source === "mobile_capture" ? setPhase : () => {});
      if (result.ok && mobileRef.current === attempt) mobileRef.current = null;
      return result;
    } finally {
      registryRef.current.unregister(abort);
      if (source !== "mobile_capture") attempt.dispose();
    }
  }, []);

  const retry = useCallback(async (): Promise<UploadResult> => {
    const attempt = mobileRef.current;
    if (!attempt) return { ok: false, message: "No retained photo." };
    const result = await attempt.run(setPhase);
    if (result.ok && mobileRef.current === attempt) mobileRef.current = null;
    return result;
  }, []);

  const reset = useCallback(() => {
    mobileRef.current?.dispose();
    mobileRef.current = null;
    registryRef.current.abortAll();
    setPhase({ kind: "idle" });
  }, []);

  const cancel = useCallback(() => {
    if (mobileRef.current) {
      mobileRef.current.cancel();
      setPhase({
        kind: "error",
        message: "Upload cancelled. The server may already have saved it. Retry this photo to confirm the outcome.",
      });
    } else {
      registryRef.current.abortAll();
      setPhase({ kind: "idle" });
    }
  }, []);

  return { phase, upload, retry, reset, cancel };
}
