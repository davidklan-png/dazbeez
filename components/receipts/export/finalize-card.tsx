"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Btn } from "@/components/ui/btn";
import { Card } from "@/components/ui/card";
import { LockIcon } from "@/components/ui/icons";

/**
 * Finalize action + panel. Extracted from export-screen.tsx so it can render at
 * the bottom of the pre-finalize review page (the new finalize surface). The
 * API (POST /api/receipts/export/[month]) and the confirm-type gate are
 * unchanged. `blockerCount` is the authoritative gate verdict
 * (validateMonthReadyForExport) on the review page.
 */
export function FinalizeCard({
  month,
  monthLabel,
  finalized,
  draftBuilt,
  blockerCount,
  warningCount,
  rowsInDraft,
}: {
  month: string;
  monthLabel: string;
  finalized: boolean;
  draftBuilt: boolean;
  blockerCount: number;
  warningCount: number;
  rowsInDraft: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmType, setConfirmType] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canFinalize =
    !finalized &&
    draftBuilt &&
    blockerCount === 0 &&
    confirmType.trim().toLowerCase() === monthLabel.toLowerCase();

  async function finalize() {
    if (confirmType.trim().toLowerCase() !== monthLabel.toLowerCase()) {
      setError(`Type "${monthLabel.toLowerCase()}" to confirm.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/receipts/export/${month}`, {
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
      setBusy(false);
    }
  }

  return (
    <div className="mx-8 mb-12">
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
            All {rowsInDraft} rows are locked. Reconciliation is signed off. Download the archive
            bundle from the export screen history.
          </div>
        ) : (
          <div className="px-5 py-5">
            <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[12.5px] text-gray-600">
              <Bullet>Locks all {rowsInDraft || "—"} receipts to read-only</Bullet>
              <Bullet>Stages CSV + ZIP archive in R2 immutable bucket</Bullet>
              <Bullet>Records signoff in audit log</Bullet>
              <Bullet>Marks AMEX statement as reconciled</Bullet>
            </ul>

            {warningCount > 0 && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800">
                {warningCount} non-blocking warning{warningCount === 1 ? "" : "s"} will ship as-is.
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
                disabled={finalized || blockerCount > 0}
                className="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 font-mono text-[13px] text-gray-900 outline-none focus:border-amber-500 disabled:bg-gray-50"
              />
            </div>

            {error && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700">
                {error}
              </div>
            )}

            <Btn
              kind="dark"
              size="lg"
              full
              className="mt-3.5"
              disabled={!canFinalize || busy}
              onClick={finalize}
              rightIcon={<LockIcon size={14} className="text-white" />}
            >
              {busy
                ? "Finalizing…"
                : blockerCount > 0
                  ? `Finalize · resolve ${blockerCount} blocker${blockerCount === 1 ? "" : "s"} first`
                  : `Finalize ${monthLabel}`}
            </Btn>
            <div className="mt-2 text-center text-[11px] text-gray-400">
              Signoff with your CF Access identity
            </div>
          </div>
        )}
      </Card>
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
