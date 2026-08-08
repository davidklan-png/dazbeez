// Finalize notification email.
//
// On successful finalize, email the notification recipient a Japanese summary
// (month, revision, counts, per-category totals, transition notice, download
// link). Transport: Resend REST API (POST api.resend.com/emails) — replaces the
// former Cloudflare Email Routing send_email binding.
//
// Recipient resolution: Settings → Compliance (notification_recipient) →
// ACCOUNTANT_EMAIL var fallback → unconfigured {ok:false}.
//
// HARD RULE: email failure must never fail finalize. sendFinalizeNotification
// never throws — it returns {ok, error?}; callers fold the result into the
// finalize response warnings + an audit entry (notification_sent /
// notification_failed), and finalize returns 200 regardless.

import {
  getAccountantEmail,
  getNotifyFromAddress,
  getResendApiKeyOrNull,
} from "@/lib/cloudflare-runtime";
import { getComplianceSettings } from "@/lib/receipts/settings";
import { buildPackNotice, derivePackNoticeInput } from "@/lib/receipts/proofs";
import { buildPackNames } from "@/lib/receipts/pack-naming";
import { getAmexArtifactByMonth } from "@/lib/receipts/db";
import type { ExportBundle } from "@/lib/receipts/month-closing";
import type { ExportRow, ReceiptExport } from "@/lib/receipts/types";

export interface CategoryTotal {
  code: string;
  ja: string;
  count: number;
  totalMinor: number;
}

export function summarizeByCategory(rows: ExportRow[]): CategoryTotal[] {
  const map = new Map<string, CategoryTotal>();
  for (const row of rows) {
    const code = row.expenseCategoryCode ?? "uncategorized";
    const cat = map.get(code) ?? { code, ja: row.expenseCategoryJa ?? code, count: 0, totalMinor: 0 };
    cat.count += 1;
    cat.totalMinor += row.amountMinor ?? 0;
    map.set(code, cat);
  }
  return [...map.values()].sort((a, b) => b.totalMinor - a.totalMinor);
}

export interface FinalizeNoticeData {
  month: string;
  monthLabel: string;
  exportId: string;
  revision: number;
  rowCount: number;
  receiptCount: number;
  categoryTotals: CategoryTotal[];
  noticeText: string;
}

export async function composeFinalizeNoticeData(
  month: string,
  bundle: ExportBundle,
  exportRecord: Pick<ReceiptExport, "id" | "export_revision">,
): Promise<FinalizeNoticeData> {
  const distinctReceiptIds = new Set<string>();
  for (const row of bundle.rows) {
    if (row.receiptId) distinctReceiptIds.add(row.receiptId);
  }
  const noticeInput = derivePackNoticeInput(
    month,
    bundle.rows,
    { rowCount: bundle.rows.length, receiptCount: distinctReceiptIds.size },
  );
  // The notice interpolates the AMEX/cash CSV filenames, so it needs the pack
  // names — which need the AMEX payment-due date. A draft/finalized export can
  // only exist if the bundle already built (assembleProofsZip throws on a null
  // date), so the artifact + a parseable date are guaranteed present here.
  const artifact = await getAmexArtifactByMonth(month);
  const names = buildPackNames(month, artifact?.payment_due_date ?? null);
  return {
    month,
    monthLabel: noticeInput.monthLabel,
    exportId: exportRecord.id,
    revision: exportRecord.export_revision ?? 1,
    rowCount: bundle.rows.length,
    receiptCount: distinctReceiptIds.size,
    categoryTotals: summarizeByCategory(bundle.rows),
    noticeText: buildPackNotice(noticeInput, names),
  };
}

function formatYen(minor: number): string {
  return `¥${minor.toLocaleString("ja-JP")}`;
}

