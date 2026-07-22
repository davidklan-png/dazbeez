"use client";

import { useState } from "react";
import Link from "next/link";
import { useToast } from "@/components/ui/toaster";
import { apiFetch } from "@/lib/use-api-error";

export interface DeviceListItem {
  id: string;
  label: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  platform: string | null;
  appVersion: string | null;
  /** Owner email — set only in owner/admin view so each row shows whose it is. */
  owner?: string | null;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export function DeviceList({
  devices,
  isOwnerView = false,
}: {
  devices: DeviceListItem[];
  isOwnerView?: boolean;
}) {
  const [items, setItems] = useState(devices);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { toast } = useToast();

  async function revoke(id: string, label: string) {
    if (
      !confirm(
        `Revoke "${label}"? This mobile device will lose receipts API access and must be paired again.`,
      )
    ) {
      return;
    }
    setBusyId(id);
    const result = await apiFetch(`/api/receipts/devices/${id}/revoke`, {
      method: "POST",
    });
    setBusyId(null);
    if (!result.ok) {
      toast({
        tone: "error",
        title: "Revoke failed",
        body: result.error.message,
      });
      return;
    }
    setItems((prev) => prev.filter((d) => d.id !== id));
    toast({ tone: "success", title: "Device revoked", body: label });
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
        <p>No mobile devices are paired.</p>
        <p className="mt-1">
          Pair an iPhone or Android device from{" "}
          <Link
            href="/receipts/pair"
            className="font-medium text-amber-700 hover:underline"
          >
            Pair a device
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        {items.map((d) => (
          <li
            key={d.id}
            className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-semibold text-gray-900">
                  {d.label}
                </p>
                {d.platform === "ios" || d.platform === "android" ? (
                  <span className="rounded-full bg-gray-900 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white">
                    {d.platform === "ios" ? "iPhone" : "Android"}
                    {d.appVersion ? ` · ${d.appVersion}` : ""}
                  </span>
                ) : null}
                {isOwnerView && d.owner ? (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
                    {d.owner}
                  </span>
                ) : null}
              </div>
              {d.userAgent ? (
                <p className="mt-1 truncate text-xs text-gray-500">
                  {d.userAgent}
                </p>
              ) : null}
              <p className="mt-1 text-xs text-gray-500">
                Paired {formatDate(d.createdAt)} · Last used{" "}
                {formatDate(d.lastSeenAt)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => revoke(d.id, d.label)}
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
