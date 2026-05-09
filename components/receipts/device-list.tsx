"use client";

import { useState } from "react";

export interface DeviceListItem {
  id: string;
  label: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  isCurrent: boolean;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export function DeviceList({ devices }: { devices: DeviceListItem[] }) {
  const [items, setItems] = useState(devices);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revoke(id: string, isCurrent: boolean) {
    if (
      !confirm(
        isCurrent
          ? "Revoke this device? You'll be signed out and need to re-trust it via Cloudflare Access."
          : "Revoke this device?",
      )
    ) {
      return;
    }
    setError(null);
    setBusyId(id);
    try {
      const res = await fetch(`/api/receipts/devices/${id}/revoke`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Revoke failed (${res.status}).`);
      }
      if (isCurrent) {
        window.location.assign("/receipts/enroll");
        return;
      }
      setItems((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revoke failed.");
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
        No trusted devices yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <ul className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        {items.map((d) => (
          <li
            key={d.id}
            className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-semibold text-gray-900">
                  {d.label}
                </p>
                {d.isCurrent ? (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-800">
                    This device
                  </span>
                ) : null}
              </div>
              {d.userAgent ? (
                <p className="mt-1 truncate text-xs text-gray-500">
                  {d.userAgent}
                </p>
              ) : null}
              <p className="mt-1 text-xs text-gray-500">
                Added {formatDate(d.createdAt)} · Last used{" "}
                {formatDate(d.lastSeenAt)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => revoke(d.id, d.isCurrent)}
              disabled={busyId === d.id}
              className="self-start rounded-xl border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
            >
              {busyId === d.id ? "Revoking…" : "Revoke"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
