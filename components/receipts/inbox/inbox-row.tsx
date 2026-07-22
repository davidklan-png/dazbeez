"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { EmailReceiptIntake } from "@/lib/receipts/types";
import { extractLinks } from "@/lib/receipts/email-parse";

const BODY_PREVIEW_CHARS = 200;

/**
 * One triage row in /receipts/inbox. Promote creates a real receipt (the row
 * then leaves pending_triage and disappears on refresh); Reject requires a
 * reason. Promote is disabled when the row has no promotable attachment
 * (mirrors the server assertPromotable check) and the reject_reason is shown
 * inline so the operator sees WHY it can't be promoted.
 *
 * ADR 0011 Phase A: the parsed email body (body_text always; body_html behind a
 * sandboxed-iframe toggle) and extracted links are surfaced here. Links are
 * always visible when present — finding a verification link (e.g. the Gmail
 * forwarding confirmation) fast is the actual point of capturing the body.
 */
export function InboxRow({
  intake,
  senderState = "unrecognized",
}: {
  intake: EmailReceiptIntake;
  senderState?: "trusted" | "blocked" | "unrecognized";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [bodyOpen, setBodyOpen] = useState(false);
  const [htmlSrcDoc, setHtmlSrcDoc] = useState<string | null>(null);
  const [htmlLoading, setHtmlLoading] = useState(false);

  const promotable =
    intake.status === "pending_triage" &&
    (!!intake.attachment_r2_key || !!intake.body_text || !!intake.body_html);

  // extractLinks is dependency-free (email-parse.ts has no bindings), safe to
  // call in this client component. Memoized so a re-render doesn't re-scan up
  // to 512 KiB of body_html.
  const links = useMemo(
    () => extractLinks(intake.body_text, intake.body_html),
    [intake.body_text, intake.body_html],
  );

  const hasBody = !!(intake.body_text || intake.body_html);
  const bodyText = intake.body_text ?? "";
  const bodyPreview =
    bodyText.length > BODY_PREVIEW_CHARS
      ? `${bodyText.slice(0, BODY_PREVIEW_CHARS)}…`
      : bodyText;
  // Only show the expand toggle when there's more than the preview, or an HTML
  // part to render — otherwise the preview already shows everything.
  const showBodyToggle =
    hasBody && (!!intake.body_html || bodyText.length > BODY_PREVIEW_CHARS);

  function refresh() {
    startTransition(() => {
      router.refresh();
    });
  }

  async function handlePromote() {
    setError(null);
    try {
      const res = await fetch(
        `/api/receipts/inbox/${encodeURIComponent(intake.id)}/promote`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Promote failed (HTTP ${res.status}).`);
      }
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Promote failed.");
    }
  }

  async function handleReject() {
    setError(null);
    if (!reason.trim()) {
      setError("A reject reason is required.");
      return;
    }
    try {
      const res = await fetch(
        `/api/receipts/inbox/${encodeURIComponent(intake.id)}/reject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Reject failed (HTTP ${res.status}).`);
      }
      setRejectOpen(false);
      setReason("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reject failed.");
    }
  }

  // Sanitize + reveal the HTML body. DOMPurify is dynamically imported so the
  // DOM lib stays out of the SSR/edge bundle; sanitize runs only in the browser
  // when the operator explicitly opts in. Defense in depth on top of the
  // sandbox="" iframe, which already blocks scripts/same-origin/popups/nav.
  async function handleViewHtml() {
    setError(null);
    if (htmlSrcDoc !== null) {
      setHtmlSrcDoc(null); // toggle off
      return;
    }
    if (!intake.body_html) return;
    setHtmlLoading(true);
    try {
      const DOMPurify = (await import("dompurify")).default;
      const clean = DOMPurify.sanitize(intake.body_html);
      setHtmlSrcDoc(clean);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to render HTML body.");
    } finally {
      setHtmlLoading(false);
    }
  }

  return (
    <li className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-gray-900">
            {intake.from_address}
          </p>
          <p className="truncate text-sm text-gray-600">
            {intake.subject || <span className="text-gray-400">(no subject)</span>}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">
            {formatReceived(intake.received_at)}
          </p>
          {intake.to_address && (
            <p className="truncate text-xs text-gray-400">→ {intake.to_address}</p>
          )}
        </div>
        <div className="flex flex-none items-center gap-1.5">
          <VerdictBadge label="SPF" pass={intake.spf_pass === 1} />
          <VerdictBadge label="DKIM" pass={intake.dkim_pass === 1} />
        </div>
      </div>

      <div className="mt-3">
        {intake.attachment_r2_key ? (
          <p className="text-xs text-gray-700">
            <span className="text-gray-400">Attachment: </span>
            {intake.attachment_filename || "untitled"}
            {intake.attachment_content_type
              ? ` · ${intake.attachment_content_type}`
              : ""}
          </p>
        ) : intake.body_text || intake.body_html ? (
          <p className="rounded-lg bg-sky-50 px-2.5 py-1.5 text-xs text-sky-800">
            Body-only receipt (no attachment). Promoting stores the raw body and
            queues it for Mac render → extraction.
          </p>
        ) : (
          <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
            {intake.reject_reason || "No promotable attachment."}
          </p>
        )}
      </div>

      {/* Body preview (collapsed). Body-only receipts are now visible at a glance. */}
      {bodyPreview && !bodyOpen && (
        <p className="mt-2 whitespace-pre-wrap break-words text-xs text-gray-500">
          {bodyPreview}
        </p>
      )}

      {/* Extracted links — always visible when present. This is the Gmail
          verification fast path: the operator sees the link without expanding. */}
      {links.length > 0 && (
        <div className="mt-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            Links in this email
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {links.map((url) => (
              <li key={url} className="truncate">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-amber-600 hover:text-amber-700 hover:underline"
                >
                  {url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {intake.body_truncated === 1 && (
        <p className="mt-1 text-[11px] text-amber-700">
          Body truncated at capture (very large message) — the links above may
          be incomplete.
        </p>
      )}

      {/* Expanded body: full text + opt-in sandboxed HTML. */}
      {bodyOpen && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
          {bodyText ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-xs text-gray-800">
              {bodyText}
            </pre>
          ) : (
            <p className="text-xs text-gray-400">No text body.</p>
          )}

          {intake.body_html && (
            <div className="mt-3">
              <button
                type="button"
                onClick={handleViewHtml}
                disabled={htmlLoading || isPending}
                className="rounded-lg border border-gray-300 px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
              >
                {htmlSrcDoc !== null
                  ? "Hide formatted HTML"
                  : htmlLoading
                    ? "Rendering…"
                    : "View as HTML (sandboxed)"}
              </button>
              {htmlSrcDoc !== null && (
                <iframe
                  title="Email HTML body"
                  srcDoc={htmlSrcDoc}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  className="mt-2 h-96 w-full rounded-md border border-gray-300 bg-white"
                />
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="mt-2 text-xs font-medium text-red-600">{error}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* Sender-state badge */}
        {senderState === "trusted" && (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-800">Trusted</span>
        )}
        {senderState === "blocked" && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">Blocked</span>
        )}
        {senderState === "unrecognized" && (
          <>
            <button
              type="button"
              onClick={async () => {
                setError(null);
                try {
                  const res = await fetch("/api/receipts/settings/trusted-senders", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ email: intake.from_address }),
                  });
                  if (!res.ok) throw new Error(`Trust failed (HTTP ${res.status})`);
                  refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Trust sender failed.");
                }
              }}
              disabled={isPending}
              className="rounded-lg border border-green-200 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-50"
            >
              Trust sender
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!confirm(
                  `Block ${intake.from_address}?\n\nThis blocks the sender for future mail AND rejects this message. ` +
                  `Future mail from this address will be recorded as metadata only (no body or attachments).`,
                )) return;
                setError(null);
                try {
                  const res = await fetch(
                    `/api/receipts/inbox/${encodeURIComponent(intake.id)}/block-sender`,
                    { method: "POST" },
                  );
                  if (!res.ok) {
                    const body = (await res.json().catch(() => ({}))) as { error?: string };
                    throw new Error(body.error ?? `Block failed (HTTP ${res.status})`);
                  }
                  refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Block sender failed.");
                }
              }}
              disabled={isPending}
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
            >
              Block sender
            </button>
          </>
        )}
        <button
          type="button"
          onClick={handlePromote}
          disabled={!promotable || isPending}
          className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
          title={promotable ? "Promote to a real receipt" : "Nothing to promote"}
        >
          Promote
        </button>
        <button
          type="button"
          onClick={() => {
            setRejectOpen((v) => !v);
            setError(null);
          }}
          disabled={isPending}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
        >
          {rejectOpen ? "Cancel" : "Reject"}
        </button>
        {showBodyToggle && (
          <button
            type="button"
            onClick={() => {
              setBodyOpen((v) => !v);
              if (bodyOpen) setHtmlSrcDoc(null);
            }}
            disabled={isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
          >
            {bodyOpen ? "Hide body" : "Show full body"}
          </button>
        )}
      </div>

      {rejectOpen && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <label className="block text-xs font-medium text-gray-600">
            Reason (required)
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:border-amber-500 focus:outline-none"
              placeholder="e.g. personal expense, not a business receipt"
            />
          </label>
          <button
            type="button"
            onClick={handleReject}
            disabled={isPending}
            className="mt-2 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
          >
            Confirm reject
          </button>
        </div>
      )}
    </li>
  );
}

function VerdictBadge({ label, pass }: { label: string; pass: boolean }) {
  return (
    <span
      title={`${label} ${pass ? "pass" : "fail"}`}
      className={[
        "rounded-full px-2 py-0.5 text-[10px] font-semibold",
        pass
          ? "bg-green-100 text-green-800"
          : "bg-red-100 text-red-700",
      ].join(" ")}
    >
      {label} {pass ? "✓" : "✗"}
    </span>
  );
}

function formatReceived(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}
