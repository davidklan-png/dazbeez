"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Btn } from "@/components/ui/btn";
import { Card } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import {
  ArrowRightIcon,
  DownloadIcon,
  FileTextIcon,
  LockIcon,
} from "@/components/ui/icons";
import type { ReceiptExport } from "@/lib/receipts/types";

export interface Blocker {
  severity: "blocker" | "warn";
  count: number;
  label: string;
  detail: string;
  href: string | null;
  ctaLabel: string;
}

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
    attendeesLogged: number;
    eventCount: number;
  };
  breakdown: CategoryBreakdownRow[];
  manifestSample: ManifestSampleRow[];
  manifestSize: { rowsTotal: number; sizeBytes: number; sha256: string | null };
}

export interface ManifestSampleRow {
  receiptId: string;
  merchant: string;
  txnDate: string;
  amountMinor: number;
  categoryLabel: string;
  payment: string;
  cardLast4: string;
  alcohol: boolean;
  archivePath: string;
}

export function ExportScreen(props: ExportScreenProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<"build" | "finalize" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmType, setConfirmType] = useState("");

  const finalized = props.currentExport?.status === "finalized";
  const draftBuilt = Boolean(props.currentExport);
  const blockerCount = props.blockers.reduce((s, b) => s + b.count, 0);
  const warningCount = props.warnings.reduce((s, b) => s + b.count, 0);

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

  async function finalize() {
    if (confirmType.trim().toLowerCase() !== props.monthLabel.toLowerCase()) {
      setError(`Type "${props.monthLabel.toLowerCase()}" to confirm.`);
      return;
    }
    setBusy("finalize");
    setError(null);
    try {
      const res = await fetch(`/api/receipts/export/${props.month}`, {
        method: "POST",
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
          blockers?: string[];
        };
        setError(
          json.blockers?.length
            ? `${json.error ?? "Could not finalize"}: ${json.blockers.join("; ")}`
            : json.error ?? "Finalize failed.",
        );
        return;
      }
      setConfirmType("");
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
        builtAt={props.currentExport?.created_at ?? null}
        onRebuild={rebuildDraft}
        busy={busy === "build"}
      />
      <Pipeline
        blockerCount={blockerCount}
        finalized={finalized}
        draftBuilt={draftBuilt}
      />

      {error && (
        <div className="mx-8 mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 px-8 py-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          {!finalized && (
            <BlockerTriage blockers={props.blockers} warnings={props.warnings} />
          )}
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

        <FinalizePanel
          monthLabel={props.monthLabel}
          finalized={finalized}
          draftBuilt={draftBuilt}
          blockers={blockerCount}
          warnings={warningCount}
          confirmType={confirmType}
          setConfirmType={setConfirmType}
          onFinalize={finalize}
          busy={busy === "finalize"}
          rowsInDraft={props.draftStats.rows}
        />
      </div>

      {draftBuilt && (
        <div className="px-8 pb-12">
          <ReportFormat
            month={props.month}
            manifestSample={props.manifestSample}
            manifestSize={props.manifestSize}
            finalized={finalized}
            sha256={props.currentExport?.archive_sha256 ?? null}
          />
        </div>
      )}
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

// ─── Pipeline ─────────────────────────────────────────────────────

function Pipeline({
  blockerCount,
  finalized,
  draftBuilt,
}: {
  blockerCount: number;
  finalized: boolean;
  draftBuilt: boolean;
}) {
  const stepIndex = finalized ? 3 : draftBuilt && blockerCount === 0 ? 2 : draftBuilt ? 2 : 1;

  const steps = [
    { label: "Reconcile", sub: "AMEX lines matched", done: true, current: false },
    {
      label: "Draft",
      sub: draftBuilt ? "Built · staged in R2" : "Not yet built",
      done: draftBuilt,
      current: stepIndex === 1 || (stepIndex === 2 && !finalized && blockerCount > 0),
    },
    {
      label: "Review",
      sub: blockerCount === 0 ? "Clear to finalize" : `${blockerCount} blockers`,
      done: draftBuilt && blockerCount === 0,
      current: stepIndex === 2,
    },
    {
      label: "Finalize",
      sub: finalized ? "Sealed · immutable" : "Awaiting signoff",
      done: finalized,
      current: stepIndex === 3,
    },
    {
      label: "Archived",
      sub: "7-year retention",
      done: finalized,
      current: false,
    },
  ];

  return (
    <div className="flex items-stretch border-b border-gray-200 bg-white px-8 py-4">
      {steps.map((s, i) => {
        const future = !s.done && !s.current;
        return (
          <div key={s.label} className="flex flex-1 items-center gap-3">
            <div
              className={[
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold",
                s.done
                  ? "bg-green-500 text-white"
                  : s.current
                    ? "bg-amber-500 text-white shadow-[0_4px_12px_rgba(217,119,6,0.3)]"
                    : "border-[1.5px] border-gray-200 text-gray-400",
              ].join(" ")}
            >
              {s.done ? "✓" : i + 1}
            </div>
            <div className="min-w-0">
              <div
                className={[
                  "text-[13px] font-semibold",
                  future ? "text-gray-400" : "text-gray-900",
                ].join(" ")}
              >
                {s.label}
              </div>
              <div
                className={[
                  "mt-0.5 text-[11.5px]",
                  future ? "text-gray-400" : "text-gray-500",
                ].join(" ")}
              >
                {s.sub}
              </div>
            </div>
            {i < steps.length - 1 && (
              <div className="ml-auto h-px w-12 self-center bg-gray-200" />
            )}
          </div>
        );
      })}
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
          label="Attendees logged"
          value={stats.attendeesLogged.toString()}
          sub={`${stats.eventCount} event${stats.eventCount === 1 ? "" : "s"}`}
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

// ─── Finalize panel ───────────────────────────────────────────────

function FinalizePanel({
  monthLabel,
  finalized,
  draftBuilt,
  blockers,
  warnings,
  confirmType,
  setConfirmType,
  onFinalize,
  busy,
  rowsInDraft,
}: {
  monthLabel: string;
  finalized: boolean;
  draftBuilt: boolean;
  blockers: number;
  warnings: number;
  confirmType: string;
  setConfirmType: (v: string) => void;
  onFinalize: () => void;
  busy: boolean;
  rowsInDraft: number;
}) {
  const canFinalize =
    !finalized &&
    draftBuilt &&
    blockers === 0 &&
    confirmType.trim().toLowerCase() === monthLabel.toLowerCase();

  return (
    <div className="sticky top-6 flex flex-col gap-4 self-start">
      <Card pad={0} className="overflow-hidden">
        <div className="flex items-center gap-2.5 border-b border-gray-150 px-4 py-3.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-900 text-white">
            <LockIcon size={14} className="text-white" />
          </div>
          <div>
            <div className="text-[13.5px] font-semibold text-gray-900">
              {finalized ? `Sealed: ${monthLabel}` : `Finalize ${monthLabel}`}
            </div>
            <div className="text-[11.5px] text-gray-500">
              {finalized
                ? "This export is immutable."
                : "This is the only irreversible action."}
            </div>
          </div>
        </div>

        {finalized ? (
          <div className="px-5 py-5 text-[12.5px] text-gray-600">
            All {rowsInDraft} rows are locked. Reconciliation is signed off.
            Download the archive bundle from history below.
          </div>
        ) : (
          <div className="px-5 py-5">
            <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[12.5px] text-gray-600">
              <Bullet>Locks all {rowsInDraft || "—"} receipts to read-only</Bullet>
              <Bullet>Stages CSV + ZIP archive in R2 immutable bucket</Bullet>
              <Bullet>Records signoff in audit log</Bullet>
              <Bullet>Marks AMEX statement as reconciled</Bullet>
            </ul>

            {warnings > 0 && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800">
                {warnings} non-blocking warning{warnings === 1 ? "" : "s"} will ship as-is.
              </div>
            )}

            <div className="mt-5">
              <div className="mb-1.5 text-[11.5px] text-gray-500">
                Type{" "}
                <span className="font-mono text-gray-700">
                  {monthLabel.toLowerCase()}
                </span>{" "}
                to confirm
              </div>
              <input
                type="text"
                value={confirmType}
                onChange={(e) => setConfirmType(e.target.value)}
                placeholder={monthLabel.toLowerCase()}
                disabled={finalized || blockers > 0}
                className="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 font-mono text-[13px] text-gray-900 outline-none focus:border-amber-500 disabled:bg-gray-50"
              />
            </div>

            <Btn
              kind="dark"
              size="lg"
              full
              className="mt-3.5"
              disabled={!canFinalize || busy}
              onClick={onFinalize}
              rightIcon={<LockIcon size={14} className="text-white" />}
            >
              {busy
                ? "Finalizing…"
                : blockers > 0
                  ? `Finalize · resolve ${blockers} blocker${blockers === 1 ? "" : "s"} first`
                  : `Finalize ${monthLabel}`}
            </Btn>
            <div className="mt-2 text-center text-[11px] text-gray-400">
              Signoff with your CF Access identity
            </div>
          </div>
        )}
      </Card>

      <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3.5">
        <div className="text-2xl">🐝</div>
        <div className="text-[12px] leading-[1.45] text-gray-700">
          <b>{finalized ? "Locked." : "One more pass."}</b>{" "}
          {finalized
            ? `${monthLabel} is sealed and audit-traceable.`
            : blockers === 0
              ? "Type the month to seal — you're clear."
              : `Knock out ${blockers} blocker${blockers === 1 ? "" : "s"} to unlock finalize.`}
        </div>
      </div>
    </div>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="text-gray-400">→</span>
      <span>{children}</span>
    </li>
  );
}

// ─── Report format ────────────────────────────────────────────────

function ReportFormat({
  month,
  manifestSample,
  manifestSize,
  finalized,
  sha256,
}: {
  month: string;
  manifestSample: ManifestSampleRow[];
  manifestSize: { rowsTotal: number; sizeBytes: number; sha256: string | null };
  finalized: boolean;
  sha256: string | null;
}) {
  const [view, setView] = useState<"table" | "raw" | "json">("table");

  return (
    <Card pad={0}>
      <div className="flex items-center gap-3 border-b border-gray-150 bg-gray-50 px-5 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-900 text-white">
          <FileTextIcon size={16} className="text-white" />
        </div>
        <div className="flex-1">
          <div className="text-[14px] font-bold text-gray-900">
            Report format · what gets shipped
          </div>
          <div className="text-[12px] text-gray-500">
            <span className="font-mono">receipts-{month}.csv</span> + companion
            archive <span className="font-mono">receipts-{month}.zip</span>.
            Format is snapshotted at finalize.
          </div>
        </div>
        {finalized ? (
          <Pill tone="green" size="sm" dot>
            Sealed · v3
          </Pill>
        ) : (
          <Pill tone="gray" size="sm">
            v3 schema
          </Pill>
        )}
        <Pill tone="green" size="sm" dot>
          14 columns · stable
        </Pill>
      </div>

      {/* Manifest preview */}
      <div className="px-5 pt-4">
        <div className="mb-2.5 flex items-center gap-2.5">
          <span className="text-[11px] font-bold uppercase tracking-[0.05em] text-gray-500">
            Manifest preview
          </span>
          <span className="text-[11px] text-gray-400">
            showing first {manifestSample.length} of {manifestSize.rowsTotal} rows
          </span>
          <span className="flex-1" />
          <div className="flex gap-1">
            {(["table", "raw", "json"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={[
                  "rounded-[6px] px-2.5 py-1 text-[11px] font-semibold capitalize",
                  view === v
                    ? "bg-gray-900 text-white"
                    : "text-gray-500 hover:text-gray-900",
                ].join(" ")}
              >
                {v === "raw" ? "Raw CSV" : v}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-[10px] border border-gray-200 text-[11.5px]">
          {view === "table" ? (
            <ManifestTable rows={manifestSample} />
          ) : view === "raw" ? (
            <pre className="overflow-auto bg-white px-3 py-2 font-mono text-[11.5px] text-gray-700">
              {rawCsv(manifestSample)}
            </pre>
          ) : (
            <pre className="overflow-auto bg-white px-3 py-2 font-mono text-[11.5px] text-gray-700">
              {JSON.stringify(manifestSample, null, 2)}
            </pre>
          )}
          <div className="flex items-center justify-between border-t border-gray-150 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
            <span>… {Math.max(0, manifestSize.rowsTotal - manifestSample.length)} more rows</span>
            <span className="font-mono">
              receipts-{month}.csv · {(manifestSize.sizeBytes / 1024).toFixed(1)} KB ·
              SHA-256 {sha256 ? `${sha256.slice(0, 6)}…${sha256.slice(-4)}` : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Schema docs */}
      <div className="px-5 py-5">
        <div className="mb-2.5 flex items-center gap-2.5">
          <span className="text-[11px] font-bold uppercase tracking-[0.05em] text-gray-500">
            Schema
          </span>
          <span className="text-[11px] text-gray-400">
            14 columns · companion files: attendees.csv, audit.json, receipts/*.{`{jpg,pdf}`}
          </span>
        </div>
        <SchemaTable />

        <div className="mt-3.5 flex items-start gap-3 rounded-[10px] border border-gray-200 bg-gray-50 px-3.5 py-3">
          <div className="text-lg">🐝</div>
          <div className="flex-1 text-[12.5px] leading-[1.5] text-gray-700">
            <b>Format is locked at finalize.</b> Schema version, column order,
            and JST timezone handling become part of the immutable export
            record. Changes to{" "}
            <span className="font-mono">lib/receipts/export.ts</span> after
            finalize don&rsquo;t mutate history — prior exports keep replaying
            with their original v3 reader.
          </div>
        </div>
      </div>
    </Card>
  );
}

const COL_TEMPLATE =
  "95px 170px 80px 70px 110px 80px 75px 70px 1fr";

function ManifestTable({ rows }: { rows: ManifestSampleRow[] }) {
  return (
    <div>
      <div
        className="grid bg-gray-50 px-3 py-2 font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] text-gray-500"
        style={{ gridTemplateColumns: COL_TEMPLATE, gap: 10 }}
      >
        <span>receipt_id</span>
        <span>merchant</span>
        <span>txn_date</span>
        <span className="text-right">amount</span>
        <span>category</span>
        <span>payment</span>
        <span>card_last4</span>
        <span>alcohol</span>
        <span>archive_path</span>
      </div>
      {rows.map((r) => (
        <div
          key={r.receiptId}
          className="grid border-t border-gray-150 px-3 py-1.5 font-mono text-gray-800"
          style={{ gridTemplateColumns: COL_TEMPLATE, gap: 10 }}
        >
          <span className="truncate">{r.receiptId}</span>
          <span className="truncate">{r.merchant}</span>
          <span className="truncate">{r.txnDate}</span>
          <span className="text-right tabular-nums">{r.amountMinor}</span>
          <span className="truncate">{r.categoryLabel}</span>
          <span className="truncate">{r.payment}</span>
          <span className="truncate">{r.cardLast4 || "—"}</span>
          <span className="truncate">{r.alcohol ? "true" : "false"}</span>
          <span className="truncate">{r.archivePath}</span>
        </div>
      ))}
    </div>
  );
}

const SCHEMA_COLS = [
  { k: "receipt_id", t: "string", ex: "R-2026-04-0184", n: "PK from receipt_records" },
  { k: "merchant", t: "string", ex: "Yakitori Taro", n: "normalized; AMEX merchant aliases applied" },
  { k: "transaction_date", t: "date", ex: "2026-04-17", n: "JST, ISO 8601" },
  { k: "amount", t: "integer", ex: "8850", n: "minor units in `currency`" },
  { k: "currency", t: "string", ex: "JPY", n: "ISO 4217" },
  { k: "category", t: "enum", ex: "接待交際費", n: "one of 14 JP catalog" },
  { k: "expense_type", t: "enum", ex: "meeting-no-alcohol", n: "expense classification" },
  { k: "payment_path", t: "enum", ex: "AMEX", n: "AMEX / CASH / DIGITAL / UNKNOWN" },
  { k: "card_last4", t: "string", ex: "3091", n: "present when payment_path=AMEX" },
  { k: "amex_reference", t: "string", ex: "20260417-0214", n: "links to amex_statement_lines" },
  { k: "business_purpose", t: "string", ex: "Client dinner · Acme", n: "free text" },
  { k: "attendees", t: "jsonl", ex: "[D Klan, T Sato]", n: "one per row in companion CSV" },
  { k: "alcohol_present", t: "bool", ex: "true", n: "tax flag" },
  { k: "archive_path", t: "string", ex: "r2://.../R-0184.jpg", n: "pointer into immutable bucket" },
] as const;

const SCHEMA_TPL = "180px 90px 1fr 1.4fr";

function SchemaTable() {
  return (
    <div className="overflow-hidden rounded-[10px] border border-gray-200">
      <div
        className="grid bg-gray-50 px-3.5 py-2 text-[10.5px] font-bold uppercase tracking-[0.05em] text-gray-500"
        style={{ gridTemplateColumns: SCHEMA_TPL }}
      >
        <span>Column</span>
        <span>Type</span>
        <span>Example</span>
        <span>Notes</span>
      </div>
      {SCHEMA_COLS.map((c) => (
        <div
          key={c.k}
          className="grid border-t border-gray-150 px-3.5 py-2 text-[12px] text-gray-800"
          style={{ gridTemplateColumns: SCHEMA_TPL }}
        >
          <span className="font-mono font-semibold text-gray-900">{c.k}</span>
          <span>
            <Pill
              tone={c.t === "enum" ? "amber" : c.t === "bool" ? "blue" : "gray"}
              size="sm"
            >
              {c.t}
            </Pill>
          </span>
          <span className="font-mono text-[11.5px] text-gray-600">{c.ex}</span>
          <span className="text-gray-500">{c.n}</span>
        </div>
      ))}
    </div>
  );
}

function rawCsv(rows: ManifestSampleRow[]): string {
  const header =
    "receipt_id,merchant,transaction_date,amount,category,payment_path,card_last4,alcohol_present,archive_path";
  const body = rows
    .map((r) =>
      [
        r.receiptId,
        csvField(r.merchant),
        r.txnDate,
        r.amountMinor,
        csvField(r.categoryLabel),
        r.payment,
        r.cardLast4 || "",
        r.alcohol ? "true" : "false",
        csvField(r.archivePath),
      ].join(","),
    )
    .join("\n");
  return `${header}\n${body}`;
}

function csvField(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
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

