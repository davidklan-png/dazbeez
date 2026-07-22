"use client";

import { useState } from "react";
import { useToast } from "@/components/ui/toaster";
import type { TrustedIntakeSender } from "@/lib/receipts/trusted-senders";
import type { SenderActivityGroup, BlockedSenderWithActivity } from "@/lib/receipts/sender-activity";

type Snapshot = {
  trusted: TrustedIntakeSender[];
  blocked: BlockedSenderWithActivity[];
  unrecognized: SenderActivityGroup[];
};

// ─── Pure client-side snapshot validation ──────────────────────────────────
// Exported for unit testing.

export function isValidSnapshot(data: unknown): data is Snapshot {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return Array.isArray(d.trusted) && Array.isArray(d.blocked) && Array.isArray(d.unrecognized);
}

/**
 * Execute a mutation, parse the JSON safely, validate the response is a
 * complete snapshot. Throws on non-2xx, malformed JSON, or missing keys.
 * Never returns partial data.
 */
async function mutateAndValidate(
  url: string,
  init: RequestInit,
): Promise<Snapshot> {
  const res = await fetch(url, init);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Server returned HTTP ${res.status} with non-JSON body.`);
  }
  if (!res.ok) {
    const errMsg = (body as { error?: string } | null)?.error;
    throw new Error(errMsg ?? `Request failed (HTTP ${res.status}).`);
  }
  if (!isValidSnapshot(body)) {
    throw new Error("Server returned a malformed snapshot (missing trusted, blocked, or unrecognized).");
  }
  return body;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function SenderControls({ initialTrusted, initialBlocked, initialUnrecognized }: {
  initialTrusted: TrustedIntakeSender[];
  initialBlocked: BlockedSenderWithActivity[];
  initialUnrecognized: SenderActivityGroup[];
}) {
  const { toast } = useToast();
  const [snap, setSnap] = useState<Snapshot>({
    trusted: initialTrusted,
    blocked: initialBlocked,
    unrecognized: initialUnrecognized,
  });
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyAddr, setBusyAddr] = useState<string | null>(null);

  const TRUST_SUCCESS = "Sender trusted for future eligible mail. Existing messages still require review.";

  // ── Add Trusted ────────────────────────────────────────────────────────
  async function addTrusted(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      const next = await mutateAndValidate("/api/receipts/settings/trusted-senders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      setSnap(next);
      setEmail("");
      toast({ tone: "success", title: "Sender trusted", body: TRUST_SUCCESS });
    } catch (e) {
      toast({ tone: "error", title: "Add failed", body: e instanceof Error ? e.message : "Unknown error." });
    } finally {
      setAdding(false);
    }
  }

  // ── Remove Trusted ──────────────────────────────────────────────────────
  async function removeTrusted(addr: string) {
    if (!confirm(`Remove ${addr} from the auto-promote allowlist?`)) return;
    setBusyAddr(addr);
    try {
      const next = await mutateAndValidate("/api/receipts/settings/trusted-senders", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addr }),
      });
      setSnap(next);
      toast({ tone: "success", title: "Sender removed", body: addr });
    } catch (e) {
      toast({ tone: "error", title: "Remove failed", body: e instanceof Error ? e.message : "Unknown error." });
    } finally {
      setBusyAddr(null);
    }
  }

  // ── Unblock ──────────────────────────────────────────────────────────────
  async function unblock(addr: string) {
    if (!confirm(`Unblock ${addr}?`)) return;
    setBusyAddr(addr);
    try {
      const next = await mutateAndValidate(
        `/api/receipts/settings/blocked-senders?email=${encodeURIComponent(addr)}`,
        { method: "DELETE" },
      );
      setSnap(next);
      toast({ tone: "success", title: "Sender unblocked", body: addr });
    } catch (e) {
      toast({ tone: "error", title: "Unblock failed", body: e instanceof Error ? e.message : "Unknown error." });
    } finally {
      setBusyAddr(null);
    }
  }

  // ── Trust Unrecognized ───────────────────────────────────────────────────
  async function trustUnrecognized(addr: string) {
    setBusyAddr(addr);
    try {
      const next = await mutateAndValidate("/api/receipts/settings/trusted-senders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addr }),
      });
      setSnap(next);
      toast({ tone: "success", title: "Sender trusted", body: TRUST_SUCCESS });
    } catch (e) {
      toast({ tone: "error", title: "Trust failed", body: e instanceof Error ? e.message : "Unknown error." });
    } finally {
      setBusyAddr(null);
    }
  }

  // ── Block Unrecognized ───────────────────────────────────────────────────
  async function blockUnrecognized(addr: string) {
    if (!confirm(`Block ${addr}?\n\nFuture mail will be recorded as metadata-only and immediately rejected.`)) return;
    setBusyAddr(addr);
    try {
      const next = await mutateAndValidate("/api/receipts/settings/blocked-senders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addr }),
      });
      setSnap(next);
      toast({ tone: "success", title: "Sender blocked", body: addr });
    } catch (e) {
      toast({ tone: "error", title: "Block failed", body: e instanceof Error ? e.message : "Unknown error." });
    } finally {
      setBusyAddr(null);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-8">
      {/* Security warning */}
      <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
        <p className="text-sm font-semibold text-red-800">Auto-promotion has no manual review step.</p>
        <p className="mt-1 text-xs text-red-700">A receipt is filed straight into the books the moment a body-only email from a trusted address lands (SPF and DKIM must also pass). Only add email addresses you control.</p>
      </div>

      {/* Trusted */}
      <section>
        <h2 className="text-sm font-bold text-gray-900">Trusted senders</h2>
        <p className="mt-0.5 text-xs text-gray-500">Trust applies only to mail received <strong>after</strong> the sender was trusted. Existing messages still require a manual Promote.</p>
        <form onSubmit={addTrusted} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block flex-1"><span className="text-xs font-medium text-gray-600">Add an email address</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-amber-500 focus:outline-none" /></label>
          <button type="submit" disabled={adding || !email.trim()} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50">{adding ? "Adding…" : "Add"}</button>
        </form>
        {snap.trusted.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-500">No trusted senders configured.</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white">
            {snap.trusted.map((s) => (
              <li key={s.email} className="flex items-center justify-between p-3">
                <div><p className="text-sm font-semibold text-gray-900">{s.email}</p><p className="text-xs text-gray-500">Added by {s.added_by} · {s.created_at.slice(0, 10)}</p></div>
                <button onClick={() => removeTrusted(s.email)} disabled={busyAddr === s.email} className="rounded-lg border border-red-200 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">Remove</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Blocked */}
      <section>
        <h2 className="text-sm font-bold text-gray-900">Blocked senders</h2>
        <p className="mt-0.5 text-xs text-gray-500">Future mail from these addresses retains delivery metadata only (no body, attachments, or raw headers) and is immediately rejected.</p>
        {snap.blocked.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-500">No blocked senders.</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white">
            {snap.blocked.map((b) => (
              <li key={b.email} className="flex items-center justify-between p-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{b.email}</p>
                  <p className="text-xs text-gray-500">Blocked by {b.blocked_by} · {b.created_at.slice(0, 10)}</p>
                  {b.blocked_delivery_count > 0 ? (
                    <p className="text-[11px] text-amber-700">{b.blocked_delivery_count} blocked deliver{b.blocked_delivery_count === 1 ? "y" : "ies"} · latest {b.latest_blocked_delivery?.slice(0, 16).replace("T", " ") ?? "—"}</p>
                  ) : (
                    <p className="text-[11px] text-gray-400">No deliveries recorded since blocking.</p>
                  )}
                </div>
                <button onClick={() => unblock(b.email)} disabled={busyAddr === b.email} className="rounded-lg border border-gray-300 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50">Unblock</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent unrecognized */}
      <section>
        <h2 className="text-sm font-bold text-gray-900">Recent unrecognized senders</h2>
        <p className="mt-0.5 text-xs text-gray-500">Senders not yet trusted or blocked, derived from recent inbox activity.</p>
        {snap.unrecognized.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-500">No unrecognized sender activity.</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white">
            {snap.unrecognized.map((u) => (
              <li key={u.from_address} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-gray-900">{u.from_address}</p>
                  <p className="text-xs text-gray-500">{u.total} msg · {u.pending} pending · {u.promoted} promo · {u.rejected} rej · first {u.first_received.slice(0, 10)} · latest {u.latest_received.slice(0, 10)}</p>
                  <p className="text-[10px] text-gray-400">SPF {u.spf_pass_any}✓/{u.spf_fail_any}✗ · DKIM {u.dkim_pass_any}✓/{u.dkim_fail_any}✗</p>
                </div>
                <div className="flex flex-none gap-1.5">
                  <button onClick={() => trustUnrecognized(u.from_address)} disabled={busyAddr === u.from_address} className="rounded-lg bg-green-50 border border-green-200 px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-50">Trust</button>
                  <button onClick={() => blockUnrecognized(u.from_address)} disabled={busyAddr === u.from_address} className="rounded-lg bg-red-50 border border-red-200 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50">Block</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
