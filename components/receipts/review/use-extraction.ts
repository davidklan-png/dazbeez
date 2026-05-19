"use client";

import { useState } from "react";
import type { ExtractionResult } from "@/lib/receipts/types";

export type ExtractionApplyFn = (extracted: ExtractionResult) => number;

export type UseExtractionResult = {
  busy: boolean;
  feedback: string | null;
  run: () => Promise<void>;
  setFeedback: (msg: string | null) => void;
};

/**
 * Calls POST /api/receipts/:id/extract, then hands the result to a caller-
 * supplied `apply` function which is responsible for merging the new
 * fields into form state (returning the number of fields actually filled).
 *
 * Extracted from form-pane so the OCR retry/feedback UX has a single home.
 */
export function useExtraction(
  receiptId: string,
  apply: ExtractionApplyFn,
): UseExtractionResult {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/receipts/${receiptId}/extract`, {
        method: "POST",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        extracted?: ExtractionResult;
        error?: string;
      };
      if (!res.ok || !json.extracted) {
        setFeedback(json.error ?? "Extraction failed.");
        return;
      }
      const filled = apply(json.extracted);
      setFeedback(
        filled === 0
          ? "OCR ran — no new fields filled"
          : `${filled} field${filled === 1 ? "" : "s"} filled from OCR.`,
      );
    } catch {
      setFeedback("Network error — extraction failed.");
    } finally {
      setBusy(false);
    }
  }

  return { busy, feedback, run, setFeedback };
}
