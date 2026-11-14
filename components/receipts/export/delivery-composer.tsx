"use client";

import Link from "next/link";
import { useState } from "react";
import type { ComposedDelivery } from "@/lib/receipts/delivery-compose";

/**
 * Delivery composer UI (delivery-composer §4). Renders the server-composed
 * delivery (From/To/Cc, subject, body, attachment, preflight) READ-ONLY and
 * provides Confirm → Send with a composition fingerprint and observed ownership
 * posted to /api/receipts/export/{month}/send
 * — the route recomposes server-side from the sealed pack + Settings, compares
 * its own hash, and 409s on mismatch, so a client cannot change what is sent
 * (decision 2) and a stale render cannot silently send a different pack (Item
 * 2). Sealing ≠ closing (decision 5): the seal is the midpoint, delivery closes
 * the month for reporting.
 */
export function DeliveryComposer({
  composed: initialComposed,
  monthLabel,
}: {
  composed: ComposedDelivery;
  monthLabel: string;
}) {
  // The composition can change under the operator (a Settings edit, or a new
  // revision finalized while the page is open). Hold it in state so a 409
  // composition-stale response can swap in the FRESH composition and require
  // re-confirmation (Item 2) — never silently send a different pack than the
  // one reviewed.
  const [composed, setComposed] = useState(initialComposed);
  const month = composed.month;
  const hasBytes = composed.zipSha256.length > 0;
  const configBlocked = composed.configErrors.length > 0 || !hasBytes;

  // Two-step confirm for the primary (new / resume) send.
  const [confirmed, setConfirmed] = useState(false);
  // Separate confirm for the de-emphasised force-new re-send.
  const [forceConfirmed, setForceConfirmed] = useState(false);
  const [phase, setPhase] = useState<"idle" | "sending" | "sent" | "failed">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [sentInfo, setSentInfo] = useState<{
    to: string | null;
    messageId: string | null;
    at: string;
  } | null>(null);

  const passedCount = composed.preflight.results.filter((r) => r.passed).length;
  const totalCount = composed.preflight.results.length;
  const preflightBlocked = hasBytes && !composed.preflight.passed;

  async function doSend(forceNew: boolean) {
    setPhase("sending");
    setError(null);
    setConfirmed(false);
    setForceConfirmed(false);
    let confirmedSent = false;
    try {
      const url = `/api/receipts/export/${month}/send${forceNew ? "?force_new=true" : ""}`;
      // Server recomposes the content; ownership binds force_new to this review.
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compositionHash: composed.compositionHash,
          observedGeneration: composed.observedGeneration, observedAttemptId: composed.observedAttemptId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        state?: string;
        error?: string;
        messageId?: string | null;
        configErrors?: string[];
        reason?: string;
        classification?: string;
        resumable?: boolean;
        compositionStale?: boolean;
        composition?: ComposedDelivery;
      };
      if (res.ok && data.state === "delivered") {
        confirmedSent = true;
        setSentInfo({
          to: composed.to,
          messageId: data.messageId ?? null,
          at: new Date().toLocaleString("ja-JP"),
        });
        setPhase("sent");
        return;
      }
      if (res.status === 409) {
        setConfirmed(false);
        setForceConfirmed(false);
        // Composition-stale (Item 2): the composition changed between render and
        // send (Settings edited, or a new revision finalized). Replace the
        // displayed composition with the FRESH one from the route and require
        // re-confirmation — never silently send the updated pack. Distinct from
        // the double-send guard below, which is a different 409.
        if (data.compositionStale && data.composition) {
          setComposed(data.composition);
          setConfirmed(false);
          setForceConfirmed(false);
          setPhase("idle");
          setError(
            data.error ??
              "提出内容が変わりました。もう一度確認のうえ送信してください。",
          );
          return;
        }
        // Double-send guard fired between load and click (race) or the displayed
        // action was 'blocked'. Surface the route's reason and stay on the
        // composer so the operator can re-send with force_new if intended.
        setError(
          data.error ??
            "This month cannot be sent right now (double-send guard). Reload to refresh.",
        );
        setPhase("failed");
        return;
      }
      if (res.status === 422) {
        setError(data.error ?? "Pre-send check failed.");
        setPhase("failed");
        return;
      }
      if (res.ok && data.state === "sealed_undelivered") {
        setError(
          (data.error ?? "Send failed.") +
            (data.resumable
              ? " — 再開可能（同じ idempotency key で再試行できます）。"
              : " — 再試行してください。"),
        );
        setPhase("failed");
        return;
      }
      setError(data.error ?? `Send failed (HTTP ${res.status}).`);
      setPhase("failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
      setPhase("failed");
    } finally {
      if (!confirmedSent) {
        // Lost responses and failed overrides may have advanced server ownership.
        try {
          const preview = await fetch(`/api/receipts/export/${month}/delivery-preview`, { cache: "no-store" });
          if (preview.ok) {
            setComposed(await preview.json() as ComposedDelivery);
            setConfirmed(false);
            setForceConfirmed(false);
          }
        } catch { /* The visible error still requires a manual refresh. */ }
      }
    }
  }

  // ── Success state — show confirmation, do NOT auto-redirect (decision 4). ──
  if (phase === "sent" && sentInfo) {
    return (
      <div className="rounded-2xl border border-green-200 bg-green-50 p-6">
        <h1 className="text-lg font-bold text-green-900">送信完了</h1>
        <p className="mt-2 text-sm text-green-800">
          {monthLabel} の領収証憑一式を{" "}
          <span className="font-mono font-semibold">{sentInfo.to}</span>{" "}
          宛てに送信しました。この月のレポート出力用のクローズ処理が完了しました。
        </p>
        <p className="mt-1 text-xs text-green-700">
          送信日時: {sentInfo.at}
          {sentInfo.messageId ? ` · Resend message id: ${sentInfo.messageId}` : ""}
        </p>
        <div className="mt-4 flex gap-3">
          <Link
            href={`/receipts/export?month=${month}`}
            className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600"
          >
            エクスポート画面に戻る
          </Link>
          <Link
            href="/receipts"
            className="rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            ダッシュボード
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header — decision 5: sealed ≠ delivered. */}
      <div>
        <h1 className="text-[22px] font-bold text-gray-900">
          {monthLabel} の送信
        </h1>
        <p className="mt-1 text-[13px] text-gray-600">
          {composed.sealedAt ? (
            <>
              確定（seal）済み ·{" "}
              <span className="text-gray-500">
                {new Date(composed.sealedAt).toLocaleString("ja-JP")}
              </span>
            </>
          ) : (
            "確定（seal）済み"
          )}{" "}
          · <strong className={phase !== "sending" && composed.deliveryState === "delivered" ? "text-green-700" : "text-amber-700"}>
            {phase === "sending" ? "送信結果を確認中です。完了するまでクローズされません。"
              : composed.deliveryState === "delivered" ? "送信済み · レポート用のクローズ処理は完了しています。"
              : composed.deliveryState === "pending" ? "送信結果を確認中です。完了するまでクローズされません。"
              : composed.deliveryState === "sealed_undelivered" ? "前回の送信は未完了です。結果不明の場合があります。"
              : "まだ送信されていません。この月は送信完了までレポート用にクローズされません。"}
          </strong>
        </p>
      </div>

      {/* Config-error state — replaces the From/To/Cc block; Send disabled. */}
      {configBlocked ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5">
          <h2 className="text-sm font-semibold text-red-800">
            送信できません — 設定を確認してください
          </h2>
          <ul className="mt-2 space-y-1 text-[13px] text-red-700">
            {composed.configErrors.map((e, i) => (
              <li key={i}>• {e}</li>
            ))}
          </ul>
          <Link
            href="/receipts/settings/compliance"
            className="mt-3 inline-block rounded-lg bg-white px-3 py-1.5 text-[12px] font-semibold text-amber-700 border border-amber-300 hover:bg-amber-50"
          >
            Settings → Compliance で編集
          </Link>
        </div>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
          <ReadonlyRow label="From" value={composed.from} mono />
          <ReadonlyRow label="To" value={composed.to} mono />
          <ReadonlyRow
            label="Cc"
            value={composed.cc ?? null}
            mono
            emptyDisplay="（なし）"
          />
          <ReadonlyRow
            label="Reply-To"
            value={composed.replyTo ?? null}
            mono
            emptyDisplay="（なし）"
          />
        </div>
      )}

      {/* Subject — read-only */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          件名 / Subject
        </div>
        <div className="mt-1 text-[14px] font-medium text-gray-900">
          {composed.subject}
        </div>
      </div>

      {/* Body preview — read-only, pre-wrap, visually distinct. */}
      {hasBytes && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/40 p-5">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
              本文プレビュー / Body (read-only)
            </div>
            <Link
              href="/receipts/settings/compliance"
              className="text-[11px] font-medium text-gray-500 hover:text-amber-700"
            >
              署名を Settings で編集
            </Link>
          </div>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-amber-200 bg-white px-4 py-3 font-sans text-[13px] leading-relaxed text-gray-800">
            {composed.text}
          </pre>
          <div className="mt-1.5 text-[11px] text-gray-500">
            署名:{" "}
            {composed.signature
              ? "あり（本文末尾に挿入）"
              : "なし（Settings → Compliance で設定可能）"}
          </div>
        </div>
      )}

      {/* Attachment — filename, size, SHA-256 + copy. */}
      {hasBytes && (
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            添付 / Attachment
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px]">
            <span className="font-medium text-gray-900">{composed.zipFilename}</span>
            <span className="text-gray-500">{formatBytes(composed.zipBytes)}</span>
          </div>
          <ShaCopy sha={composed.zipSha256} />
        </div>
      )}

      {/* Preflight — collapsed green or expanded red. */}
      {hasBytes && (
        <PreflightBlock
          passed={composed.preflight.passed}
          passedCount={passedCount}
          totalCount={totalCount}
          results={composed.preflight.results}
        />
      )}

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {/* Action area — new / resume / blocked, with the two-step confirm.
          Hidden entirely when config-blocked: sending is impossible regardless
          of action, and the config-error panel + Settings link is the only CTA
          needed (avoids a misleading "blocked/stale" panel beside a missing-ZIP
          error). */}
      {!configBlocked &&
        (composed.action === "blocked" ? (
          <BlockedAction
            blockedReason={composed.blockedReason ?? "stale"}
            deliveryState={composed.deliveryState}
            forceConfirmed={forceConfirmed}
            setForceConfirmed={setForceConfirmed}
            sending={phase === "sending"}
            onSend={() => doSend(true)}
          />
        ) : (
          <PrimaryAction
            action={composed.action}
            monthLabel={monthLabel}
            priorAttemptState={composed.priorAttemptState}
            confirmed={confirmed}
            setConfirmed={setConfirmed}
            sending={phase === "sending"}
            disabled={
              configBlocked ||
              preflightBlocked ||
              !confirmed ||
              phase === "sending"
            }
            onSend={() => doSend(false)}
          />
        ))}
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function ReadonlyRow({
  label,
  value,
  mono,
  emptyDisplay,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  emptyDisplay?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-4">
      <div className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div
        className={`text-[13px] text-gray-900 ${mono ? "font-mono" : ""} ${
          value ? "" : "text-gray-400"
        }`}
      >
        {value ?? emptyDisplay ?? "—"}
      </div>
    </div>
  );
}

