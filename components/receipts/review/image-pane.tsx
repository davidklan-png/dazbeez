"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { Kbd } from "@/components/ui/kbd";
import {
  DownloadIcon,
  RotateIcon,
  ZoomIcon,
} from "@/components/ui/icons";
import { useKeyboardShortcuts } from "@/lib/receipts/keyboard";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;
const OVERLAY_STORAGE_KEY = "rx.review.ocrOverlay";

export function ImagePane({
  receiptId,
  receiptDisplayId,
  filename,
  fileSizeBytes,
  contentType,
  hasExtraction,
}: {
  receiptId: string;
  receiptDisplayId: string;
  filename: string | null;
  fileSizeBytes: number;
  contentType: string;
  hasExtraction: boolean;
}) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [showOverlay, setShowOverlay] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(OVERLAY_STORAGE_KEY);
    return stored === null ? true : stored === "1";
  });
  const isPdf = contentType === "application/pdf";
  const src = `/api/receipts/${receiptId}/file`;

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(OVERLAY_STORAGE_KEY, showOverlay ? "1" : "0");
  }, [showOverlay]);

  useKeyboardShortcuts({
    o: () => window.open(src, "_blank"),
    r: () => setRotation((r) => (r + 90) % 360),
  });

  return (
    <div className="flex h-full flex-col border-r border-gray-200 bg-gray-100">
      <div className="flex items-center gap-2.5 border-b border-gray-200 bg-white px-4 py-2.5">
        <span className="text-[12.5px] text-gray-500">{receiptDisplayId}</span>
        <span className="h-[3px] w-[3px] rounded-full bg-gray-300" />
        <span className="truncate text-[12.5px] text-gray-500">
          {filename || "(no filename)"} · {(fileSizeBytes / 1024).toFixed(0)} KB
        </span>
        <span className="flex-1" />
        <ToolbarBtn
          label="Zoom in"
          onClick={() =>
            setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100))
          }
          disabled={zoom >= ZOOM_MAX}
        >
          <ZoomIcon size={15} className="text-gray-700" />
        </ToolbarBtn>
        <ToolbarBtn
          label="Rotate"
          onClick={() => setRotation((r) => (r + 90) % 360)}
        >
          <RotateIcon size={15} className="text-gray-700" />
        </ToolbarBtn>
        <a
          href={src}
          download
          aria-label="Download original"
          className="flex h-[30px] w-[30px] items-center justify-center rounded-[7px] border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
        >
          <DownloadIcon size={15} />
        </a>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-auto p-6">
        {isPdf ? (
          <iframe
            src={src}
            title="Receipt PDF"
            className="h-full w-full max-w-[640px] rounded-md border border-gray-200 bg-white"
          />
        ) : (
          <div
            className="relative max-w-[640px] rounded-md bg-white p-2 shadow-[0_12px_36px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.04)]"
            style={{
              transform: `rotate(${rotation}deg) scale(${zoom})`,
              transformOrigin: "center center",
              transition: "transform 0.2s ease",
            }}
          >
            <Image
              src={src}
              alt={`Receipt ${receiptDisplayId}`}
              width={640}
              height={900}
              unoptimized
              className="h-auto w-full"
            />
            {showOverlay && hasExtraction && (
              <>
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-[8%] top-[12%] h-[6%] w-[40%] rounded border-[1.5px] border-amber-500 bg-amber-500/10"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute bottom-[14%] right-[8%] h-[6%] w-[35%] rounded border-[1.5px] border-amber-500 bg-amber-500/10"
                />
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-gray-200 bg-white px-4 py-2 text-[11.5px] text-gray-500">
        <div className="flex items-center gap-1.5">
          <span>Zoom</span>
          <span className="font-semibold tabular-nums text-gray-900">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() =>
              setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100))
            }
            className="ml-1 rounded px-1.5 text-gray-500 hover:bg-gray-100"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => {
              setZoom(1);
              setRotation(0);
            }}
            className="rounded px-1.5 text-gray-500 hover:bg-gray-100"
          >
            reset
          </button>
          {!isPdf && hasExtraction && (
            <>
              <span className="ml-3">OCR overlay</span>
              <button
                type="button"
                onClick={() => setShowOverlay((v) => !v)}
                aria-pressed={showOverlay}
                className="relative inline-flex h-3 w-[22px] items-center rounded-full transition-colors"
                style={{ background: showOverlay ? "#F59E0B" : "#E5E7EB" }}
              >
                <span
                  className="absolute h-2.5 w-2.5 rounded-full bg-white transition-transform"
                  style={{
                    transform: showOverlay ? "translateX(10px)" : "translateX(1px)",
                  }}
                />
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span>Open original</span>
          <Kbd>O</Kbd>
        </div>
      </div>
    </div>
  );
}

function ToolbarBtn({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex h-[30px] w-[30px] items-center justify-center rounded-[7px] border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
