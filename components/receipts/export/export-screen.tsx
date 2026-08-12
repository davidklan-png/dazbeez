"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Btn } from "@/components/ui/btn";
import { Card } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { MonthPipeline } from "@/components/receipts/export/month-pipeline";
import { NextActionCard } from "@/components/receipts/export/next-action-card";
import type { MonthStage } from "@/lib/receipts/month-stage";
import {
  ArrowRightIcon,
  DownloadIcon,
  FileTextIcon,
} from "@/components/ui/icons";
import type { ReceiptExport, ReceiptRecord } from "@/lib/receipts/types";
import type { Blocker } from "@/lib/receipts/blockers";
import { withWorkMonth } from "@/lib/receipts/work-month";

export type { Blocker } from "@/lib/receipts/blockers";

export interface CategoryBreakdownRow {
  code: string;
  label: string;
  count: number;
  totalMinor: number;
  pct: number;
}

export interface ExportScreenProps {
  month: string;
  monthLabel: string;
  currentExport: ReceiptExport | null;
  exports: ReceiptExport[];
  blockers: Blocker[];
  warnings: Blocker[];
  draftStats: {
    rows: number;
    totalMinor: number;
    taxMinor: number;
    receiptsAttached: number;
    receiptsTotal: number;
    eventCount: number;
  };
  breakdown: CategoryBreakdownRow[];
  /** ADR 0008: undated CASH/DIGITAL receipts — can never be assigned to a
   *  calendar month, need operator action. Needs-attention. (ADR 0006's separate
   *  "awaiting statement" bucket is retired — a dated receipt is always
   *  assignable under the calendar rule.) */
  unassignableReceipts: ReceiptRecord[];
  /** The server-derived month-close stages (deriveMonthStage). Drives the shared
   *  MonthPipeline + NextActionCard — the one wayfinding authority across the
   *  export, review, and send surfaces (docs/export-workflow-ux-plan.md §4). */
  stages: MonthStage[];
}

/** ADR 0008: cash/digital receipts not yet in any export-month bundle — both
 * undated (unassignable until a date is set) and dated-but-unassigned (assignment
 * slipped past the capture/classification hook). Deep-linked to the review view
 * so the residue is visible on the screen where it gets fixed. */
