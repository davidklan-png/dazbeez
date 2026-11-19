"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Btn } from "@/components/ui/btn";
import { SaveQueue } from "@/lib/receipts/save-queue";
import { guardedLinkClick } from "@/lib/receipts/review-navigation";
import { formatDate } from "@/lib/receipts/format";

// The amber business-trip strip in the reconcile detail pane (ADR 0010 D4).
// When the candidate line is linked to a trip (business_trip_id set), the
// strip DELEGATES: it shows the trip's date range + a link, and Confirm/Exclude
// become "Confirm trip"/"Reject trip" that PATCH the WHOLE trip (Phase A status
// sync updates all member lines). When business_trip_id is NULL (legacy/edge),
// today's per-line PATCH behavior is preserved.

interface TripSummary {
  revision: number;
  trip_name: string | null;
  start_date: string;
  end_date: string;
  status: string;
}

interface BusinessTripStripProps {
  tripId: string | null;
  beforeAction: () => Promise<{ trips: Record<string, number>; lines: Record<string, number>; finish: (ack?: { lineRevisions?: Record<string, number> }) => Promise<void> }>;
  locked: boolean;
  busy: boolean;
  onLegacyConfirm: () => void;
  onLegacyExclude: () => void;
}

export function BusinessTripStrip({
  tripId,
  beforeAction,
  locked,
  busy,
  onLegacyConfirm,
  onLegacyExclude,
}: BusinessTripStripProps) {
  const router = useRouter();
  const [trip, setTrip] = useState<TripSummary | null>(null);
  const loadedLines = useRef<Record<string, number>>({});
  const halted = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  // Lazy trip summary (one GET per strip render — fine at this scale).
  useEffect(() => {
    if (!tripId) return;
    setTrip(null);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/receipts/trips/${tripId}`);
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as { trip?: TripSummary; lines?: { id: string; revision: number }[] } | null;
        if (!cancelled && data?.trip) {
          loadedLines.current = Object.fromEntries((data.lines ?? []).map(l => [l.id, l.revision]));
          setTrip(data.trip);
        }
      } catch {
        // non-fatal: fall back to the link without the date range
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  async function patchTripStatus(status: "confirmed" | "rejected") {
    if (!tripId) return;
    if (status === "rejected") {
      const ok = window.confirm(
        "Reject this trip? All member AMEX lines become 'excluded'.",
      );
      if (!ok) return;
    }
    if (!trip || halted.current) return;
    setActing(true);
    let finish: ((ack?: { lineRevisions?: Record<string, number> }) => Promise<void>) | undefined;
    try {
      const own = await beforeAction();
      finish = own.finish;
      const expectedLines = { ...loadedLines.current };
      for (const id of Object.keys(expectedLines)) if (own.lines[id] !== undefined) expectedLines[id] = own.lines[id];
      const revision = Math.max(trip.revision, own.trips[tripId] ?? trip.revision);
      const queue = new SaveQueue({ url: `/api/receipts/trips/${tripId}`, revision, entity: "trip",
        buildBody: () => ({ status, expectedLines }) });
      const ack = await queue.save();
      await finish(ack);
      finish = undefined;
      router.refresh();
    } catch (err) {
      await finish?.();
      halted.current = Boolean(finish);
      setError(err instanceof Error ? err.message : "Outcome uncertain — reload to review.");
    } finally { setActing(false); }
  }

  // Legacy / edge: no trip link → per-line PATCH (unchanged behavior).
  if (!tripId) {
    return (
      <StripShell
        title="Part of a candidate business trip"
        subtitle="Linked to a trip cluster. Review & confirm the trip to lock the window."
      >
        {!locked && (
          <div className="flex gap-2">
            <Btn kind="primary" size="sm" disabled={busy} onClick={onLegacyConfirm}>
              Confirm
            </Btn>
            <Btn kind="ghost" size="sm" disabled={busy} onClick={onLegacyExclude}>
              Exclude
            </Btn>
          </div>
        )}
      </StripShell>
    );
  }

  const disabled = busy || acting || locked || !trip || halted.current;
  return (
    <StripShell
      title={
        <span>
          Part of business trip{" "}
          <Link
            href={`/receipts/trips/${tripId}`}
            onClick={e => guardedLinkClick(e, `/receipts/trips/${tripId}`, router.push)}
            className="font-semibold text-amber-700 hover:underline"
          >
            {trip?.trip_name?.trim() || "(unnamed trip)"}
          </Link>
        </span>
      }
      subtitle={
        trip
          ? `${formatDate(trip.start_date)} – ${formatDate(trip.end_date)} · confirming/rejecting here applies to the whole trip.`
          : "Confirming/rejecting here applies to the whole trip."
      }
    >
      {error && <span role="alert" className="text-xs text-red-700">{error} <button onClick={() => window.location.reload()} className="underline">Reload to review</button></span>}
      {!locked && (
        <div className="flex gap-2">
          <Btn
            kind="primary"
            size="sm"
            disabled={disabled}
            onClick={() => patchTripStatus("confirmed")}
          >
            Confirm trip
          </Btn>
          <Btn
            kind="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => patchTripStatus("rejected")}
          >
            Reject trip
          </Btn>
        </div>
      )}
    </StripShell>
  );
}

function StripShell({
  title,
  subtitle,
  children,
}: {
  title: React.ReactNode;
  subtitle: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="mt-4 flex items-center gap-3.5 rounded-xl border border-amber-200 px-5 py-3.5"
      style={{ background: "linear-gradient(135deg, #FFFBEB, #FEF3C7)" }}
    >
      <div className="text-[22px]">🐝</div>
      <div className="flex-1">
        <div className="text-[13px] font-semibold text-gray-900">{title}</div>
        <div className="mt-0.5 text-[12px] text-gray-600">{subtitle}</div>
      </div>
      {children}
    </div>
  );
}
