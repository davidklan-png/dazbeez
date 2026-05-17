"use client";

import Link from "next/link";
import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Btn } from "@/components/ui/btn";
import { Pill } from "@/components/ui/pill";
import {
  ArrowRightIcon,
  LinkIcon,
  UploadIcon,
  WarningIcon,
} from "@/components/ui/icons";
import type { PaymentPath } from "@/lib/receipts/types";
import type { CapturePhase } from "./use-receipt-upload";

export interface CaptureDesktopProps {
  initialPayment: PaymentPath | null;
  phase: CapturePhase;
  onPickFile: (file: File) => void;
  sessionUploads: SessionUpload[];
}

export type SessionUpload = {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  state: "uploading" | "ready" | "review" | "error";
  merchant?: string;
  amount?: string;
  date?: string;
  pct: number;
  receiptId?: string;
  errorMessage?: string;
};

export function CaptureDesktop(props: CaptureDesktopProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function onPick() {
    fileRef.current?.click();
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    files.forEach(props.onPickFile);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    files.forEach(props.onPickFile);
  }

  return (
    <div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf,.eml,.html"
        multiple
        className="sr-only"
        onChange={onFile}
      />

      <DesktopSubHeader />

      <div className="grid min-h-[760px] grid-cols-[1fr_380px] bg-gray-50">
        <div className="flex flex-col gap-5 overflow-auto px-8 py-8">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={[
              "relative flex min-h-[340px] flex-col items-center justify-center rounded-[18px] border-2 border-dashed p-8 text-center transition-colors",
              "bg-white",
              dragOver ? "border-amber-500 bg-amber-50/40" : "border-amber-400",
            ].join(" ")}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-[18px]"
              style={{
                background:
                  "radial-gradient(ellipse at 50% 0%, #FFFBEB 0%, transparent 60%)",
              }}
            />
            <div className="relative flex flex-col items-center gap-3.5">
              <div className="relative h-[84px] w-[110px]">
                <FileGlyph kind="PDF" rotate="-9deg" left={6} top={4} />
                <FileGlyph kind="EML" rotate="2deg" left={36} top={0} />
                <FileGlyph kind="PNG" rotate="14deg" left={66} top={2} />
              </div>
              <div className="text-2xl font-bold tracking-[-0.4px] text-gray-900">
                Drop receipts here
              </div>
              <div className="max-w-[480px] text-[13.5px] leading-[1.5] text-gray-500">
                Multi-file is fine. We parse PDFs natively (no OCR pass for
                text-layer PDFs), run Vision for raster images, and try to
                auto-match each one against this month&rsquo;s AMEX statement.
              </div>
              <div className="mt-1.5 flex gap-2.5">
                <Btn
                  kind="primary"
                  size="lg"
                  onClick={onPick}
                  leftIcon={<UploadIcon size={16} className="text-white" />}
                >
                  Choose files…
                </Btn>
                <Btn kind="ghost" size="lg" onClick={onPick}>
                  Paste from clipboard
                </Btn>
              </div>
              <div className="mt-2.5 text-xs text-gray-400">
                Up to 25 files at once · 20&nbsp;MB max per file · HEIC
                auto-converted
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <AltInputCard
              title="Forward by email"
              desc="receipts@dazbeez.app"
              hint="Adds to capture@your-trusted-device"
              cta="Copy address"
              emoji="✉️"
            />
            <AltInputCard
              title="Browser extension"
              desc="Save Stripe / Apple / GCP invoices"
              hint="Chrome · 1-click capture"
              cta="Get extension"
              emoji="🧩"
              comingSoon
            />
            <AltInputCard
              title="Cash receipt, no doc"
              desc="Type 4 fields, attach later"
              hint="Used last month: 7 times"
              cta="New manual receipt"
              emoji="💴"
              href="/receipts/capture?payment=CASH"
            />
          </div>

          <div className="mt-1">
            <div className="mb-2.5 flex items-center gap-2.5">
              <span className="text-[13px] font-semibold text-gray-900">
                This batch · {props.sessionUploads.length} file
                {props.sessionUploads.length === 1 ? "" : "s"}
              </span>
              {countOf(props.sessionUploads, "ready") > 0 && (
                <Pill tone="green" size="sm" dot>
                  {countOf(props.sessionUploads, "ready")} ready
                </Pill>
              )}
              {countOf(props.sessionUploads, "review") > 0 && (
                <Pill tone="amber" size="sm" dot>
                  {countOf(props.sessionUploads, "review")} need review
                </Pill>
              )}
              <span className="flex-1" />
              {props.sessionUploads.length > 0 && (
                <Link
                  href="/receipts/review"
                  className="text-xs font-semibold text-amber-700 hover:text-amber-800"
                >
                  Send all to review →
                </Link>
              )}
            </div>
            {props.sessionUploads.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 bg-white px-6 py-10 text-center text-[13px] text-gray-400">
                Nothing in this batch yet. Drop or pick files above.
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-3">
                {props.sessionUploads.map((u) => (
                  <BatchTile key={u.id} upload={u} />
                ))}
              </div>
            )}
          </div>
        </div>

        <DesktopSidebar uploads={props.sessionUploads} />
      </div>
    </div>
  );
}

