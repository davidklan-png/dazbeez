"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useIsMobile } from "@/lib/receipts/use-viewport";
import { useReceiptUpload } from "@/components/receipts/capture/use-receipt-upload";
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
/** Stable empty array reference so useSyncExternalStore doesn't tear when
 *  the server snapshot is read repeatedly. */
const EMPTY_QUEUE: SessionUpload[] = [];
/** Max concurrent uploads on the desktop drop path. Drops beyond this are
 *  queued in order (FIFO). 3 is a conservative cap that keeps the browser's
 *  HTTP/2 connection to the Worker saturated without overwhelming it. */
const MAX_CONCURRENT_UPLOADS = 3;

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

interface UploadPool {
  active: number;
  waiters: Array<() => void>;
}

export function ReceiptCaptureForm({
  initialPayment = null,
  rapidMode = false,
  todayCount = 0,
}: ReceiptCaptureFormProps) {
  const isMobile = useIsMobile();
  const { phase, upload, reset, cancel } = useReceiptUpload();
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
  // Per-form concurrency pool — limits simultaneous uploads so a 25-file
  // drop doesn't fire 25 fetches at once. Held in a ref so waiters survive
  // re-renders without restarting.
  const poolRef = useRef<UploadPool>({ active: 0, waiters: [] });

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

      // Desktop: register a session row immediately so the user sees the
      // file appear in the batch grid + sidebar queue, then run the upload
      // through the concurrency pool and patch the row from the result.
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

      // Acquire a slot. Resolves immediately if under the cap, otherwise
      // queues until a prior upload releases.
      const pool = poolRef.current;
      await new Promise<void>((resolve) => {
        if (pool.active < MAX_CONCURRENT_UPLOADS) {
          pool.active += 1;
          resolve();
        } else {
          pool.waiters.push(() => {
            pool.active += 1;
            resolve();
          });
        }
      });

      try {
        const result = await upload(file, initialPayment);
        setSessionUploads((prev) =>
          prev.map((u) =>
            u.id === id
              ? result.ok
                ? {
                    ...u,
                    state: "ready",
                    pct: 100,
                    receiptId: result.receiptId,
                  }
                : {
                    ...u,
                    state: "error",
                    pct: 100,
                    errorMessage: result.message,
                  }
              : u,
          ),
        );
      } finally {
        pool.active -= 1;
        const next = pool.waiters.shift();
        if (next) next();
      }
    },
    [isMobile, upload, initialPayment],
  );

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
