"use client";

import { useState } from "react";
import { useToast } from "@/components/ui/toaster";
import type { TrustedIntakeSender } from "@/lib/receipts/trusted-senders";
import type { BlockedIntakeSender } from "@/lib/receipts/blocked-senders";
import type { SenderActivityGroup } from "@/lib/receipts/sender-activity";

/**
 * Three-section sender controls for Settings (ADR 0011 follow-up):
 * 1. Trusted — auto-promote allowlist (prospective trust note).
 * 2. Blocked — blocklist (metadata-only delivery note).
 * 3. Recent unrecognized — aggregated from email_receipt_intake, with Trust/Block.
 */
export function SenderControls({
  initialTrusted,
  initialBlocked,
  initialUnrecognized,
}: {
  initialTrusted: TrustedIntakeSender[];
  initialBlocked: BlockedIntakeSender[];
  initialUnrecognized: SenderActivityGroup[];
}) {
  const { toast } = useToast();

  // ─── Section 1: Trusted ──────────────────────────────────────────────────
  const [trusted, setTrusted] = useState(initialTrusted);
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);

  async function addTrusted(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      const res = await fetch("/api/receipts/settings/trusted-senders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as { senders?: TrustedIntakeSender[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setTrusted(data.senders ?? []);
      setEmail("");
      toast({ tone: "success", title: "Sender trusted", body: "Sender trusted for future eligible mail. Existing messages still require review." });
    } catch (e) {
      toast({ tone: "error", title: "Add failed", body: e instanceof Error ? e.message : "Failed." });
    } finally { setAdding(false); }
  }

  async function removeTrusted(addr: string) {
    if (!confirm(`Remove ${addr} from the auto-promote allowlist?`)) return;
    try {
      const res = await fetch("/api/receipts/settings/trusted-senders", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addr }),
      });
      const data = (await res.json().catch(() => ({}))) as { senders?: TrustedIntakeSender[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setTrusted(data.senders ?? []);
    } catch (e) {
      toast({ tone: "error", title: "Remove failed", body: e instanceof Error ? e.message : "Failed." });
    }
  }

  // ─── Section 2: Blocked ──────────────────────────────────────────────────
  const [blocked, setBlocked] = useState(initialBlocked);

  async function unblock(addr: string) {
    if (!confirm(`Unblock ${addr}? Future mail will go through normal triage.`)) return;
    try {
      const res = await fetch(`/api/receipts/settings/blocked-senders?email=${encodeURIComponent(addr)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { senders?: BlockedIntakeSender[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setBlocked(data.senders ?? []);
    } catch (e) {
      toast({ tone: "error", title: "Unblock failed", body: e instanceof Error ? e.message : "Failed." });
    }
  }

  // ─── Section 3: Unrecognized (Trust/Block actions) ───────────────────────
  const [unrecognized, setUnrecognized] = useState(initialUnrecognized);
  const [busyAddr, setBusyAddr] = useState<string | null>(null);

  async function trustUnrecognized(addr: string) {
    setBusyAddr(addr);
    try {
      const res = await fetch("/api/receipts/settings/trusted-senders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addr }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const trustedData = (await res.json().catch(() => ({}))) as { senders?: TrustedIntakeSender[] };
      setTrusted(trustedData.senders ?? []);
      setUnrecognized((prev) => prev.filter((u) => u.from_address !== addr));
      toast({ tone: "success", title: "Sender trusted", body: "Sender trusted for future eligible mail. Existing messages still require review." });
    } catch (e) {
      toast({ tone: "error", title: "Trust failed", body: e instanceof Error ? e.message : "Failed." });
    } finally { setBusyAddr(null); }
  }

  async function blockUnrecognized(addr: string) {
    if (!confirm(`Block ${addr}?\n\nFuture mail from this address will be recorded as metadata-only (no body, attachments, or headers) and immediately rejected.`)) return;
    setBusyAddr(addr);
    try {
      const res = await fetch("/api/receipts/settings/blocked-senders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addr }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blockedData = (await res.json().catch(() => ({}))) as { senders?: BlockedIntakeSender[] };
      setBlocked(blockedData.senders ?? []);
      setUnrecognized((prev) => prev.filter((u) => u.from_address !== addr));
      toast({ tone: "success", title: "Sender blocked", body: addr });
    } catch (e) {
      toast({ tone: "error", title: "Block failed", body: e instanceof Error ? e.message : "Failed." });
    } finally { setBusyAddr(null); }
  }

  return (
    <div className="space-y-8">
      {/* ─── Section 1: Trusted ─── */}
      <section>
        <h2 className="text-sm font-bold text-gray-900">Trusted senders</h2>
        <p className="mt-0.5 text-xs text-gray-500">
          These addresses auto-file body-only receipts. Trust applies only to
          mail received <strong>after</strong> the sender was trusted — existing
          messages still require a manual Promote.
        </p>
        <form onSubmit={addTrusted} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block flex-1">
            <span className="text-xs font-medium text-gray-600">Add an email address</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required
              className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-amber-500 focus:outline-none" />
          </label>
          <button type="submit" disabled={adding || !email.trim()}
            className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
            {adding ? "Adding…" : "Add"}
          </button>
        </form>
        {trusted.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-500">
            No trusted senders configured.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white">
            {trusted.map((s) => (
              <li key={s.email} className="flex items-center justify-between p-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{s.email}</p>
                  <p className="text-xs text-gray-500">Added by {s.added_by} · {s.created_at.slice(0, 10)}</p>
                </div>
                <button onClick={() => removeTrusted(s.email)} className="rounded-lg border border-red-200 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50">Remove</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ─── Section 2: Blocked ─── */}
      <section>
        <h2 className="text-sm font-bold text-gray-900">Blocked senders</h2>
        <p className="mt-0.5 text-xs text-gray-500">
          Future mail from these addresses retains delivery metadata only (no
          body, attachments, or raw headers) and is immediately rejected.
        </p>
        {blocked.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-500">
            No blocked senders.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white">
            {blocked.map((b) => (
              <li key={b.email} className="flex items-center justify-between p-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{b.email}</p>
                  <p className="text-xs text-gray-500">Blocked by {b.blocked_by} · {b.created_at.slice(0, 10)}</p>
                </div>
                <button onClick={() => unblock(b.email)} className="rounded-lg border border-gray-300 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100">Unblock</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ─── Section 3: Recent unrecognized ─── */}
      <section>
        <h2 className="text-sm font-bold text-gray-900">Recent unrecognized senders</h2>
        <p className="mt-0.5 text-xs text-gray-500">
          Senders not yet trusted or blocked, derived from recent inbox activity.
        </p>
        {unrecognized.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-500">
            No unrecognized sender activity.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white">
            {unrecognized.map((u) => (
              <li key={u.from_address} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-gray-900">{u.from_address}</p>
                  <p className="text-xs text-gray-500">
                    {u.total} message{u.total === 1 ? "" : "s"} · {u.pending} pending · {u.promoted} promoted · {u.rejected} rejected
                    {" · "}latest {u.latest_received.slice(0, 10)}
                  </p>
                </div>
                <div className="flex flex-none gap-1.5">
                  <button onClick={() => trustUnrecognized(u.from_address)} disabled={busyAddr === u.from_address}
                    className="rounded-lg bg-green-50 border border-green-200 px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-50">Trust</button>
                  <button onClick={() => blockUnrecognized(u.from_address)} disabled={busyAddr === u.from_address}
                    className="rounded-lg bg-red-50 border border-red-200 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50">Block</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
