"use client";

import { useState } from "react";
import { useToast } from "@/components/ui/toaster";
import { apiFetch } from "@/lib/use-api-error";

interface Props {
  initialCode: string;
}

export function PairMobileDeviceForm({ initialCode }: Props) {
  const [code, setCode] = useState(initialCode);
  const [label, setLabel] = useState("iPhone");
  const [busy, setBusy] = useState(false);
  const [pairedDeviceId, setPairedDeviceId] = useState<string | null>(null);
  const { toast } = useToast();

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (!/^DAZ-[A-Z0-9]{4}$/.test(trimmed)) {
      toast({
        tone: "error",
        title: "Invalid code",
        body: "Codes look like DAZ-7K3M.",
      });
      return;
    }
    setBusy(true);
    const result = await apiFetch<{ ok: true; deviceId: string }>(
      "/api/mobile/auth/complete-pairing",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: trimmed,
          label: label.trim() || "iPhone",
          platform: "ios",
        }),
      },
    );
    setBusy(false);
    if (!result.ok) {
      toast({
        tone: "error",
        title: "Pairing failed",
        body: result.error.message,
      });
      return;
    }
    setPairedDeviceId(result.data.deviceId);
    toast({
      tone: "success",
      title: "iPhone paired",
      body: "The token is now on the phone.",
    });
  }

  if (pairedDeviceId) {
    return (
      <div className="space-y-2 text-sm text-gray-700">
        <p className="font-semibold text-gray-900">iPhone paired successfully.</p>
        <p>
          The phone should show <span className="font-medium">Paired</span>{" "}
          within a few seconds. The bearer token was delivered only to that
          device — close this tab.
        </p>
        <p className="text-xs text-gray-500">Device id: {pairedDeviceId}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-gray-600">
          Pairing code shown on the iPhone
        </span>
        <input
          type="text"
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          placeholder="DAZ-7K3M"
          autoComplete="off"
          spellCheck={false}
          className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 font-mono text-lg tracking-widest uppercase shadow-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
          maxLength={8}
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-gray-600">
          Device label (visible in the trusted-devices list)
        </span>
        <input
          type="text"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="iPhone 16 Pro"
          maxLength={80}
          className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Pairing…" : "Pair this iPhone"}
      </button>
    </form>
  );
}
