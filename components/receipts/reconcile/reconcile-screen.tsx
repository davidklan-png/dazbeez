"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Btn } from "@/components/ui/btn";
import { Card } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { Field, SelectInput, TextInput } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckIcon,
  LinkIcon,
  LockIcon,
  WarningIcon,
} from "@/components/ui/icons";
import { ReceiptThumb } from "@/components/receipts/ui/receipt-thumb";
import { useKeyboardShortcuts } from "@/lib/receipts/keyboard";
import {
  EXPENSE_CATEGORIES,
  requiresAttendees as categoryRequiresAttendees,
  formatCategoryLabel,
} from "@/lib/receipts/categories";
import { normalizeDescription } from "@/lib/receipts/reconciliation";
import type {
  AmexBusinessTripStatus,
  AmexReceiptStatus,
  AmexStatementLine,
  ReceiptRecord,
  ReconciliationMatch,
} from "@/lib/receipts/types";
import type { StatementWindow } from "@/lib/receipts/statement-window";
import type { MonthOption } from "@/components/receipts/month-switcher";

export interface ReconcileScreenProps {
  amexLines: AmexStatementLine[];
  receipts: ReceiptRecord[];
  autoMatches: ReconciliationMatch[];
  orphanReceipts: ReceiptRecord[];
  month: string;
  monthLabel: string;
  monthsAvailable: MonthOption[];
  finalized: boolean;
  finalizedAt?: string | null;
  window: StatementWindow | null;
  receiptsInWindow: ReceiptRecord[];
}

type ConfidenceBand = "obvious" | "likely" | "review" | "none";

const BAND_THRESHOLDS: Record<ConfidenceBand, [number, number]> = {
  obvious: [0.92, 1],
  likely: [0.7, 0.9199],
  review: [0.01, 0.6999],
  none: [0, 0],
};

const BAND_COLORS: Record<
  ConfidenceBand,
  { dot: string; label: string; tone: "green" | "amber" | "red" | "gray" }
> = {
  obvious: { dot: "bg-green-500", label: "Obvious", tone: "green" },
  likely: { dot: "bg-amber-500", label: "Likely", tone: "amber" },
  review: { dot: "bg-red-500", label: "Review", tone: "red" },
  none: { dot: "bg-gray-300", label: "No match", tone: "gray" },
};

type Tab = "lines" | "orphans" | "trips";

