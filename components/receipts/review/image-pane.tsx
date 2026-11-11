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

export function ImagePane({
  receiptId,
  receiptDisplayId,
  filename,
  fileSizeBytes,
  rawText,
}: {
  receiptId: string;
  receiptDisplayId: string;
  filename: string | null;
  fileSizeBytes: number;
  rawText: string | null;
}) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const src = `/api/receipts/${receiptId}/file`;
  const [preview, setPreview] = useState<{
    src: string;
    kind: "pdf" | "image" | "unavailable";
  } | null>(null);
  const kind = preview?.src === src ? preview.kind : null;
  const isPdf = kind === "pdf";

  useEffect(() => {
    const controller = new AbortController();
    // /file can serve a rendered derivative whose MIME differs from the original.
    fetch(src, { method: "HEAD", cache: "no-store", signal: controller.signal })
      .then((response) => {
        const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        const inline = response.ok && !response.redirected &&
          !response.headers.get("content-disposition")?.toLowerCase().startsWith("attachment");
        const kind = !inline ? "unavailable"
          : type === "application/pdf" ? "pdf"
          : ["image/jpeg", "image/png", "image/heic", "image/heif"].includes(type ?? "")
            ? "image" : "unavailable";
        if (!controller.signal.aborted) setPreview({ src, kind });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreview({ src, kind: "unavailable" });
      });
    return () => controller.abort();
  }, [src]);

  useKeyboardShortcuts({
    o: () => window.open(src, "_blank", "noopener,noreferrer"),
    r: () => setRotation((r) => (r + 90) % 360),
  });

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-gray-200 bg-gray-100">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-gray-200 bg-white px-4 py-2.5">
        <span className="text-[12.5px] text-gray-500">{receiptDisplayId}</span>
        <span className="h-[3px] w-[3px] rounded-full bg-gray-300" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-gray-500">
          {filename || "(no filename)"} · {(fileSizeBytes / 1024).toFixed(0)} KB
        </span>
        <ToolbarBtn
          label="Zoom in"
          onClick={() =>
            setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100))
          }
          disabled={kind !== "image" || zoom >= ZOOM_MAX}
        >
          <ZoomIcon size={15} className="text-gray-700" />
        </ToolbarBtn>
        <ToolbarBtn
          label="Rotate"
          disabled={kind !== "image"}
          onClick={() => setRotation((r) => (r + 90) % 360)}
        >
          <RotateIcon size={15} className="text-gray-700" />
        </ToolbarBtn>
        <a
          href={src}
          download
          aria-label="Download file"
          className="flex h-[30px] w-[30px] items-center justify-center rounded-[7px] border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
        >
          <DownloadIcon size={15} />
        </a>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-auto p-6">
        {kind === null ? (
          <p role="status" className="text-sm text-gray-500">Loading file preview…</p>
        ) : kind === "unavailable" ? (
          <p role="status" className="text-center text-sm text-gray-600">
            Preview unavailable. <a href={src} target="_blank" rel="noopener noreferrer" className="text-amber-700 underline">Open file</a>
          </p>
        ) : isPdf ? (
          <iframe
            src={src}
            title="Receipt PDF"
            className="min-h-[400px] h-full w-full max-w-[640px] rounded-md border border-gray-200 bg-white"
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
              onError={() => setPreview({ src, kind: "unavailable" })}
              className="h-auto w-full"
            />
          </div>
        )}
      </div>

      {rawText?.trim() && (
        <details className="border-t border-gray-200 bg-white px-4 py-3 text-xs text-gray-600">
          <summary className="cursor-pointer select-none">Raw extraction text (unverified)</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">{rawText}</pre>
        </details>
      )}

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
            disabled={kind !== "image" || zoom <= ZOOM_MIN}
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
        </div>
        <div className="flex items-center gap-2">
          <a href={src} target="_blank" rel="noopener noreferrer" className="underline">Open file</a>
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
