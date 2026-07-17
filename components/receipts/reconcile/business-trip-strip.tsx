"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Btn } from "@/components/ui/btn";
import { formatDate } from "@/lib/receipts/format";

// The amber business-trip strip in the reconcile detail pane (ADR 0010 D4).
// When the candidate line is linked to a trip (business_trip_id set), the
// strip DELEGATES: it shows the trip's date range + a link, and Confirm/Exclude
// become "Confirm trip"/"Reject trip" that PATCH the WHOLE trip (Phase A status
// sync updates all member lines). When business_trip_id is NULL (legacy/edge),
// today's per-line PATCH behavior is preserved.

interface TripSummary {
  trip_name: string | null;
  start_date: string;
  end_date: string;
  status: string;
}

interface BusinessTripStripProps {
  tripId: string | null;
  locked: boolean;
  busy: boolean;
  onLegacyConfirm: () => void;
  onLegacyExclude: () => void;
}

export function BusinessTripStrip({
  tripId,
  locked,
  busy,
  onLegacyConfirm,
  onLegacyExclude,
}: BusinessTripStripProps) {
  const router = useRouter();
  const [trip, setTrip] = useState<TripSummary | null>(null);
  const [acting, setActing] = useState(false);

  // Lazy trip summary (one GET per strip render — fine at this scale).
  useEffect(() => {
    if (!tripId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/receipts/trips/${tripId}`);
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as { trip?: TripSummary } | null;
        if (!cancelled && data?.trip) setTrip(data.trip);
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
    setActing(true);
    try {
      await fetch(`/api/receipts/trips/${tripId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      router.refresh();
    } finally {
      setActing(false);
    }
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

  const disabled = busy || acting || locked;
  return (
    <StripShell
      title={
        <span>
          Part of business trip{" "}
          <Link
            href={`/receipts/trips/${tripId}`}
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
