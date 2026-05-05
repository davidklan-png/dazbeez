"use client";

import { useState } from "react";

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

interface ReceiptImageViewerProps {
  receiptId: string;
  contentType: string;
}

export function ReceiptImageViewer({ receiptId, contentType }: ReceiptImageViewerProps) {
  const [zoom, setZoom] = useState(1);
  const src = `/api/receipts/${receiptId}/file`;
  const isPdf = contentType === "application/pdf";

  function zoomOut() {
    setZoom((z) => Math.max(ZOOM_MIN, +((z - ZOOM_STEP).toFixed(2))));
  }
  function zoomIn() {
    setZoom((z) => Math.min(ZOOM_MAX, +((z + ZOOM_STEP).toFixed(2))));
  }
  function reset() {
    setZoom(1);
  }

  return (
    <div className="space-y-2">
      {/* Controls — images only */}
      {isPdf ? (
        <div className="flex items-center gap-2">
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-amber-600 hover:underline"
          >
            Open PDF ↗
          </a>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={zoomOut}
            disabled={zoom <= ZOOM_MIN}
            className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="min-w-[3.5rem] text-center text-xs text-gray-500">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={zoomIn}
            disabled={zoom >= ZOOM_MAX}
            className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={zoom === 1}
            className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-40"
          >
            Reset
          </button>
        </div>
      )}

      {/* Image / PDF area */}
      <div className="max-h-[70vh] overflow-auto rounded-xl border border-gray-100 bg-gray-50 p-2">
        {isPdf ? (
          <iframe
            src={src}
            className="h-96 w-full rounded-xl border-0"
            title="Receipt PDF"
          />
        ) : (
          // Scale the wrapper width so the scroll container sees the full zoomed
          // layout size, enabling correct horizontal and vertical panning.
          <div style={{ width: `${zoom * 100}%` }}>
            <img
              src={src}
              alt="Receipt"
              className="block h-auto w-full"
            />
          </div>
        )}
      </div>
    </div>
  );
}
