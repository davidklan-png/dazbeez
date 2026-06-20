"use client";

import Link from "next/link";
import { useRef, useState, type ChangeEvent } from "react";
import { Btn } from "@/components/ui/btn";
import { Pill } from "@/components/ui/pill";
import { CameraIcon, CheckIcon, PlusIcon } from "@/components/ui/icons";
import { BeeMark } from "@/components/receipts/ui/bee-mark";
import { ReceiptThumb } from "@/components/receipts/ui/receipt-thumb";
import type { PaymentPath } from "@/lib/receipts/types";
import type { CapturePhase } from "./use-receipt-upload";

export interface CaptureMobileProps {
  initialPayment: PaymentPath | null;
  rapidMode: boolean;
  todayCount: number;
  phase: CapturePhase;
  onPickFile: (file: File) => void;
  onCancel: () => void;
  onReset: () => void;
}

export function CaptureMobile(props: CaptureMobileProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [paymentChip, setPaymentChip] = useState<PaymentPath | null>(props.initialPayment);

  function pickFile() {
    fileRef.current?.click();
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = "";
    props.onPickFile(f);
  }

  return (
    <div className="relative flex h-[calc(100vh-58px)] min-h-[640px] flex-col overflow-hidden bg-gray-50">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={onFile}
        aria-hidden
      />

      {props.phase.kind === "uploading" ? (
        <CaptureUploadingMobile phase={props.phase} onCancel={props.onCancel} />
      ) : props.phase.kind === "saved" ? (
        <CaptureSavedMobile
          phase={props.phase}
          onCaptureNext={pickFile}
          onDone={props.onReset}
        />
      ) : (
        <CaptureIdleMobile
          todayCount={props.todayCount}
          paymentChip={paymentChip}
          setPaymentChip={setPaymentChip}
          onTapCapture={pickFile}
          error={props.phase.kind === "error" ? props.phase.message : null}
        />
      )}

      <MobileBottomNav />
    </div>
  );
}

// ─── IDLE ──────────────────────────────────────────────────────────

function CaptureIdleMobile({
  todayCount,
  paymentChip,
  setPaymentChip,
  onTapCapture,
  error,
}: {
  todayCount: number;
  paymentChip: PaymentPath | null;
  setPaymentChip: (p: PaymentPath | null) => void;
  onTapCapture: () => void;
  error: string | null;
}) {
  return (
    <>
      <MobileHeader queueCount={todayCount} label="Rapid capture" />
      <div className="flex flex-1 flex-col px-5 pt-6">
        <h2 className="text-[26px] font-bold leading-[1.15] tracking-[-0.4px] text-gray-900">
          What did you
          <br />
          just pay for?
        </h2>
        <p className="mt-2 max-w-[280px] text-sm text-gray-500">
          Snap it and keep going. We&rsquo;ll read each one during processing —
          review later.
        </p>

        <div className="mt-5 flex flex-1 items-center justify-center">
          <button
            type="button"
            onClick={onTapCapture}
            className="relative flex h-[220px] w-[220px] flex-col items-center justify-center rounded-full text-white shadow-[0_18px_40px_rgba(217,119,6,0.35),inset_0_-8px_18px_rgba(0,0,0,0.15)] active:scale-[0.98] transition-transform"
            style={{
              background:
                "radial-gradient(circle at 35% 30%, #FBBF24, #D97706 75%)",
            }}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute left-[38px] top-[22px] h-10 w-[90px] rounded-full blur-[2px]"
              style={{
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.5), rgba(255,255,255,0))",
              }}
            />
            <CameraIcon size={54} className="text-white" />
            <span className="mt-2.5 text-[17px] font-bold">Tap to capture</span>
            <span className="mt-0.5 text-xs opacity-85">opens camera</span>
          </button>
        </div>

        <div className="mb-2 flex justify-center gap-2">
          {(["AMEX", "CASH"] as const).map((chip) => {
            const on = paymentChip === chip;
            return (
              <button
                key={chip}
                type="button"
                onClick={() => setPaymentChip(on ? null : chip)}
                aria-pressed={on}
                className={[
                  "rounded-lg border px-4 py-1.5 text-xs font-semibold transition-colors",
                  on
                    ? "border-amber-500 bg-amber-50 text-amber-700"
                    : "border-gray-200 bg-white text-gray-500 hover:text-gray-900",
                ].join(" ")}
              >
                Preselect {chip}
              </button>
            );
          })}
        </div>

        {error && (
          <div className="mb-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-center text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2.5 pb-28">
          <Link
            href="/receipts/review"
            className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3.5 py-3"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-gray-100">
              <PlusIcon size={18} className="text-gray-700" />
            </span>
            <span className="flex-1">
              <span className="block text-[13.5px] font-semibold">
                Open review queue
              </span>
              <span className="block text-[11.5px] text-gray-500">
                Finish anything not yet classified
              </span>
            </span>
          </Link>
          <Link
            href="/receipts/capture?payment=CASH"
            className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3.5 py-3"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-amber-50 text-base">
              💴
            </span>
            <span className="flex-1">
              <span className="block text-[13.5px] font-semibold">
                Cash receipt, no photo
              </span>
              <span className="block text-[11.5px] text-gray-500">
                Type it in 4 fields
              </span>
            </span>
          </Link>
        </div>
      </div>
    </>
  );
}

