"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "@/lib/receipts/use-viewport";
import {
  useReceiptUpload,
  type CapturePhase,
} from "@/components/receipts/capture/use-receipt-upload";
import { CaptureMobile } from "@/components/receipts/capture/capture-mobile";
import {
  CaptureDesktop,
  type SessionUpload,
} from "@/components/receipts/capture/capture-desktop";
import type { PaymentPath } from "@/lib/receipts/types";

export type PaymentChip = PaymentPath | null;

export interface ReceiptCaptureFormProps {
  initialPayment?: PaymentChip;
  rapidMode?: boolean;
  todayCount?: number;
}

const SESSION_QUEUE_KEY = "dazbeez.receipts.captureQueue.v1";
/** Drop persisted queue entries older than this so the desktop doesn't keep
 *  showing yesterday's receipts after a coffee break. */
const SESSION_QUEUE_TTL_MS = 1000 * 60 * 60 * 6;

function loadPersistedQueue(): SessionUpload[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(SESSION_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as {
      savedAt?: number;
      items?: SessionUpload[];
    };
    if (!parsed.items || !Array.isArray(parsed.items)) return [];
    if (!parsed.savedAt || Date.now() - parsed.savedAt > SESSION_QUEUE_TTL_MS)
      return [];
    // Don't restore in-flight uploads — the upload was aborted when the page
    // unloaded, so the row would dangle forever.
    return parsed.items.filter((u) => u.state !== "uploading");
  } catch {
    return [];
  }
}

function persistQueue(items: SessionUpload[]) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      SESSION_QUEUE_KEY,
      JSON.stringify({ savedAt: Date.now(), items }),
    );
  } catch {
    /* quota or privacy mode — best-effort */
  }
}

export function ReceiptCaptureForm({
  initialPayment = null,
  rapidMode = false,
  todayCount = 0,
}: ReceiptCaptureFormProps) {
  const isMobile = useIsMobile();
  const { phase, upload, reset, cancel } = useReceiptUpload();
  const [sessionUploads, setSessionUploads] = useState<SessionUpload[]>([]);
  const activeIdRef = useRef<string | null>(null);

  // Restore queue from sessionStorage on mount (desktop only — mobile uploads
  // immediately and doesn't keep a visible queue today).
  useEffect(() => {
    if (isMobile) return;
    const restored = loadPersistedQueue();
    if (restored.length > 0) setSessionUploads(restored);
  }, [isMobile]);

  // Persist on every change so a hard reload doesn't lose the day's work.
  useEffect(() => {
    if (isMobile) return;
    persistQueue(sessionUploads);
  }, [sessionUploads, isMobile]);

  const onPickFile = useCallback(
    async (file: File) => {
      if (isMobile) {
        await upload(file, initialPayment);
        return;
      }
      // Desktop: register a session upload row immediately
      const id = crypto.randomUUID();
      activeIdRef.current = id;
      setSessionUploads((prev) => [
        {
          id,
          fileName: file.name,
          fileSizeBytes: file.size,
          state: "uploading",
          pct: 5,
        },
        ...prev,
      ]);
      await upload(file, initialPayment);
    },
    [isMobile, upload, initialPayment],
  );

  // Mirror upload phase into the active session upload row (desktop only).
  useEffect(() => {
    if (isMobile) return;
    const activeId = activeIdRef.current;
    if (!activeId) return;
    setSessionUploads((prev) =>
      prev.map((u) =>
        u.id === activeId ? applyPhaseToUpload(u, phase) : u,
      ),
    );
  }, [phase, isMobile]);

  if (isMobile) {
    return (
      <CaptureMobile
        initialPayment={initialPayment}
        rapidMode={rapidMode}
        todayCount={todayCount}
        phase={phase}
        onPickFile={onPickFile}
        onCancel={cancel}
        onReset={reset}
      />
    );
  }

  return (
    <CaptureDesktop
      initialPayment={initialPayment}
      phase={phase}
      onPickFile={onPickFile}
      sessionUploads={sessionUploads}
    />
  );
}

function applyPhaseToUpload(
  u: SessionUpload,
  phase: CapturePhase,
): SessionUpload {
  if (phase.kind === "uploading") {
    return { ...u, state: "uploading", pct: phase.pct };
  }
  if (phase.kind === "saved") {
    const e = phase.extracted;
    const amountLabel =
      e?.amount != null
        ? `${e.currency === "JPY" || !e.currency ? "¥" : ""}${e.amount.toLocaleString()}`
        : "";
    return {
      ...u,
      state: phase.ocrStatus === "done" ? "ready" : "review",
      pct: 100,
      receiptId: phase.receiptId,
      merchant: e?.merchant ?? undefined,
      amount: amountLabel || undefined,
      date: e?.transactionDate ?? undefined,
    };
  }
  if (phase.kind === "error") {
    return { ...u, state: "error", pct: 100, errorMessage: phase.message };
  }
  return u;
}