function ShaCopy({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the full sha is still selectable in the monospace block */
    }
  }
  const short = sha.length > 16 ? `${sha.slice(0, 12)}…${sha.slice(-8)}` : sha;
  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="font-mono text-[11px] text-gray-500" title={sha}>
        SHA-256: {short}
      </span>
      <button
        type="button"
        onClick={copy}
        className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-gray-600 hover:bg-gray-50"
      >
        {copied ? "コピー済み" : "コピー"}
      </button>
    </div>
  );
}

function PreflightBlock({
  passed,
  passedCount,
  totalCount,
  results,
}: {
  passed: boolean;
  passedCount: number;
  totalCount: number;
  results: { name: string; passed: boolean; detail?: string }[];
}) {
  if (passed) {
    return (
      <div className="rounded-2xl border border-green-200 bg-green-50 px-5 py-3 text-[13px] text-green-800">
        <strong>Pre-flight: {passedCount}/{totalCount} checks passed</strong>
        <span className="ml-2 text-green-600">— pack is ready to send.</span>
      </div>
    );
  }
  const failed = results.filter((r) => !r.passed);
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-5">
      <div className="text-[13px] font-semibold text-red-800">
        Pre-flight: {passedCount}/{totalCount} checks passed — 送信できません
      </div>
      <ul className="mt-2 space-y-1 text-[12px] text-red-700">
        {failed.map((r, i) => (
          <li key={i}>
            <span className="font-mono">✗ {r.name}</span>
            {r.detail ? <span className="text-red-600"> — {r.detail}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PrimaryAction({
  action,
  monthLabel,
  priorAttemptState,
  confirmed,
  setConfirmed,
  sending,
  disabled,
  onSend,
}: {
  action: "new" | "resume" | "redelivery";
  monthLabel: string;
  /** Set when action === "redelivery": the earlier-revision attempt's state.
   *  Drives whether the copy says the earlier pack WAS delivered (sent) or only
   *  MAY have been (pending/ambiguous). */
  priorAttemptState?: ComposedDelivery["priorAttemptState"];
  confirmed: boolean;
  setConfirmed: (v: boolean) => void;
  sending: boolean;
  disabled: boolean;
  onSend: () => void;
}) {
  // For redelivery, `sent` means the earlier pack was definitely delivered;
  // `pending`/`ambiguous` mean it may have been. The copy must not overclaim.
  const earlierDelivered = priorAttemptState === "sent";
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      {action === "resume" && (
        <p className="mb-3 text-[12px] text-gray-600">
          前回の送信試行を再開します（同じ idempotency key を再利用するため、Resend
          が重複配送することはありません）。
        </p>
      )}
      {action === "redelivery" && (
        <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-[12px] text-amber-800">
          {earlierDelivered ? (
            <>
              <strong>再配送（会計士に 2 通目のメールが届きます）</strong> — 前の改訂版は
              既に会計士へ送信済みです。ここでの送信は今回の改訂版の<strong>初回</strong>送信ですが、
              会計士には 2 通目のメールが届きます。同じ改訂版の重複配送ではないため force_new は不要です
              （監査ログには再配送として記録され、override 扱いにはなりません）。
            </>
          ) : (
            <>
              <strong>再配送（会計士に 2 通目のメールが届く可能性があります）</strong> — 前の改訂版の
              送信は完了していません（送信中、または結果不明のため、会計士に届いている可能性があります）。
              ここでの送信は今回の改訂版の<strong>初回</strong>送信ですが、会計士に 2 通目のメールが
              届く可能性があります。同じ改訂版の重複配送ではないため force_new は不要です
              （監査ログには再配送として記録されます）。
            </>
          )}
        </div>
      )}
      <label className="flex items-start gap-2.5 text-[13px] text-gray-700">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-amber-500"
        />
        <span>
          宛先・件名・本文・添付を確認しました。{" "}
          <strong>
            {action === "redelivery"
              ? earlierDelivered
                ? `「再配送」をクリックすると ${monthLabel} の領収証憑一式が再配送され、会計士に 2 通目のメールが送信されます。`
                : `「再配送」をクリックすると ${monthLabel} の領収証憑一式が再配送され、会計士に 2 通目のメールが送信される可能性があります。`
              : `「送信」をクリックすると ${monthLabel} の領収証憑一式が送信されます。`}
          </strong>
        </span>
      </label>
      <button
        type="button"
        onClick={onSend}
        disabled={disabled}
        className="mt-4 w-full rounded-xl bg-amber-500 px-4 py-3 text-sm font-semibold text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {sending
          ? "送信中… この画面を閉じないでください"
          : action === "resume"
            ? "送信を再開"
            : action === "redelivery"
              ? "再配送する"
              : "送信する"}
      </button>
    </div>
  );
}

function BlockedAction({
  blockedReason,
  deliveryState,
  forceConfirmed,
  setForceConfirmed,
  sending,
  onSend,
}: {
  blockedReason: "sent" | "stale";
  deliveryState: ComposedDelivery["deliveryState"];
  forceConfirmed: boolean;
  setForceConfirmed: (v: boolean) => void;
  sending: boolean;
  onSend: () => void;
}) {
  const delivered = blockedReason === "sent";
  return (
    <div className="space-y-3">
      <div
        className={`rounded-2xl border px-5 py-4 text-[13px] ${
          delivered
            ? "border-green-200 bg-green-50 text-green-800"
            : "border-amber-200 bg-amber-50 text-amber-800"
        }`}
      >
        {delivered ? (
          <span>
            <strong>この改訂版には送信済みの履歴があります。</strong>{" "}
            {deliveryState === "delivered" ? "レポート用のクローズ処理も完了しています。"
              : "現在の送信試行は未完了です。再送信は重複メールになる可能性があります。"}
          </span>
        ) : (
          <span>
            前回の送信結果は不明の可能性があります。23 時間の安全期限、または送信内容の変更・記録不足により再開できません。画面を更新し、宛先・本文・添付を確認してください。
          </span>
        )}
      </div>
      <details className="rounded-2xl border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer text-[12px] font-medium text-gray-500 hover:text-gray-700">
          再送信（監査記録あり） — force_new
        </summary>
        <p className="mt-2 text-[12px] text-gray-600">
          新しい attempt id で再送信します。この操作は監査ログに記録されます（export.delivery_override）。
        </p>
        <label className="mt-3 flex items-start gap-2.5 text-[13px] text-gray-700">
          <input
            type="checkbox"
            checked={forceConfirmed}
            onChange={(e) => setForceConfirmed(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-amber-500"
          />
          <span>再送信することを確認しました。</span>
        </label>
        <button
          type="button"
          onClick={onSend}
          disabled={!forceConfirmed || sending}
          className="mt-3 rounded-xl border border-gray-300 bg-white px-4 py-2 text-[12px] font-semibold text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? "送信中…" : "再送信（監査記録あり）"}
        </button>
      </details>
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}