// ─── UPLOADING ─────────────────────────────────────────────────────

function CaptureUploadingMobile({
  phase,
  onCancel,
}: {
  phase: Extract<CapturePhase, { kind: "uploading" }>;
  onCancel: () => void;
}) {
  const circ = Math.PI * 52;
  const offset = circ * (1 - phase.pct / 100);
  return (
    <div className="flex flex-1 flex-col items-center bg-gray-900 text-white">
      <MobileHeader dark queueCount={null} label="Rapid capture" />

      <div className="mt-5 flex w-[240px] flex-col gap-2 overflow-hidden rounded-[14px] bg-gradient-to-b from-[#fffdf7] to-[#f6f1e2] p-4 text-gray-800 shadow-[0_18px_36px_rgba(0,0,0,0.4)]">
        <div className="text-[11px] font-bold tracking-widest text-gray-900">
          UPLOADING…
        </div>
        <div className="text-[8px] text-gray-500">
          {phase.fileName.slice(0, 28)} · {Math.round(phase.fileSizeBytes / 1024)}{" "}
          KB
        </div>
        <div className="my-1.5 h-px bg-gray-200" />
        <div className="h-[180px] rounded-sm bg-gray-100" />
        <div className="my-1 h-px bg-gray-200" />
        <div className="flex items-center justify-between text-xs font-bold">
          <span>Total</span>
          <span className="tabular-nums">—</span>
        </div>
      </div>

      <div className="mt-7 flex flex-col items-center gap-1.5">
        <div className="relative h-16 w-16">
          <svg width="64" height="64" viewBox="0 0 64 64">
            <circle
              cx="32"
              cy="32"
              r="26"
              stroke="rgba(255,255,255,0.1)"
              strokeWidth="6"
              fill="none"
            />
            <circle
              cx="32"
              cy="32"
              r="26"
              stroke="#F59E0B"
              strokeWidth="6"
              fill="none"
              strokeDasharray={circ}
              strokeDashoffset={offset}
              strokeLinecap="round"
              transform="rotate(-90 32 32)"
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center text-sm font-bold tabular-nums">
            {phase.pct}%
          </div>
        </div>
        <div className="mt-1 text-sm font-semibold">Uploading…</div>
        <div className="text-[11.5px] text-white/55">
          resized from HEIC · queued for processing
        </div>
      </div>

      <div className="flex-1" />
      <div className="w-full px-5 pb-28">
        <Btn
          kind="ghost"
          size="md"
          full
          className="!border-white/10 !bg-white/5 !text-white hover:!bg-white/10"
          onClick={onCancel}
        >
          Cancel upload
        </Btn>
      </div>
    </div>
  );
}

// ─── SAVED ─────────────────────────────────────────────────────────