export function ReconcileScreen(props: ReconcileScreenProps) {
  const router = useRouter();
  const [activeId, setActiveId] = useState<string | null>(
    () => props.amexLines[0]?.id ?? null,
  );
  const [tab, setTab] = useState<Tab>("lines");
  const [busy, setBusy] = useState<string | null>(null);
  const [signoffBusy, setSignoffBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmType, setConfirmType] = useState<string>("");
  const [showFinalizeModal, setShowFinalizeModal] = useState(false);

  const locked = props.finalized;

  const matchMap = useMemo(
    () => new Map(props.autoMatches.map((m) => [m.amexLineId, m])),
    [props.autoMatches],
  );
  const receiptMap = useMemo(
    () => new Map(props.receipts.map((r) => [r.id, r])),
    [props.receipts],
  );

  const linesWithBand = useMemo(
    () =>
      props.amexLines.map((line) => ({
        line,
        band: bandForLine(line, matchMap.get(line.id)),
        match: matchMap.get(line.id),
      })),
    [props.amexLines, matchMap],
  );

  const counts = useMemo(() => {
    const confirmed = props.amexLines.filter(
      (l) => l.match_status === "confirmed" || l.match_status === "no_receipt",
    ).length;
    const obvious = linesWithBand.filter(
      (l) => l.band === "obvious" && l.line.match_status !== "confirmed",
    ).length;
    const likely = linesWithBand.filter((l) => l.band === "likely").length;
    const review = linesWithBand.filter((l) => l.band === "review").length;
    const noMatch = linesWithBand.filter(
      (l) => l.band === "none" && l.line.match_status === "unmatched",
    ).length;
    return {
      total: props.amexLines.length,
      confirmed,
      obvious,
      likely,
      review,
      noMatch,
      orphan: props.orphanReceipts.length,
    };
  }, [props.amexLines, props.orphanReceipts.length, linesWithBand]);

  const active = activeId
    ? linesWithBand.find((l) => l.line.id === activeId) ?? null
    : null;

  // ─── API actions ────────────────────────────────────────────────────
  const reconcile = useCallback(
    async (
      amexLineId: string,
      receiptId: string | null,
      matchStatus: "matched" | "confirmed" | "unmatched" | "no_receipt",
    ) => {
      if (locked) return;
      setBusy(amexLineId);
      setError(null);
      try {
        const res = await fetch("/api/receipts/reconcile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amexLineId, receiptId, matchStatus }),
        });
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(json.error ?? "Reconcile failed.");
          return;
        }
        router.refresh();
      } catch {
        setError("Network error.");
      } finally {
        setBusy(null);
      }
    },
    [locked, router],
  );

  const updateCategory = useCallback(
    async (lineId: string, code: string) => {
      if (locked) return;
      setBusy(lineId);
      setError(null);
      try {
        const res = await fetch(`/api/receipts/amex/lines/${lineId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expenseCategoryCode: code }),
        });
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(json.error ?? "Could not save category.");
          return;
        }
        router.refresh();
      } catch {
        setError("Network error.");
      } finally {
        setBusy(null);
      }
    },
    [locked, router],
  );

  const updateLineDetails = useCallback(
    async (
      lineId: string,
      body: {
        receiptStatus?: AmexReceiptStatus;
        receiptMissingReason?: string | null;
        businessTripStatus?: AmexBusinessTripStatus;
      },
    ) => {
      if (locked) return;
      setBusy(lineId);
      setError(null);
      try {
        const res = await fetch(`/api/receipts/amex/lines/${lineId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(json.error ?? "Could not save line details.");
          return;
        }
        router.refresh();
      } catch {
        setError("Network error.");
      } finally {
        setBusy(null);
      }
    },
    [locked, router],
  );

  const bulkConfirmObvious = useCallback(async () => {
    if (locked) return;
    const candidates = linesWithBand.filter(
      (l) =>
        l.band === "obvious" &&
        l.match &&
        l.line.match_status !== "confirmed",
    );
    if (candidates.length === 0) return;
    setBulkProgress({ current: 0, total: candidates.length });
    for (let i = 0; i < candidates.length; i++) {
      setBulkProgress({ current: i + 1, total: candidates.length });
      const c = candidates[i]!;
      try {
        await fetch("/api/receipts/reconcile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amexLineId: c.line.id,
            receiptId: c.match!.receiptId,
            matchStatus: "confirmed",
          }),
        });
      } catch {
        // continue
      }
    }
    setBulkProgress(null);
    router.refresh();
  }, [locked, linesWithBand, router]);

  const finalize = useCallback(async () => {
    if (locked) return;
    if (confirmType.toLowerCase().trim() !== props.month.toLowerCase()) return;
    setSignoffBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/receipts/reconcile/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month: props.month }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        blockers?: string[];
      };
      if (!res.ok) {
        setError(
          json.blockers?.length
            ? `${json.error ?? "Blocked"}: ${json.blockers.join("; ")}`
            : json.error ?? "Sign-off failed.",
        );
        return;
      }
      setShowFinalizeModal(false);
      router.refresh();
    } catch {
      setError("Network error during sign-off.");
    } finally {
      setSignoffBusy(false);
    }
  }, [locked, confirmType, props.month, router]);

  // ─── Keyboard ───────────────────────────────────────────────────────
  useKeyboardShortcuts({
    j: () => moveActive(1),
    k: () => moveActive(-1),
    arrowdown: () => moveActive(1),
    arrowup: () => moveActive(-1),
    c: () => {
      if (!active || !active.match) return;
      reconcile(active.line.id, active.match.receiptId, "confirmed");
    },
    n: () => {
      if (!active) return;
      reconcile(active.line.id, null, "no_receipt");
    },
    u: () => {
      if (!active) return;
      reconcile(active.line.id, null, "unmatched");
    },
  });

  function moveActive(delta: number) {
    if (linesWithBand.length === 0) return;
    const idx = activeId
      ? linesWithBand.findIndex((l) => l.line.id === activeId)
      : 0;
    const next = linesWithBand[(idx + delta + linesWithBand.length) % linesWithBand.length];
    if (next) setActiveId(next.line.id);
  }

  // ─── Months nav ─────────────────────────────────────────────────────
  const monthIdx = props.monthsAvailable.findIndex((m) => m.month === props.month);
  const prevMonth = monthIdx > 0 ? props.monthsAvailable[monthIdx - 1]!.month : null;
  const nextMonth =
    monthIdx >= 0 && monthIdx < props.monthsAvailable.length - 1
      ? props.monthsAvailable[monthIdx + 1]!.month
      : null;

  return (
    <div className="flex h-[calc(100vh-58px)] min-h-[680px] flex-col bg-gray-50">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-4 border-b border-gray-200 bg-white px-8 py-3.5">
        <div className="flex items-center gap-1">
          <MonthNavBtn href={prevMonth ? `?month=${prevMonth}` : null}>
            <ChevronLeftIcon size={14} className="text-gray-500" />
          </MonthNavBtn>
          <div className="px-3 py-1.5 text-[15px] font-bold text-gray-900">
            {props.monthLabel}
          </div>
          <MonthNavBtn href={nextMonth ? `?month=${nextMonth}` : null}>
            <ChevronRightIcon size={14} className="text-gray-500" />
          </MonthNavBtn>
        </div>

        <div className="flex flex-1 min-w-[260px] items-center gap-2.5">
          <span className="text-[13px] font-semibold tabular-nums text-gray-900">
            {counts.confirmed} of {counts.total} confirmed
          </span>
          <div className="flex h-2 max-w-[320px] flex-1 overflow-hidden rounded bg-gray-100">
            <div
              className="bg-green-500"
              style={{
                width: `${counts.total ? (counts.confirmed / counts.total) * 100 : 0}%`,
              }}
            />
            <div
              className="bg-amber-500"
              style={{
                width: `${counts.total ? (counts.likely / counts.total) * 100 : 0}%`,
              }}
            />
            <div
              className="bg-red-500"
              style={{
                width: `${counts.total ? (counts.review / counts.total) * 100 : 0}%`,
              }}
            />
          </div>
          <div className="flex gap-3 text-[11.5px] text-gray-500">
            <span>
              <b className="text-green-700">{counts.obvious}</b> obvious
            </span>
            <span>
              <b className="text-amber-700">{counts.likely}</b> likely
            </span>
            <span>
              <b className="text-red-600">{counts.review}</b> review
            </span>
            <span>
              <b className="text-gray-700">{counts.orphan}</b> orphan
            </span>
          </div>
        </div>

        {!locked && (
          <Btn
            kind="ghost"
            size="md"
            onClick={bulkConfirmObvious}
            disabled={counts.obvious === 0 || bulkProgress !== null}
          >
            {bulkProgress
              ? `Confirming ${bulkProgress.current}/${bulkProgress.total}…`
              : "Bulk confirm ≥92%"}
          </Btn>
        )}
        {locked ? (
          <Pill tone="green" size="md" dot>
            Reconciled · locked
          </Pill>
        ) : (
          <Btn
            kind="dark"
            size="md"
            disabled={counts.confirmed < counts.total}
            onClick={() => setShowFinalizeModal(true)}
            rightIcon={<LockIcon size={14} className="text-white" />}
          >
            Finalize reconciliation
          </Btn>
        )}
      </div>

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-8 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[540px_minmax(0,1fr)]">
        <LinesPane
          linesWithBand={linesWithBand}
          activeId={activeId}
          setActiveId={setActiveId}
          tab={tab}
          setTab={setTab}
          counts={counts}
          orphanReceipts={props.orphanReceipts}
        />
        <DetailPane
          active={active}
          receiptMap={receiptMap}
          locked={locked}
          busyLineId={busy}
          onConfirm={(line, receiptId) =>
            reconcile(line.id, receiptId, "confirmed")
          }
          onUnlink={(line) => reconcile(line.id, null, "unmatched")}
          onNoReceipt={(line) => reconcile(line.id, null, "no_receipt")}
          onUpdateCategory={updateCategory}
          onUpdateLineDetails={updateLineDetails}
        />
      </div>

      {/* Finalize modal */}
      {showFinalizeModal && !locked && (
        <FinalizeModal
          month={props.month}
          monthLabel={props.monthLabel}
          confirmType={confirmType}
          setConfirmType={setConfirmType}
          onClose={() => {
            setShowFinalizeModal(false);
            setConfirmType("");
          }}
          onFinalize={finalize}
          busy={signoffBusy}
        />
      )}
    </div>
  );
}

