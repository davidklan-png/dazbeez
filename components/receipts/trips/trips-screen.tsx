"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Btn } from "@/components/ui/btn";
import { Pill } from "@/components/ui/pill";
import { Card } from "@/components/ui/card";
import { Field, TextInput } from "@/components/ui/field";
import { formatDate } from "@/lib/receipts/format";
import {
  filterTripsByTab,
  tripStatusTone,
  type TripTab,
} from "@/lib/receipts/business-trips";
import type { BusinessTripWithCounts } from "@/lib/receipts/db";

interface TripsScreenProps {
  initialTrips: BusinessTripWithCounts[];
}

export function TripsScreen({ initialTrips }: TripsScreenProps) {
  const router = useRouter();
  const [trips] = useState<BusinessTripWithCounts[]>(initialTrips);
  const [tab, setTab] = useState<TripTab>("candidate");

  // Register-trip form state.
  const [reg, setReg] = useState({
    tripName: "",
    startDate: "",
    endDate: "",
    purpose: "",
    primaryLocation: "",
  });
  const [registering, setRegistering] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);

  const visible = filterTripsByTab(trips, tab);
  const candidateCount = trips.filter((t) => t.status === "candidate").length;
  const confirmedCount = trips.filter((t) => t.status === "confirmed").length;

  async function registerTrip() {
    setRegError(null);
    if (!reg.startDate || !reg.endDate) {
      setRegError("Start date and end date are required.");
      return;
    }
    setRegistering(true);
    try {
      const res = await fetch("/api/receipts/trips", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tripName: reg.tripName.trim() || null,
          startDate: reg.startDate,
          endDate: reg.endDate,
          purpose: reg.purpose.trim() || null,
          primaryLocation: reg.primaryLocation.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !data.id) {
        setRegError(data.error ?? `Create failed (HTTP ${res.status}).`);
        return;
      }
      router.push(`/receipts/trips/${data.id}`);
    } catch {
      setRegError("Network error");
    } finally {
      setRegistering(false);
    }
  }

  const tabs: Array<{ id: TripTab; label: string; n: number }> = [
    { id: "candidate", label: "Candidates", n: candidateCount },
    { id: "confirmed", label: "Confirmed", n: confirmedCount },
    { id: "all", label: "All", n: trips.length },
  ];

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Business trips</h1>
          <p className="mt-1 text-[13px] text-gray-500">
            Register trips and attach the related charges. Trip dates describe
            the trip — prebooking and late charges are attachable across months.
          </p>
        </div>
      </div>

      {/* Register trip */}
      <Card className="mb-6">
        <div className="mb-3 text-[13px] font-semibold text-gray-900">
          Register a trip
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Start date" required>
            <TextInput
              type="date"
              value={reg.startDate}
              onChange={(e) => setReg((s) => ({ ...s, startDate: e.target.value }))}
            />
          </Field>
          <Field label="End date" required>
            <TextInput
              type="date"
              value={reg.endDate}
              onChange={(e) => setReg((s) => ({ ...s, endDate: e.target.value }))}
            />
          </Field>
          <Field label="Trip name">
            <TextInput
              value={reg.tripName}
              onChange={(e) => setReg((s) => ({ ...s, tripName: e.target.value }))}
              placeholder="e.g. Odawara offsite"
            />
          </Field>
          <Field label="Primary location">
            <TextInput
              value={reg.primaryLocation}
              onChange={(e) => setReg((s) => ({ ...s, primaryLocation: e.target.value }))}
              placeholder="e.g. 神奈川"
            />
          </Field>
          <Field label="Purpose" className="md:col-span-2">
            <TextInput
              value={reg.purpose}
              onChange={(e) => setReg((s) => ({ ...s, purpose: e.target.value }))}
              placeholder="Optional"
            />
          </Field>
        </div>
        {regError && <p className="mt-2 text-[12px] text-red-600">{regError}</p>}
        <div className="mt-3 flex justify-end">
          <Btn
            kind="primary"
            size="md"
            disabled={registering}
            onClick={registerTrip}
          >
            {registering ? "Creating…" : "Create trip"}
          </Btn>
        </div>
      </Card>

      {/* Tabs */}
      <div className="mb-4 flex gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={[
              "rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors",
              tab === t.id
                ? "border-amber-200 bg-amber-50 text-gray-900"
                : "border-transparent text-gray-500 hover:text-gray-900",
            ].join(" ")}
          >
            {t.label} <span className="text-gray-400">({t.n})</span>
          </button>
        ))}
      </div>

      {/* Trip cards */}
      {visible.length === 0 ? (
        <Card>
          <p className="text-[13px] text-gray-500">
            No trips in this view. Register one above, or switch tabs.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {visible.map((trip) => (
            <Link
              key={trip.id}
              href={`/receipts/trips/${trip.id}`}
              className="block rounded-[14px] border border-gray-200 bg-white p-4 transition-colors hover:border-amber-200 hover:bg-amber-50/30"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[15px] font-semibold text-gray-900">
                      {trip.trip_name?.trim() || "(unnamed trip)"}
                    </span>
                    <Pill tone={tripStatusTone(trip.status)} size="sm" dot>
                      {trip.status}
                    </Pill>
                  </div>
                  <div className="mt-1 text-[13px] text-gray-600">
                    {formatDate(trip.start_date)} – {formatDate(trip.end_date)}
                    {trip.primary_location ? ` · ${trip.primary_location}` : ""}
                  </div>
                  <div className="mt-0.5 text-[12px] text-gray-500">
                    {trip.cardholder_name} · {trip.line_count} line(s) ·{" "}
                    {trip.receipt_count} receipt(s)
                  </div>
                </div>
                <span className="shrink-0 text-[12px] font-medium text-amber-700">
                  Open →
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
