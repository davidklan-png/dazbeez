"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useIsMobile } from "@/lib/receipts/use-viewport";
import { useReceiptUpload } from "@/components/receipts/capture/use-receipt-upload";
import { CaptureMobile } from "@/components/receipts/capture/capture-mobile";
import { CaptureDesktop } from "@/components/receipts/capture/capture-desktop";
import type { PaymentPath } from "@/lib/receipts/types";
import {
  DESKTOP_MAX_CONCURRENT_UPLOADS,
  type Source,
} from "@/lib/receipts/upload-policy";
import { UploadPool } from "@/lib/receipts/upload-pool";
import { SingleFlight } from "@/lib/receipts/single-flight";
import {
  applyUploadFailure,
  applyUploadSuccess,
  type SessionUpload,
} from "@/lib/receipts/session-upload";
import { useRecentCaptures } from "@/lib/receipts/use-recent-captures";
import type { RecentCapture } from "@/lib/receipts/recent-captures";

export type PaymentChip = PaymentPath | null;

export interface ReceiptCaptureFormProps {
  initialPayment?: PaymentChip;
  rapidMode?: boolean;
  /** Active work month (exact YYYY-MM) carried across pages; threaded into the
   *  Review deep-links so a detour to Capture preserves the month. null when
   *  there is none. */
  workMonth?: string | null;
  /** Today's captured-receipt count for the mobile header chip. null when
   *  the count query failed (audit B1) — UI renders "—" with a title. */
  todayCount?: number | null;
  /** Server-seeded recent-captures list for the rail; kept live client-side. */
  recentCaptures?: RecentCapture[];
}

const SESSION_QUEUE_KEY = "dazbeez.receipts.captureQueue.v1";
/** Drop persisted queue entries older than this so the desktop doesn't keep
 *  showing yesterday's receipts after a coffee break. */
const SESSION_QUEUE_TTL_MS = 1000 * 60 * 60 * 6;
/** Stable empty array reference so useSyncExternalStore doesn't tear when
 *  the server snapshot is read repeatedly. */
const EMPTY_QUEUE: SessionUpload[] = [];

// useSyncExternalStore requires the snapshot getter to return a
// referentially-stable value, so we memoise across renders. The cache is
// invalidated on every successful persistQueue() write below.
let cachedQueue: SessionUpload[] | null = null;

function readPersistedQueueFresh(): SessionUpload[] {
  if (typeof window === "undefined") return EMPTY_QUEUE;
  try {
    const raw = window.sessionStorage.getItem(SESSION_QUEUE_KEY);
    if (!raw) return EMPTY_QUEUE;
    const parsed = JSON.parse(raw) as {
      savedAt?: number;
      items?: SessionUpload[];
    };
    if (!parsed.items || !Array.isArray(parsed.items)) return EMPTY_QUEUE;
    if (!parsed.savedAt || Date.now() - parsed.savedAt > SESSION_QUEUE_TTL_MS)
      return EMPTY_QUEUE;
    // Don't restore in-flight uploads — the upload was aborted when the page
    // unloaded, so the row would dangle forever.
    const filtered = parsed.items.filter((u) => u.state !== "uploading");
    return filtered.length === 0 ? EMPTY_QUEUE : filtered;
  } catch {
    return EMPTY_QUEUE;
  }
}

function loadPersistedQueue(): SessionUpload[] {
  if (cachedQueue == null) cachedQueue = readPersistedQueueFresh();
  return cachedQueue;
}

function persistQueue(items: SessionUpload[]) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      SESSION_QUEUE_KEY,
      JSON.stringify({ savedAt: Date.now(), items }),
    );
    cachedQueue = items;
  } catch {
    /* quota or privacy mode — best-effort */
  }
}

const subscribeNoop = () => () => {};