// ─── Lines pane ──────────────────────────────────────────────────────

function LinesPane({
  linesWithBand,
  activeId,
  setActiveId,
  tab,
  setTab,
  counts,
  orphanReceipts,
}: {
  linesWithBand: Array<{
    line: AmexStatementLine;
    band: ConfidenceBand;
    match: ReconciliationMatch | undefined;
  }>;
  activeId: string | null;
  setActiveId: (id: string) => void;
  tab: Tab;
  setTab: (t: Tab) => void;
  counts: {
    review: number;
    likely: number;
    obvious: number;
    confirmed: number;
    noMatch: number;
    orphan: number;
  };
  orphanReceipts: ReceiptRecord[];
}) {
  const groupReview = linesWithBand.filter(
    (l) =>
      (l.band === "review" || l.band === "none") &&
      l.line.match_status !== "confirmed",
  );
  const groupLikely = linesWithBand.filter(
    (l) => l.band === "likely" && l.line.match_status !== "confirmed",
  );
  const groupObvious = linesWithBand.filter(
    (l) => l.band === "obvious" && l.line.match_status !== "confirmed",
  );
  const groupConfirmed = linesWithBand.filter(
    (l) => l.line.match_status === "confirmed",
  );

  return (
    <div className="flex h-full flex-col overflow-hidden border-r border-gray-200 bg-white">
      <div className="flex items-center gap-1 border-b border-gray-150 px-3 py-2">
        {(
          [
            { id: "lines" as const, label: "AMEX lines", n: linesWithBand.length },
            { id: "orphans" as const, label: "Orphan receipts", n: counts.orphan },
            { id: "trips" as const, label: "Business trips", n: 0 },
          ] as const
        ).map((t) => {
          const on = t.id === tab;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={[
                "flex items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-[12.5px] transition-colors",
                on
                  ? "bg-gray-900 font-semibold text-white"
                  : "font-medium text-gray-500 hover:text-gray-900",
              ].join(" ")}
            >
              <span>{t.label}</span>
              <span
                className={[
                  "rounded-full px-1.5 text-[10.5px]",
                  on ? "bg-white/20 text-white" : "bg-gray-100 text-gray-600",
                ].join(" ")}
              >
                {t.n}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-auto">
        {tab === "lines" && (
          <>
            {groupReview.length > 0 && (
              <SectionHeader label="Needs review" count={groupReview.length} dot="bg-red-500" />
            )}
            {groupReview.map((l) => (
              <LineRow
                key={l.line.id}
                lwb={l}
                active={activeId === l.line.id}
                onClick={() => setActiveId(l.line.id)}
              />
            ))}
            {groupLikely.length > 0 && (
              <SectionHeader label="Likely matches" count={groupLikely.length} dot="bg-amber-500" />
            )}
            {groupLikely.map((l) => (
              <LineRow
                key={l.line.id}
                lwb={l}
                active={activeId === l.line.id}
                onClick={() => setActiveId(l.line.id)}
              />
            ))}
            {groupObvious.length > 0 && (
              <SectionHeader
                label="Obvious matches · auto-confirm available"
                count={groupObvious.length}
                dot="bg-green-500"
              />
            )}
            {groupObvious.map((l) => (
              <LineRow
                key={l.line.id}
                lwb={l}
                active={activeId === l.line.id}
                onClick={() => setActiveId(l.line.id)}
              />
            ))}
            {groupConfirmed.length > 0 && (
              <SectionHeader
                label="Confirmed"
                count={groupConfirmed.length}
                dot="bg-gray-300"
              />
            )}
            {groupConfirmed.map((l) => (
              <LineRow
                key={l.line.id}
                lwb={l}
                active={activeId === l.line.id}
                onClick={() => setActiveId(l.line.id)}
              />
            ))}
            {linesWithBand.length === 0 && (
              <div className="px-6 py-10 text-center text-sm text-gray-400">
                No AMEX lines for this month. <br />
                <Link
                  href="/receipts/amex"
                  className="mt-2 inline-block text-amber-700 hover:text-amber-800"
                >
                  Import a CSV →
                </Link>
              </div>
            )}
          </>
        )}
        {tab === "orphans" && <OrphansList receipts={orphanReceipts} />}
        {tab === "trips" && (
          <div className="px-6 py-10 text-center text-sm text-gray-400">
            Business trip detection runs at import time. No candidates for this
            month.
          </div>
        )}
      </div>
    </div>
  );
}

function SectionHeader({
  label,
  count,
  dot,
}: {
  label: string;
  count: number;
  dot: string;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-gray-150 bg-gray-50 px-4 pb-1.5 pt-2.5 text-[11px] font-bold uppercase tracking-[0.05em] text-gray-500">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <span>{label}</span>
      <span className="text-gray-400">· {count}</span>
    </div>
  );
}

function LineRow({
  lwb,
  active,
  onClick,
}: {
  lwb: {
    line: AmexStatementLine;
    band: ConfidenceBand;
    match: ReconciliationMatch | undefined;
  };
  active: boolean;
  onClick: () => void;
}) {
  const { line, band, match } = lwb;
  const color = BAND_COLORS[band];
  const receiptId = line.matched_receipt_id ?? match?.receiptId ?? null;
  const confirmed = line.match_status === "confirmed";
  const noReceipt = line.match_status === "no_receipt";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={[
        "flex w-full items-center gap-2.5 border-b border-gray-100 px-4 py-2.5 text-left transition-colors",
        active
          ? "border-l-[3px] border-l-amber-500 bg-amber-50"
          : "border-l-[3px] border-l-transparent hover:bg-gray-50",
      ].join(" ")}
    >
      <div className="flex min-w-[28px] flex-col items-center gap-0.5">
        <span className={`h-2 w-2 rounded-full ${color.dot}`} />
        {match && (
          <span className="text-[9px] font-semibold tabular-nums text-gray-500">
            {Math.round(match.confidenceScore * 100)}%
          </span>
        )}
      </div>

      {receiptId ? (
        <ReceiptThumb
          size={28}
          merchant={line.merchant.slice(0, 8)}
          amount={`¥${Math.round(line.amount_minor / 1000)}k`}
        />
      ) : (
        <div className="flex h-[35px] w-7 shrink-0 items-center justify-center rounded-[4px] border border-dashed border-gray-300">
          <WarningIcon size={14} className="text-gray-400" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="max-w-[220px] truncate text-[13px] font-semibold text-gray-900">
            {line.merchant}
          </span>
          <span className="text-[11px] text-gray-500">
            {line.transaction_date}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          {line.expense_category_code ? (
            <span className="text-[11px] text-gray-500">
              {formatCategoryLabel(line.expense_category_code)}
            </span>
          ) : (
            <span className="text-[11px] font-medium text-amber-700">
              needs category
            </span>
          )}
          {noReceipt && (
            <Pill tone="gray" size="sm">
              no receipt expected
            </Pill>
          )}
          {confirmed && !noReceipt && (
            <Pill tone="green" size="sm">
              confirmed
            </Pill>
          )}
          {line.re_review_needed ? (
            <Pill tone="amber" size="sm">
              re-review
            </Pill>
          ) : null}
          {!confirmed && !noReceipt && band === "none" && (
            <Pill tone="red" size="sm" dot>
              no match
            </Pill>
          )}
        </div>
      </div>

      <div className="text-right">
        <div className="text-[13px] font-semibold tabular-nums text-gray-900">
          {formatJpy(line.amount_minor, line.currency)}
        </div>
        <div className="mt-0.5 text-[10.5px] text-gray-400">
          {line.cardholder_name ?? "AMEX"}
        </div>
      </div>
    </button>
  );
}

function OrphansList({
  receipts,
}: {
  receipts: ReceiptRecord[];
}) {
  if (receipts.length === 0) {
    return (
      <div className="px-6 py-10 text-center text-sm text-gray-400">
        No orphan receipts for this window.
      </div>
    );
  }
  return (
    <div>
      <SectionHeader label="Receipts with no matching AMEX line" count={receipts.length} dot="bg-gray-400" />
      {receipts.map((r) => (
        <div
          key={r.id}
          className="flex items-center gap-3 border-b border-gray-100 px-4 py-3"
        >
          <ReceiptThumb
            size={28}
            merchant={(r.merchant ?? "RECEIPT").slice(0, 8)}
            amount={formatJpy(r.amount_minor ?? 0, r.currency)}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-gray-900">
              {r.merchant ?? "Unnamed receipt"}
            </div>
            <div className="text-[11px] text-gray-500">
              {r.transaction_date ?? "(no date)"}
            </div>
          </div>
          <Link
            href={`/receipts/review/${r.id}`}
            className="text-[12px] font-semibold text-amber-700 hover:text-amber-800"
          >
            Open ↗
          </Link>
        </div>
      ))}
    </div>
  );
}

// ─── Detail pane ─────────────────────────────────────────────────────

function DetailPane({
  active,
  receiptMap,
  locked,
  busyLineId,
  onConfirm,
  onUnlink,
  onNoReceipt,
  onUpdateCategory,
  onUpdateLineDetails,
}: {
  active: {
    line: AmexStatementLine;
    band: ConfidenceBand;
    match: ReconciliationMatch | undefined;
  } | null;
  receiptMap: Map<string, ReceiptRecord>;
  locked: boolean;
  busyLineId: string | null;
  onConfirm: (line: AmexStatementLine, receiptId: string) => void;
  onUnlink: (line: AmexStatementLine) => void;
  onNoReceipt: (line: AmexStatementLine) => void;
  onUpdateCategory: (lineId: string, code: string) => void;
  onUpdateLineDetails: (
    lineId: string,
    body: {
      receiptStatus?: AmexReceiptStatus;
      receiptMissingReason?: string | null;
      businessTripStatus?: AmexBusinessTripStatus;
    },
  ) => void;
}) {
  if (!active) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50 text-sm text-gray-500">
        Select an AMEX line from the left pane.
      </div>
    );
  }

  const { line, band, match } = active;
  const receiptId = line.matched_receipt_id ?? match?.receiptId ?? null;
  const receipt = receiptId ? receiptMap.get(receiptId) ?? null : null;
  const color = BAND_COLORS[band];
  const busy = busyLineId === line.id;
  const showNoReceiptFields =
    line.match_status === "no_receipt" ||
    line.receipt_status === "no_receipt_required" ||
    line.receipt_status === "receipt_not_available";

  return (
    <div className="h-full overflow-auto bg-gray-50 p-6">
      {/* Comparison card */}
      <Card pad={0}>
        <div className="flex items-center gap-2.5 border-b border-gray-150 px-5 py-4">
          <Pill tone={color.tone} size="md" dot>
            {match
              ? `${color.label} match · ${Math.round(match.confidenceScore * 100)}%`
              : line.match_status === "confirmed"
                ? "Confirmed"
                : line.match_status === "no_receipt"
                  ? "No receipt expected"
                  : color.label}
          </Pill>
          <span className="text-[13px] text-gray-500">
            {match?.matchReasons.join(", ") || matchExplanation(line, receipt)}
          </span>
          <span className="flex-1" />
          <Kbd>e</Kbd>
          <span className="text-[11px] text-gray-500">edit</span>
        </div>

        <div className="grid grid-cols-[1fr_36px_1fr] gap-3.5 p-5">
          <div>
            <SideHeader>From AMEX statement</SideHeader>
            <KV k="Merchant" v={line.merchant} highlight />
            <KV k="Posted" v={`${line.posting_date ?? line.transaction_date}`} />
            <KV
              k="Amount"
              v={formatJpy(line.amount_minor, line.currency)}
              mono
            />
            <KV k="Card" v={line.cardholder_name ?? "AMEX"} />
            <KV k="Reference" v={line.amex_reference || "—"} mono />
          </div>

          <div className="flex items-center justify-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500 text-white shadow-[0_2px_8px_rgba(217,119,6,0.3)]">
              <LinkIcon size={16} className="text-white" />
            </div>
          </div>

          {receipt ? (
            <div>
              <div className="mb-2.5 flex items-center justify-between">
                <SideHeader>
                  Matched receipt R-{receipt.id.slice(0, 8)}
                </SideHeader>
                <Link
                  href={`/receipts/review/${receipt.id}`}
                  className="text-[11px] font-semibold text-amber-700 hover:text-amber-800"
                >
                  Pick different
                </Link>
              </div>
              <KV k="Merchant" v={receipt.merchant ?? "—"} highlight />
              <KV
                k="Date"
                v={receipt.transaction_date ?? receipt.captured_at.slice(0, 10)}
              />
              <KV
                k="Amount"
                v={formatJpy(receipt.amount_minor ?? 0, receipt.currency)}
                mono
              />
              <KV
                k="Captured by"
                v={`${receipt.source} · ${receipt.captured_by}`}
              />
              <KV
                k="Currency"
                v={receipt.currency || "JPY"}
                mono
              />
            </div>
          ) : (
            <div>
              <SideHeader>No receipt</SideHeader>
              <div className="rounded-lg border border-dashed border-gray-300 bg-white px-3.5 py-4 text-[12.5px] text-gray-500">
                Nothing is linked. Mark this line as &ldquo;no receipt expected&rdquo;
                or open the orphan-receipts tab to link one.
              </div>
            </div>
          )}
        </div>

        {receipt &&
          line.merchant &&
          receipt.merchant &&
          normalizeDescription(line.merchant) !==
            normalizeDescription(receipt.merchant) && (
            <div className="flex items-center gap-2 px-5 pb-4">
              <ReceiptThumb
                size={48}
                merchant={(receipt.merchant ?? "RECEIPT").slice(0, 8)}
                amount={formatJpy(receipt.amount_minor ?? 0, receipt.currency)}
              />
              <div className="flex flex-1 items-center gap-2 rounded-lg bg-gray-50 px-3 py-2.5 text-[12px] text-gray-600">
                <WarningIcon size={14} className="text-amber-600" />
                <span>
                  Merchant strings differ. Confirming will rename receipt
                  &ldquo;{receipt.merchant}&rdquo; → &ldquo;{line.merchant}&rdquo;.
                </span>
              </div>
            </div>
          )}

        <div className="flex flex-wrap items-center gap-2 border-t border-gray-150 px-5 py-4">
          {receipt && (line.match_status !== "confirmed" || line.re_review_needed) && !locked && (
            <>
              <Btn
                kind="primary"
                size="md"
                onClick={() => onConfirm(line, receipt.id)}
                disabled={busy}
                leftIcon={<CheckIcon size={14} className="text-white" />}
              >
                {line.re_review_needed ? "Reconfirm match" : "Confirm match"}
              </Btn>
              <span className="text-[11px] text-gray-400">
                <Kbd>C</Kbd>
              </span>
            </>
          )}
          {receipt && line.match_status === "confirmed" && !locked && (
            <Btn
              kind="ghost"
              size="md"
              onClick={() => onUnlink(line)}
              disabled={busy}
            >
              Unlink
            </Btn>
          )}
          {!locked && line.match_status !== "no_receipt" && (
            <>
              <Btn
                kind="ghost"
                size="md"
                onClick={() => onNoReceipt(line)}
                disabled={busy}
              >
                Mark &ldquo;no receipt expected&rdquo;
              </Btn>
              <span className="text-[11px] text-gray-400">
                <Kbd>N</Kbd>
              </span>
            </>
          )}
          <span className="flex-1" />
          {receipt && (
            <Link
              href={`/receipts/review/${receipt.id}`}
              className="text-[12.5px] font-semibold text-gray-600 hover:text-gray-900"
            >
              Open receipt ↗
            </Link>
          )}
        </div>
      </Card>

      {/* Classification card */}
      <Card pad={0} className="mt-4">
        <div className="flex items-center gap-2.5 border-b border-gray-150 px-5 py-3.5">
          <span className="text-[13.5px] font-semibold text-gray-900">
            Tax-ready classification
          </span>
          {!line.expense_category_code && (
            <Pill tone="amber" size="sm">
              category needed
            </Pill>
          )}
          <span className="flex-1" />
          <span className="text-[11.5px] text-gray-500">
            Auto-saves on change
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3.5 p-5 md:grid-cols-2">
          <Field label="Expense category" required>
            <SelectInput
              disabled={locked}
              value={line.expense_category_code ?? ""}
              onChange={(e) => onUpdateCategory(line.id, e.target.value)}
              options={[
                { value: "", label: "— Select —" },
                ...EXPENSE_CATEGORIES.map((c) => ({
                  value: c.code,
                  label: formatCategoryLabel(c.code),
                })),
              ]}
            />
          </Field>
          <Field label="Tax rate">
            <TextInput value="10% (standard)" readOnly />
          </Field>
          {showNoReceiptFields && (
            <NoReceiptFields
              key={line.id}
              line={line}
              locked={locked}
              onUpdateLineDetails={onUpdateLineDetails}
            />
          )}
          <Field label="Business purpose" hint="optional unless required">
            <TextInput
              value={line.memo ?? ""}
              readOnly
              placeholder="Set on the linked receipt"
            />
          </Field>
          <Field
            label="Attendees"
            hint={
              line.expense_category_code &&
              categoryRequiresAttendees(line.expense_category_code)
                ? "required"
                : "not required for this category"
            }
          >
            <div className="flex min-h-[38px] items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-2 py-2 text-[13px] text-gray-400">
              <span className="flex-1">
                Edit attendees on the linked receipt
              </span>
            </div>
          </Field>
        </div>
      </Card>

      {/* Business trip strip */}
      {line.business_trip_status === "candidate" && (
        <div
          className="mt-4 flex items-center gap-3.5 rounded-xl border border-amber-200 px-5 py-3.5"
          style={{
            background: "linear-gradient(135deg, #FFFBEB, #FEF3C7)",
          }}
        >
          <div className="text-[22px]">🐝</div>
          <div className="flex-1">
            <div className="text-[13px] font-semibold text-gray-900">
              Part of a candidate business trip
            </div>
              <div className="mt-0.5 text-[12px] text-gray-600">
              Linked to a trip cluster. Review & confirm the trip to lock the
              window.
            </div>
          </div>
          {!locked && (
            <div className="flex gap-2">
              <Btn
                kind="primary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  onUpdateLineDetails(line.id, { businessTripStatus: "confirmed" })
                }
              >
                Confirm
              </Btn>
              <Btn
                kind="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  onUpdateLineDetails(line.id, { businessTripStatus: "excluded" })
                }
              >
                Exclude
              </Btn>
            </div>
          )}
        </div>
      )}

      {/* Keyboard hints */}
      <div className="mt-4 flex flex-wrap gap-5 px-3 text-[11.5px] text-gray-500">
        {[
          ["j / k", "next · prev"],
          ["c", "confirm"],
          ["n", "no-receipt"],
          ["u", "unlink"],
          ["e", "edit category"],
          ["?", "all shortcuts"],
        ].map(([keys, label]) => (
          <span
            key={keys + label}
            className="flex items-center gap-1.5"
          >
            {keys.split(" / ").map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
            <span>{label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function NoReceiptFields({
  line,
  locked,
  onUpdateLineDetails,
}: {
  line: AmexStatementLine;
  locked: boolean;
  onUpdateLineDetails: (
    lineId: string,
    body: {
      receiptStatus?: AmexReceiptStatus;
      receiptMissingReason?: string | null;
      businessTripStatus?: AmexBusinessTripStatus;
    },
  ) => void;
}) {
  const [missingReasonDraft, setMissingReasonDraft] = useState(
    line.receipt_missing_reason ?? "",
  );

  const saveMissingReason = () => {
    if (locked || missingReasonDraft === (line.receipt_missing_reason ?? "")) return;
    onUpdateLineDetails(line.id, {
      receiptMissingReason: missingReasonDraft.trim() || null,
    });
  };

  return (
    <>
      <Field label="No-receipt status" required>
        <SelectInput
          disabled={locked}
          value={line.receipt_status}
          onChange={(e) =>
            onUpdateLineDetails(line.id, {
              receiptStatus: e.target.value as AmexReceiptStatus,
            })
          }
          options={[
            { value: "no_receipt_required", label: "No receipt required" },
            { value: "receipt_not_available", label: "Receipt unavailable" },
          ]}
        />
      </Field>
      <Field label="Missing receipt reason" required>
        <TextInput
          disabled={locked}
          value={missingReasonDraft}
          onChange={(e) => setMissingReasonDraft(e.target.value)}
          onBlur={saveMissingReason}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
          placeholder="e.g. card fee, online charge, receipt lost"
        />
      </Field>
    </>
  );
}

function FinalizeModal({
  month,
  monthLabel,
  confirmType,
  setConfirmType,
  onClose,
  onFinalize,
  busy,
}: {
  month: string;
  monthLabel: string;
  confirmType: string;
  setConfirmType: (v: string) => void;
  onClose: () => void;
  onFinalize: () => void;
  busy: boolean;
}) {
  const canFinalize =
    confirmType.trim().toLowerCase() === month.toLowerCase();
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl"
      >
        <div className="flex items-center gap-2.5 border-b border-gray-150 px-5 py-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-900 text-white">
            <LockIcon size={14} className="text-white" />
          </div>
          <div>
            <div className="text-[14px] font-semibold text-gray-900">
              Finalize {monthLabel} reconciliation
            </div>
            <div className="text-[11.5px] text-gray-500">
              Irreversible. Locks all linked receipts.
            </div>
          </div>
        </div>
        <div className="px-5 py-4 text-[13px] text-gray-600">
          <p className="mb-3">Type the month identifier to confirm:</p>
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-sm text-gray-700">
            {month}
          </div>
          <input
            ref={inputRef}
            type="text"
            value={confirmType}
            onChange={(e) => setConfirmType(e.target.value)}
            placeholder={month}
            className="mt-3 h-10 w-full rounded-lg border border-gray-300 bg-white px-3 font-mono text-sm text-gray-900 outline-none focus:border-amber-500"
          />
        </div>
        <div className="flex gap-2 border-t border-gray-150 bg-gray-50 px-5 py-3">
          <Btn kind="ghost" size="md" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <span className="flex-1" />
          <Btn
            kind="dark"
            size="md"
            disabled={!canFinalize || busy}
            onClick={onFinalize}
            rightIcon={<LockIcon size={14} className="text-white" />}
          >
            {busy ? "Finalizing…" : "Finalize"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────

function MonthNavBtn({
  href,
  children,
}: {
  href: string | null;
  children: ReactNode;
}) {
  const cls =
    "flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-gray-200";
  if (!href) {
    return <span className={`${cls} opacity-40`}>{children}</span>;
  }
  return (
    <Link href={href} className={`${cls} hover:bg-gray-50`}>
      {children}
    </Link>
  );
}

function SideHeader({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.05em] text-gray-500">
      {children}
    </div>
  );
}

function KV({
  k,
  v,
  highlight,
  mono,
}: {
  k: string;
  v: ReactNode;
  highlight?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <span className="w-[100px] text-[11.5px] text-gray-500">{k}</span>
      <span
        className={[
          "min-w-0 flex-1 text-[13.5px] leading-[1.4]",
          highlight ? "font-semibold text-gray-900" : "text-gray-900",
          mono ? "font-mono tabular-nums" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {v}
      </span>
    </div>
  );
}

function bandForLine(
  line: AmexStatementLine,
  match: ReconciliationMatch | undefined,
): ConfidenceBand {
  if (!match) {
    if (line.match_status === "confirmed") return "obvious";
    return "none";
  }
  const s = match.confidenceScore;
  if (s >= BAND_THRESHOLDS.obvious[0]) return "obvious";
  if (s >= BAND_THRESHOLDS.likely[0]) return "likely";
  return "review";
}

function matchExplanation(
  line: AmexStatementLine,
  receipt: ReceiptRecord | null,
): string {
  if (!receipt) return "Pick a receipt or mark as no-receipt-expected.";
  if (line.amount_minor !== (receipt.amount_minor ?? 0))
    return "Amount differs — verify before confirming.";
  if (
    line.transaction_date &&
    receipt.transaction_date &&
    line.transaction_date !== receipt.transaction_date
  )
    return "Dates differ slightly — common for late captures.";
  return "Linked match.";
}

function formatJpy(amount: number, currency: string | null): string {
  if (!currency || currency === "JPY") return `¥${amount.toLocaleString()}`;
  return `${(amount / 100).toFixed(2)} ${currency}`;
}
