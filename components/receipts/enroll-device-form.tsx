"use client";

import { useState } from "react";

export function EnrollDeviceForm({ next }: { next: string }) {
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/receipts/devices/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Enrollment failed (${res.status}).`);
      }
      window.location.assign(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enrollment failed.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-gray-700">Device name</span>
        <input
          type="text"
          required
          maxLength={64}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. iPhone 15, MacBook Pro"
          className="mt-1 block w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
        />
      </label>
      {error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={submitting || label.trim().length === 0}
        className="w-full rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Trusting device…" : "Trust this device"}
      </button>
    </form>
  );
}