export function ReceiptCaptureForm({
  initialPayment = null,
  rapidMode = false,
  workMonth = null,
  todayCount = null,
  recentCaptures = [],
}: ReceiptCaptureFormProps) {
  const isMobile = useIsMobile();
  const { phase, upload, reset, cancel } = useReceiptUpload();
  // DB-backed recent-captures rail: seeded from the server, refreshed after
  // each successful upload and polled while anything is still processing.
  const {
    items: recentItems,
    refresh: refreshRecent,
    refreshUnavailable: recentRefreshUnavailable,
  } = useRecentCaptures(recentCaptures);
  // Seed the queue from sessionStorage on the very first client render
  // (server snapshot is always empty so hydration matches the empty SSR
  // markup; the client snapshot reads the persisted queue immediately,
  // without an effect-driven setState).
  const persisted = useSyncExternalStore(
    subscribeNoop,
    loadPersistedQueue,
    () => EMPTY_QUEUE,
  );
  const [sessionUploads, setSessionUploads] = useState<SessionUpload[]>(persisted);
  // Live "Preselect AMEX/CASH" chip state. Lifted up from CaptureMobile so
  // onPickFile's upload() reads the value the operator actually toggled, not
  // the one-time initialPayment prop (seeded once from the ?payment= URL).
  // Before this, paymentChip lived in CaptureMobile and only drove the chip's
  // own highlight — it never reached the upload call, so the chip was cosmetic.
  const [paymentChip, setPaymentChip] = useState<PaymentChip>(initialPayment);
  // Desktop FIFO concurrency pool (limit DESKTOP_MAX_CONCURRENT_UPLOADS) and
  // the mobile single-flight gate. Both held in refs so they survive re-renders
  // without restarting in-flight work.
  const desktopPoolRef = useRef(new UploadPool(DESKTOP_MAX_CONCURRENT_UPLOADS));
  const mobileSingleFlightRef = useRef(new SingleFlight());

  // Persist on every change so a hard reload doesn't lose the day's work.
  useEffect(() => {
    if (isMobile) return;
    persistQueue(sessionUploads);
  }, [sessionUploads, isMobile]);

  const onPickFile = useCallback(
    async (file: File) => {
      // Provenance: mobile web captures are camera-origin, desktop drops are
      // not. The upload route requires this value (no silent default).
      const source: Source = isMobile ? "mobile_capture" : "desktop_upload";

      if (isMobile) {
        // Mobile single-flight (explicit rejection): a second capture while one
        // is uploading is ignored so it cannot overwrite the active upload's
        // phase. The normal capture -> upload -> re-arm flow is unchanged.
        if (!mobileSingleFlightRef.current.start()) return;
        try {
          const result = await upload(file, paymentChip, source);
          // New receipt is in D1 now — refresh the recent rail immediately so
          // it appears (the 15s pending-poll is the backstop if D1 lags).
          if (result.ok) void refreshRecent();
        } finally {
          mobileSingleFlightRef.current.finish();
        }
        return;
      }

      // Desktop: register a session row immediately so the user sees the file
      // appear in the batch grid + sidebar queue, then acquire a concurrency
      // slot (FIFO) and patch the row from the result via pure transitions.
      const id = crypto.randomUUID();
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

      const slot = await desktopPoolRef.current.acquire();
      try {
        const result = await upload(file, paymentChip, source);
        setSessionUploads((prev) =>
          prev.map((u) =>
            u.id === id
              ? result.ok
                ? applyUploadSuccess(u, result.receiptId)
                : applyUploadFailure(u, result.message)
              : u,
          ),
        );
        if (result.ok) void refreshRecent();
      } finally {
        slot.release();
      }
    },
    [isMobile, upload, paymentChip, refreshRecent],
  );

  if (isMobile) {
    return (
      <CaptureMobile
        paymentChip={paymentChip}
        setPaymentChip={setPaymentChip}
        rapidMode={rapidMode}
        workMonth={workMonth}
        todayCount={todayCount}
        recentCaptures={recentItems}
        recentRefreshUnavailable={recentRefreshUnavailable}
        onRecentRetry={refreshRecent}
        phase={phase}
        onPickFile={onPickFile}
        onCancel={cancel}
        onReset={reset}
      />
    );
  }

  return (
    <CaptureDesktop
      onPickFile={onPickFile}
      sessionUploads={sessionUploads}
      workMonth={workMonth}
      recentCaptures={recentItems}
      recentRefreshUnavailable={recentRefreshUnavailable}
      onRecentRetry={refreshRecent}
    />
  );
}