function countOf(arr: SessionUpload[], state: SessionUpload["state"]) {
  return arr.filter((u) => u.state === state).length;
}

function DesktopSubHeader() {
  return (
    <div className="flex items-center gap-3.5 border-b border-gray-200 bg-white px-8 py-2.5">
      <span className="text-[13.5px] font-semibold text-gray-900">
        Digital receipts
      </span>
      <span className="hidden text-xs text-gray-500 sm:inline">
        PDFs, e-mail receipts, screenshots — anything that didn&rsquo;t come from
        a camera
      </span>
      <span className="flex-1" />
      <div className="hidden gap-1.5 sm:flex">
        <Pill tone="outline">PDF</Pill>
        <Pill tone="outline">EML / .msg</Pill>
        <Pill tone="outline">PNG · JPG</Pill>
        <Pill tone="outline">HTML</Pill>
      </div>
      <div className="hidden h-[18px] w-px bg-gray-200 sm:block" />
      <Link
        href="/receipts/capture?mode=rapid"
        className="text-[12.5px] font-semibold text-amber-700 hover:text-amber-800"
      >
        Open phone capture →
      </Link>
    </div>
  );
}

function FileGlyph({
  kind,
  rotate,
  left,
  top,
}: {
  kind: "PDF" | "EML" | "PNG";
  rotate: string;
  left: number;
  top: number;
}) {
  const tints: Record<typeof kind, { bg: string; label: string }> = {
    PDF: { bg: "bg-red-100", label: "text-red-600" },
    EML: { bg: "bg-blue-100", label: "text-blue-700" },
    PNG: { bg: "bg-amber-100", label: "text-amber-700" },
  };
  const t = tints[kind];
  return (
    <div
      className="absolute flex h-12 w-[38px] flex-col overflow-hidden rounded-[5px] border border-gray-200 bg-white shadow-[0_4px_10px_rgba(0,0,0,0.06)]"
      style={{ left, top, transform: `rotate(${rotate})` }}
      aria-hidden
    >
      <div className={`h-1 ${t.bg}`} />
      <div className="flex flex-col gap-0.5 px-1 pt-1">
        <div className="h-[1.5px] w-[80%] bg-gray-200" />
        <div className="h-[1.5px] w-[60%] bg-gray-200" />
        <div className="h-[1.5px] w-[70%] bg-gray-200" />
      </div>
      <div className="flex-1" />
      <div
        className={`mx-1 mb-1 rounded-[2px] py-[1px] text-center text-[7.5px] font-bold tracking-[0.05em] ${t.bg} ${t.label}`}
      >
        {kind}
      </div>
    </div>
  );
}