function CaptureSavedMobile({
  phase,
  onCaptureNext,
  onDone,
}: {
  phase: Extract<CapturePhase, { kind: "saved" }>;
  onCaptureNext: () => void;
  onDone: () => void;
}) {
  // ADR 0001: extraction is deferred to the queue. There is nothing to review
  // here — just confirm the capture and re-arm for the next shot.
  return (
    <>
      <MobileHeader queueCount={null} label="Captured" />

      <div className="flex flex-1 flex-col items-center px-5 pt-10 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500 shadow-[0_8px_20px_rgba(16,185,129,0.35)]">
          <CheckIcon size={34} className="text-white" />
        </div>
        <div className="mt-4 text-[22px] font-bold leading-[1.1] text-gray-900">
          Captured.
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Pill tone="amber" size="sm" dot>
            Pending processing
          </Pill>
          <span className="text-xs text-gray-400">
            {phase.receiptId.slice(0, 8)}…
          </span>
        </div>
        <p className="mt-3 max-w-[260px] text-sm text-gray-500">
          Saved to the queue. We&rsquo;ll read it during processing — review and
          fix anything later.
        </p>

        <div className="mt-6 flex w-[120px] justify-center">
          <ReceiptThumb size={96} merchant="Receipt" amount="—" />
        </div>

        <div className="flex-1" />
        <div className="flex w-full flex-col gap-2.5 pb-28">
          <Btn
            kind="primary"
            size="lg"
            full
            leftIcon={<CameraIcon size={18} className="text-white" />}
            onClick={onCaptureNext}
          >
            Capture next
          </Btn>
          <div className="flex gap-2">
            <Btn kind="ghost" size="md" className="flex-1" onClick={onDone}>
              Done
            </Btn>
            <Link
              href={phase.reviewUrl}
              className="flex h-9 flex-1 items-center justify-center rounded-lg border border-gray-200 bg-white px-3.5 text-[13px] font-semibold text-gray-700 hover:bg-gray-50"
            >
              Open detail
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Header & nav ──────────────────────────────────────────────────

function MobileHeader({
  queueCount,
  label,
  dark = false,
}: {
  queueCount: number | null;
  label: string;
  dark?: boolean;
}) {
  return (
    <div
      className={[
        "flex items-center justify-between px-5 pt-3",
        dark ? "text-white/85" : "text-gray-700",
      ].join(" ")}
    >
      <div className="flex items-center gap-2">
        <BeeMark size={22} />
        <span className="text-[13px] font-semibold">{label}</span>
      </div>
      {queueCount !== null && (
        <div
          className={[
            "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs",
            dark
              ? "border border-white/10 bg-white/5"
              : "border border-gray-200 bg-white",
          ].join(" ")}
        >
          <span className="h-[7px] w-[7px] rounded-full bg-amber-500" />
          <span className="font-semibold tabular-nums">{queueCount}</span>
          <span className={dark ? "text-white/55" : "text-gray-500"}>today</span>
        </div>
      )}
    </div>
  );
}

function MobileBottomNav() {
  const items = [
    { href: "/receipts/capture?mode=rapid", label: "Capture", icon: "📷", active: true },
    { href: "/receipts/review", label: "Review", icon: "📄", active: false },
    { href: "/receipts", label: "Dashboard", icon: "🏠", active: false },
  ];
  return (
    <div className="pointer-events-auto absolute inset-x-4 bottom-6 z-10 flex gap-1 rounded-[18px] border border-gray-200 bg-white/95 p-1.5 shadow-[0_10px_30px_rgba(0,0,0,0.18)] backdrop-blur-xl">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={[
            "flex flex-1 flex-col items-center gap-0.5 rounded-xl px-0 py-2 text-[10.5px]",
            item.active
              ? "bg-amber-50 font-semibold text-gray-900"
              : "font-medium text-gray-400",
          ].join(" ")}
        >
          <span className="text-base leading-none">{item.icon}</span>
          <span>{item.label}</span>
        </Link>
      ))}
    </div>
  );
}