function UnassignedReceiptsSection({
  unassignable,
  month,
}: {
  unassignable: ReceiptRecord[];
  /** Concrete work month, carried into each receipt's Review deep-link. */
  month: string;
}) {
  if (unassignable.length === 0) return null;
  return (
    <Card>
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-semibold text-red-700">
          Unassigned — not in any export month
        </div>
        <Pill tone="red" size="sm">{unassignable.length}</Pill>
      </div>
      <p className="mt-1 text-[12px] text-gray-500">
        Cash/digital receipts with no statement-month assignment. Open each to set a transaction date (if missing) or assign it to an export month.
      </p>
      <ul className="mt-2 space-y-0.5 text-[12.5px]">
        {unassignable.map((r) => (
          <li key={r.id}>
            <Link
              href={withWorkMonth(`/receipts/review/${r.id}`, month)}
              className="text-amber-700 hover:underline"
            >
              {r.merchant ?? `R-${r.id.slice(0, 8)}`} ·{" "}
              {r.transaction_date
                ? `${r.transaction_date} — assign a month`
                : `no date — captured ${r.captured_at.slice(0, 10)}`}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function ExportScreen(props: ExportScreenProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<"build" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finalized = props.currentExport?.status === "finalized";
  const draftBuilt = Boolean(props.currentExport);

  async function rebuildDraft() {
    setBusy("build");
    setError(null);
    try {
      const res = await fetch("/api/receipts/export/month", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month: props.month }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
          blockers?: string[];
        };
        setError(
          json.blockers?.length
            ? `${json.error ?? "Could not build"}: ${json.blockers.join("; ")}`
            : json.error ?? "Build failed.",
        );
        return;
      }
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bg-gray-50 pb-12">
      <TopBar
        monthLabel={props.monthLabel}
        finalized={finalized}
        builtAt={
          props.currentExport?.bundle_built_at ??
          props.currentExport?.created_at ??
          null
        }
        onRebuild={rebuildDraft}
        busy={busy === "build"}
      />
      <MonthPipeline stages={props.stages} />
      <NextActionCard stages={props.stages} />

      {error && (
        <div className="mx-8 mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-6 px-8 py-6">
        <div className="space-y-6">
          {!finalized && (
            <BlockerTriage blockers={props.blockers} warnings={props.warnings} />
          )}
          <UnassignedReceiptsSection
            unassignable={props.unassignableReceipts}
            month={props.month}
          />
          {draftBuilt ? (
            <DraftPreview
              stats={props.draftStats}
              breakdown={props.breakdown}
              monthLabel={props.monthLabel}
            />
          ) : (
            <Card>
              <div className="flex items-center gap-3.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
                  <FileTextIcon size={20} />
                </div>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-gray-900">
                    Build a draft to preview the manifest
                  </div>
                  <div className="text-xs text-gray-500">
                    Generation stages a CSV + ZIP in R2 immutable storage and is
                    safe to repeat.
                  </div>
                </div>
                <Btn
                  kind="primary"
                  size="md"
                  onClick={rebuildDraft}
                  disabled={busy === "build" || finalized}
                >
                  Build draft
                </Btn>
              </div>
            </Card>
          )}
          <ExportHistory
            exports={props.exports}
            currentMonth={props.month}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Top bar ──────────────────────────────────────────────────────

function TopBar({
  monthLabel,
  finalized,
  builtAt,
  onRebuild,
  busy,
}: {
  monthLabel: string;
  finalized: boolean;
  builtAt: string | null;
  onRebuild: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center gap-4 border-b border-gray-200 bg-white px-8 py-3.5">
      <div className="flex items-center gap-2.5">
        <span className="text-[15px] font-bold text-gray-900">
          {monthLabel} export
        </span>
        {finalized ? (
          <Pill tone="green" size="sm" dot>
            Sealed
          </Pill>
        ) : builtAt ? (
          <Pill tone="amber" size="sm" dot>
            Draft
          </Pill>
        ) : (
          <Pill tone="gray" size="sm">
            Not built
          </Pill>
        )}
      </div>
      <span className="flex-1" />
      {builtAt && (
        <span className="text-xs text-gray-500">
          Last draft built {fmtRelative(builtAt)}
        </span>
      )}
      {!finalized && (
        <Btn kind="ghost" size="md" onClick={onRebuild} disabled={busy}>
          {busy ? "Building…" : builtAt ? "Rebuild draft" : "Build draft"}
        </Btn>
      )}
    </div>
  );
}

// ─── Blockers ─────────────────────────────────────────────────────

function BlockerTriage({
  blockers,
  warnings,
}: {
  blockers: Blocker[];
  warnings: Blocker[];
}) {
  const blockerCount = blockers.reduce((s, b) => s + b.count, 0);
  const warningCount = warnings.reduce((s, b) => s + b.count, 0);

  if (blockerCount === 0 && warningCount === 0) {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-500 text-white">
            ✓
          </div>
          <div>
            <div className="text-sm font-semibold text-gray-900">
              No blockers
            </div>
            <div className="text-xs text-gray-500">
              You can finalize this month.
            </div>
          </div>
        </div>
      </Card>
    );
  }

  const all = [...blockers, ...warnings];

  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="text-[15px] font-bold text-gray-900">
          Before you finalize
        </span>
        {blockerCount > 0 && (
          <Pill tone="red" size="sm" dot>
            {blockerCount} blocker{blockerCount === 1 ? "" : "s"}
          </Pill>
        )}
        {warningCount > 0 && (
          <Pill tone="amber" size="sm" dot>
            {warningCount} warning{warningCount === 1 ? "" : "s"}
          </Pill>
        )}
      </div>
      <Card pad={0}>
        {all.map((b, i) => (
          <BlockerRow
            key={b.label + i}
            blocker={b}
            isLast={i === all.length - 1}
          />
        ))}
      </Card>
    </div>
  );
}

function BlockerRow({ blocker, isLast }: { blocker: Blocker; isLast: boolean }) {
  return (
    <div
      className={[
        "flex items-center gap-3.5 px-4 py-3.5",
        isLast ? "" : "border-b border-gray-150",
      ].join(" ")}
    >
      <div
        className={[
          "flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-[12px] font-bold tabular-nums",
          blocker.severity === "blocker"
            ? "bg-red-100 text-red-600"
            : "bg-amber-100 text-amber-700",
        ].join(" ")}
      >
        {blocker.count}
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[13.5px] font-semibold text-gray-900">
            {blocker.label}
          </span>
          {blocker.severity === "blocker" && (
            <span className="text-[10.5px] font-bold uppercase tracking-[0.05em] text-red-600">
              blocker
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[12px] text-gray-500">{blocker.detail}</div>
      </div>
      {blocker.href && (
        <a
          href={blocker.href}
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 text-[12px] font-semibold text-gray-700 hover:bg-gray-50"
        >
          {blocker.ctaLabel}
          <ArrowRightIcon size={12} className="text-gray-700" />
        </a>
      )}
    </div>
  );
}

// ─── Draft preview ────────────────────────────────────────────────

function DraftPreview({
  stats,
  breakdown,
  monthLabel,
}: {
  stats: ExportScreenProps["draftStats"];
  breakdown: CategoryBreakdownRow[];
  monthLabel: string;
}) {
  const palette = [
    "bg-amber-500",
    "bg-amber-400",
    "bg-gray-900",
    "bg-gray-700",
    "bg-gray-500",
    "bg-gray-400",
    "bg-gray-300",
  ];
  return (
    <Card pad={0}>
      <div className="flex items-center border-b border-gray-150 px-5 py-4">
        <span className="text-[14px] font-semibold text-gray-900">
          Draft summary
        </span>
        <span className="ml-2.5 text-[11.5px] text-gray-500">
          What gets shipped to accounting for {monthLabel}
        </span>
        <span className="flex-1" />
      </div>

      <div className="grid grid-cols-1 border-b border-gray-150 md:grid-cols-4">
        <Kpi label="Rows in manifest" value={stats.rows.toString()} sub="captured + AMEX" />
        <Kpi
          label="Total expensed"
          value={`¥${stats.totalMinor.toLocaleString()}`}
          sub={`incl. ¥${stats.taxMinor.toLocaleString()} tax`}
        />
        <Kpi
          label="Receipts attached"
          value={`${stats.receiptsAttached} / ${stats.receiptsTotal}`}
          sub={`${Math.max(0, stats.receiptsTotal - stats.receiptsAttached)} no-receipt-expected`}
        />
        <Kpi
          label="Events"
          value={stats.eventCount.toString()}
          sub="entertainment / meeting"
        />
      </div>

      <div className="px-5 py-4">
        <div className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          By category
        </div>
        <div className="mb-3 flex h-2.5 overflow-hidden rounded-md">
          {breakdown.map((b, i) => (
            <div
              key={b.code}
              className={palette[i % palette.length]}
              style={{ width: `${Math.max(0.01, b.pct) * 100}%` }}
            />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {breakdown.map((b, i) => (
            <div
              key={b.code}
              className="flex items-center gap-2 text-[12px]"
            >
              <span
                className={`h-2 w-2 rounded-full ${palette[i % palette.length]}`}
              />
              <span className="flex-1 text-gray-700">{b.label}</span>
              <span className="tabular-nums text-[11.5px] text-gray-500">
                {b.count} rows
              </span>
              <span className="min-w-[80px] text-right text-[12px] font-semibold tabular-nums text-gray-900">
                ¥{b.totalMinor.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-gray-150 px-5 py-3">
        <span className="text-sm leading-none">🐝</span>
        <p className="text-[12px] text-gray-500">
          <strong className="font-semibold text-gray-700">
            Format is locked at finalize.
          </strong>
        </p>
      </div>
    </Card>
  );
}

function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="border-b border-gray-150 px-5 py-4 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
      <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        {label}
      </div>
      <div className="mt-1 text-[22px] font-bold tabular-nums text-gray-900">
        {value}
      </div>
      <div className="text-[11px] text-gray-500">{sub}</div>
    </div>
  );
}

// ─── Export history ───────────────────────────────────────────────

function ExportHistory({
  exports,
  currentMonth,
}: {
  exports: ReceiptExport[];
  currentMonth: string;
}) {
  const rows = exports
    .filter((e) => e.export_month !== currentMonth)
    .slice(0, 6);

  return (
    <Card pad={0}>
      <div className="flex items-center border-b border-gray-150 px-5 py-3.5">
        <span className="text-[14px] font-semibold text-gray-900">
          Export history
        </span>
        <span className="ml-2 text-[11.5px] text-gray-500">
          {rows.length} previous month{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="px-5 py-10 text-center text-[12.5px] text-gray-400">
          No prior exports yet.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_110px_110px_140px_120px] bg-gray-50 px-5 py-2 text-[10.5px] font-bold uppercase tracking-[0.05em] text-gray-500">
            <span>Month</span>
            <span>Status</span>
            <span className="text-right">SHA-256</span>
            <span>Finalized</span>
            <span />
          </div>
          {rows.map((e) => (
            <div
              key={e.id}
              className="grid grid-cols-[1fr_110px_110px_140px_120px] items-center border-t border-gray-150 px-5 py-3 text-[13px]"
            >
              <span className="font-semibold text-gray-900">{e.export_month}</span>
              <span>
                <Pill
                  tone={e.status === "finalized" ? "green" : "amber"}
                  size="sm"
                  dot
                >
                  {e.status}
                </Pill>
              </span>
              <span className="text-right font-mono text-[11px] text-gray-500">
                {e.archive_sha256
                  ? `${e.archive_sha256.slice(0, 10)}…`
                  : "—"}
              </span>
              <span className="text-[12px] text-gray-500">
                {e.finalized_at?.slice(0, 10) ?? "—"}
              </span>
              <span>
                <Btn
                  kind="ghost"
                  size="sm"
                  leftIcon={<DownloadIcon size={13} className="text-gray-700" />}
                >
                  Download
                </Btn>
              </span>
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

function fmtRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