function AltInputCard({
  title,
  desc,
  hint,
  cta,
  emoji,
  href,
  comingSoon,
}: {
  title: string;
  desc: string;
  hint: string;
  cta: string;
  emoji: string;
  href?: string;
  comingSoon?: boolean;
}) {
  const body = (
    <div className="flex flex-col gap-1 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-gray-100 text-[20px]">
          {emoji}
        </div>
        <div className="flex-1">
          <div className="text-[13.5px] font-semibold text-gray-900">{title}</div>
          <div className="text-xs text-gray-500">{desc}</div>
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="flex-1 text-[11.5px] text-gray-400">
          {comingSoon ? "Soon · planned" : hint}
        </span>
        <span className="text-xs font-semibold text-amber-700">
          {comingSoon ? "—" : `${cta} →`}
        </span>
      </div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function BatchTile({ upload }: { upload: SessionUpload }) {
  const isReview = upload.state === "review";
  const isReady = upload.state === "ready";
  const isError = upload.state === "error";
  const isUploading = upload.state === "uploading";

  return (
    <div
      className={[
        "overflow-hidden rounded-xl border bg-white",
        isReview ? "border-amber-200" : isError ? "border-red-200" : "border-gray-200",
      ].join(" ")}
    >
      <div className="relative flex h-[96px] items-center justify-center border-b border-gray-150 bg-gray-50">
        <span className="absolute left-2 top-2 rounded-full bg-amber-100 px-1.5 py-[2px] text-[9.5px] font-bold tracking-[0.05em] text-amber-700">
          UPLOAD
        </span>
        <span className="absolute right-2 top-2">
          {isReady ? (
            <Pill tone="green" size="sm" dot>
              ready
            </Pill>
          ) : isReview ? (
            <Pill tone="amber" size="sm" dot>
              review
            </Pill>
          ) : isError ? (
            <Pill tone="red" size="sm" dot>
              error
            </Pill>
          ) : (
            <Pill tone="amber" size="sm" dot>
              uploading…
            </Pill>
          )}
        </span>
        <div className="text-2xl">📄</div>
        {isUploading && (
          <div className="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-gray-200">
            <div
              className="h-full bg-amber-500"
              style={{ width: `${upload.pct}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 px-3 pb-3 pt-2.5">
        <div className="truncate text-xs font-semibold text-gray-900">
          {upload.merchant || (
            <span className="text-amber-700">Merchant unknown</span>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-1.5">
          <span className="text-[13px] font-bold tabular-nums text-gray-900">
            {upload.amount || "—"}
          </span>
          <span className="text-[11px] text-gray-500">{upload.date || "—"}</span>
        </div>
        <div className="truncate text-[10.5px] text-gray-400" title={upload.fileName}>
          {upload.fileName}
        </div>
        {upload.receiptId ? (
          <Link
            href={`/receipts/review/${upload.receiptId}`}
            className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-green-700 hover:text-green-800"
          >
            <LinkIcon size={11} className="text-green-700" />
            <span>Open review</span>
          </Link>
        ) : isError ? (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-red-600">
            <WarningIcon size={11} className="text-red-600" />
            <span>{upload.errorMessage || "Failed"}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DesktopSidebar({ uploads }: { uploads: SessionUpload[] }) {
  const inFlight = uploads.filter((u) => u.state === "uploading").length;
  return (
    <aside className="flex flex-col overflow-hidden border-l border-gray-200 bg-white">
      <div className="flex items-center gap-2 border-b border-gray-150 px-4 py-3.5">
        <span className="text-[13px] font-semibold text-gray-900">
          Upload queue
        </span>
        {inFlight > 0 ? (
          <Pill tone="amber" size="sm" dot>
            {inFlight} in flight
          </Pill>
        ) : (
          <Pill tone="gray" size="sm">
            idle
          </Pill>
        )}
        <span className="flex-1" />
        <span className="text-[11px] text-gray-400">
          session: {uploads.length} file{uploads.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        {uploads.length === 0 ? (
          <div className="px-5 py-10 text-center text-[12.5px] text-gray-400">
            Files you add will appear here as they upload and parse.
          </div>
        ) : (
          uploads.map((u) => <QueueFileRow key={u.id} upload={u} />)
        )}
      </div>

      <div className="border-t border-gray-150 px-4 py-3.5">
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.05em] text-gray-500">
          Tips
        </div>
        <ul className="flex flex-col gap-1.5 text-xs text-gray-600">
          <li className="flex justify-between">
            <span>HEIC files</span>
            <span className="text-gray-400">auto-converted</span>
          </li>
          <li className="flex justify-between">
            <span>PDF text layer</span>
            <span className="text-gray-400">parsed natively</span>
          </li>
          <li className="flex justify-between">
            <span>Phone capture</span>
            <Link
              href="/receipts/capture?mode=rapid"
              className="font-semibold text-amber-700 hover:text-amber-800"
            >
              Open →
            </Link>
          </li>
        </ul>
      </div>
    </aside>
  );
}

function QueueFileRow({ upload }: { upload: SessionUpload }) {
  const stateLabel = {
    uploading: { color: "text-gray-600", dot: "bg-gray-400", text: "uploading" },
    ready: { color: "text-green-700", dot: "bg-green-500", text: "ready" },
    review: { color: "text-amber-700", dot: "bg-amber-500", text: "needs review" },
    error: { color: "text-red-600", dot: "bg-red-500", text: "failed" },
  }[upload.state];

  return (
    <div className="flex gap-2.5 border-b border-gray-100 px-4 py-3">
      <div className="flex h-[38px] w-[30px] shrink-0 flex-col items-center justify-end overflow-hidden rounded-[4px] border border-gray-200 bg-white pb-[3px]">
        <div className="h-[3px] w-full bg-amber-100" />
        <div className="flex-1" />
        <div className="text-[7px] font-bold tracking-[0.04em] text-amber-700">
          FILE
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-gray-900" title={upload.fileName}>
          {upload.fileName}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-500">
          <span>{Math.round(upload.fileSizeBytes / 1024)} KB</span>
          <span className="h-[3px] w-[3px] rounded-full bg-gray-300" />
          <span
            className={`flex items-center gap-1 font-medium ${stateLabel.color}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${stateLabel.dot}`} />
            {stateLabel.text}
          </span>
        </div>
        {upload.pct < 100 && upload.state === "uploading" && (
          <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full bg-amber-500"
              style={{ width: `${upload.pct}%` }}
            />
          </div>
        )}
      </div>
      {upload.receiptId && (
        <Link
          href={`/receipts/review/${upload.receiptId}`}
          className="self-center text-amber-700 hover:text-amber-800"
        >
          <ArrowRightIcon size={14} />
        </Link>
      )}
    </div>
  );
}
