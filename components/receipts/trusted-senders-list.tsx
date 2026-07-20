"use client";

import { useState } from "react";
import { useToast } from "@/components/ui/toaster";
import type { TrustedIntakeSender } from "@/lib/receipts/trusted-senders";

/**
 * Client list for the Trusted intake senders Settings page. Add form + per-row
 * remove. Each mutation re-fetches the authoritative list from the API
 * response (the route returns `{ senders }` after every change) so local state
 * never drifts from D1. Mirrors device-list.tsx's toast + busy-state pattern.
 */
export function TrustedSendersList({ initial }: { initial: TrustedIntakeSender[] }) {
  const [items, setItems] = useState(initial);
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const { toast } = useToast();

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      const res = await fetch("/api/receipts/settings/trusted-senders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        senders?: TrustedIntakeSender[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Failed (HTTP ${res.status})`);
      }
      setItems(data.senders ?? []);
      setEmail("");
      toast({ tone: "success", title: "Sender added", body: trimmed });
    } catch (e) {
      toast({
        tone: "error",
        title: "Add failed",
        body: e instanceof Error ? e.message : "Failed to add sender.",
      });
    } finally {
      setAdding(false);
    }
  }

  async function remove(emailToRemove: string) {
    if (
      !confirm(
        `Remove ${emailToRemove} from the auto-promote allowlist? Future body-only emails from this address will need a manual Promote.`,
      )
    ) {
      return;
    }
    setBusyEmail(emailToRemove);
    try {
      const res = await fetch("/api/receipts/settings/trusted-senders", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailToRemove }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        senders?: TrustedIntakeSender[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Failed (HTTP ${res.status})`);
      }
      setItems(data.senders ?? []);
      toast({ tone: "success", title: "Sender removed", body: emailToRemove });
    } catch (e) {
      toast({
        tone: "error",
        title: "Remove failed",
        body: e instanceof Error ? e.message : "Failed to remove sender.",
      });
    } finally {
      setBusyEmail(null);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <label className="block flex-1">
          <span className="text-xs font-medium text-gray-600">Add an email address</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-amber-500 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={adding || !email.trim()}
          className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {adding ? "Adding…" : "Add"}
        </button>
      </form>

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
          No trusted senders configured. Body-only receipts from any address
          currently require a manual Promote in the inbox.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          {items.map((s) => (
            <li
              key={s.email}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">
                  {s.email}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  Added by {s.added_by} · {formatDate(s.created_at)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => remove(s.email)}
                disabled={busyEmail === s.email}
                className="self-start rounded-xl border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
              >
                {busyEmail === s.email ? "Removing…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}