export function buildFinalizeEmailBody(d: FinalizeNoticeData, opts?: { test?: boolean }): string {
  const lines: string[] = [];
  lines.push("毎月の領収証憑一式の確定（ファイナライズ）が完了しましたのでお知らせします。");
  lines.push("");
  lines.push(`対象月: ${d.monthLabel}`);
  lines.push(`改訹: ${d.revision > 1 ? `${d.revision}（差替え）` : "新規"}`);
  lines.push(`明細行数: ${d.rowCount}`);
  lines.push(`証憑ファイル数: ${d.receiptCount}`);
  lines.push("");
  lines.push("【勘定科目別集計】");
  for (const c of d.categoryTotals) lines.push(`・${c.ja}: ${c.count}件 / ${formatYen(c.totalMinor)}`);
  lines.push("");
  lines.push("【変更点・留意事項のお知らせ】");
  lines.push(d.noticeText);
  lines.push("");
  lines.push("【ダウンロード】");
  lines.push("以下のURL（要ログイン）から、明細CSV・マニフェスト・サマリー・README・領収書ZIPをダウンロードできます。");
  lines.push(`https://dazbeez.com/receipts/export?month=${d.month}`);
  lines.push("");
  lines.push("本メールは自動送信されています。ご不明な点があれば別途ご連絡ください。");
  const body = lines.join("\r\n");
  if (opts?.test) {
    return "※これは通知チャネルのテスト送信です。月次確定の通知ではありません。\r\n\r\n" + body;
  }
  return body;
}

export function buildFinalizeEmailSubject(d: FinalizeNoticeData, opts?: { test?: boolean }): string {
  const base = d.revision > 1
    ? `【領収証憑】${d.monthLabel}分 確定通知（改訂${d.revision}）`
    : `【領収証憑】${d.monthLabel}分 確定通知`;
  return opts?.test ? `【テスト送信】${base}` : base;
}

/** Minimal HTML wrapper around the text body. Escapes + preserves line breaks
 *  via white-space:pre-wrap. No template framework. */
export function buildFinalizeEmailHtml(d: FinalizeNoticeData, opts?: { test?: boolean }): string {
  const escaped = buildFinalizeEmailBody(d, opts)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html><body><div style="white-space:pre-wrap;font-family:sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">${escaped}</div></body></html>`;
}

export type NotifyResult = { ok: true } | { ok: false; error: string };

// ─── Resend transport (isolated, mockable seam) ─────────────────────────────

export async function sendViaResend(
  fetchImpl: typeof fetch,
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<NotifyResult> {
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: unknown };
      const message = typeof errBody.message === "string" ? errBody.message : `Resend API returned ${res.status}`;
      return { ok: false, error: message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendFinalizeNotification(
  apiKey: string | null,
  from: string | null,
  to: string | null,
  data: FinalizeNoticeData,
  opts?: { test?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult> {
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY not configured" };
  if (!from) return { ok: false, error: "NOTIFY_FROM_ADDRESS not configured" };
  if (!to) return { ok: false, error: "Notification recipient not configured (set it in Settings → Compliance)" };
  return sendViaResend(
    fetchImpl, apiKey, from, to,
    buildFinalizeEmailSubject(data, opts),
    buildFinalizeEmailBody(data, opts),
    buildFinalizeEmailHtml(data, opts),
  );
}

export function authorizeNotifyTest(clerkActor: string | null): string {
  if (!clerkActor) throw new Error("Unauthorized receipts request.");
  return clerkActor;
}

// ─── Recipient resolution (settings → var fallback → null) ──────────────────

export function resolveNotificationRecipient(
  settingsValue: string | null | undefined,
  fallback: string | null,
): { email: string | null; source: "settings" | "fallback" | null } {
  if (settingsValue) return { email: settingsValue, source: "settings" };
  if (fallback) return { email: fallback, source: "fallback" };
  return { email: null, source: null };
}

export async function notifyAccountantOfFinalize(
  data: FinalizeNoticeData,
  opts?: { test?: boolean },
): Promise<NotifyResult> {
  const settings = await getComplianceSettings();
  const resolved = resolveNotificationRecipient(settings.notification_recipient, getAccountantEmail());
  return sendFinalizeNotification(
    getResendApiKeyOrNull(), getNotifyFromAddress(), resolved.email, data, opts,
  );
}
