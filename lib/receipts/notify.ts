// Finalize notification email (PR 3).
//
// On successful finalize, email the accountant a Japanese summary: month,
// revision, row/receipt counts, per-category totals, the full transition-notice
// text (shared with the proofs ZIP), and download instructions. Sent via the
// Cloudflare Email Routing `send_email` binding (NOTIFY_EMAIL) — no third-party
// vendor. MIME built with `mimetext` (Workers-safe).
//
// HARD RULE: email failure must never fail finalize. sendFinalizeNotification
// never throws — it returns {ok, error?}; callers fold the result into the
// finalize response warnings + an audit entry (notification_sent /
// notification_failed), and finalize returns 200 regardless.

import { createMimeMessage } from "mimetext";
import {
  getAccountantEmail,
  getNotifyEmail,
  getNotifyFromAddress,
} from "@/lib/cloudflare-runtime";
import {
  buildTransitionNotice,
  deriveTransitionNoticeInput,
} from "@/lib/receipts/proofs";
import type { ExportBundle } from "@/lib/receipts/month-closing";
import type { ExportRow, ReceiptExport } from "@/lib/receipts/types";

/** Minimal send_email binding shape (injectable for tests). Returns
 *  Promise<unknown> so the real SendEmail binding (whose send returns
 *  Promise<EmailSendResult>) is assignable. */
export interface EmailSender {
  send(message: unknown): Promise<unknown>;
}

export interface CategoryTotal {
  code: string;
  ja: string;
  count: number;
  totalMinor: number;
}

/** Per-expense-category count + total. Mirrors buildExportSummaryCsv's grouping
 *  so the email's totals match the summary CSV the accountant also receives. */
export function summarizeByCategory(rows: ExportRow[]): CategoryTotal[] {
  const map = new Map<string, CategoryTotal>();
  for (const row of rows) {
    const code = row.expenseCategoryCode ?? "uncategorized";
    const cat = map.get(code) ?? {
      code,
      ja: row.expenseCategoryJa ?? code,
      count: 0,
      totalMinor: 0,
    };
    cat.count += 1;
    cat.totalMinor += row.amountMinor ?? 0;
    map.set(code, cat);
  }
  return [...map.values()].sort((a, b) => b.totalMinor - a.totalMinor);
}

export interface FinalizeNoticeData {
  month: string; // 2026-06
  monthLabel: string; // 2026年6月
  exportId: string;
  revision: number;
  rowCount: number;
  receiptCount: number; // distinct receipts in the bundle
  categoryTotals: CategoryTotal[];
  noticeText: string; // the transition notice (お知らせ.txt content)
}

/** Assemble the email payload from a finalized month's bundle. Pure. */
export function composeFinalizeNoticeData(
  month: string,
  bundle: ExportBundle,
  exportRecord: Pick<
    ReceiptExport,
    "id" | "export_revision" | "supersedes_export_id" | "correction_reason"
  >,
): FinalizeNoticeData {
  const distinctReceiptIds = new Set<string>();
  for (const row of bundle.rows) {
    if (row.receiptId) distinctReceiptIds.add(row.receiptId);
  }
  const noticeInput = deriveTransitionNoticeInput(
    month,
    bundle.rows,
    bundle.receipts,
    { rowCount: bundle.rows.length, receiptCount: distinctReceiptIds.size },
    {
      exportRevision: exportRecord.export_revision ?? 1,
      supersedesExportId: exportRecord.supersedes_export_id ?? null,
      correctionReason: exportRecord.correction_reason ?? null,
    },
  );
  return {
    month,
    monthLabel: noticeInput.monthLabel,
    exportId: exportRecord.id,
    revision: noticeInput.exportRevision,
    rowCount: bundle.rows.length,
    receiptCount: distinctReceiptIds.size,
    categoryTotals: summarizeByCategory(bundle.rows),
    noticeText: buildTransitionNotice(noticeInput),
  };
}

function formatYen(minor: number): string {
  return `¥${minor.toLocaleString("ja-JP")}`;
}

/** Build the Japanese email body. Pure + snapshot-tested. In test mode
 *  (opts.test) the body OPENS with a banner stating this is a channel test, not
 *  a close notification — so a test send can never be mistaken for the real
 *  thing. The rest of the body is the real template (the point of a test send is
 *  to exercise the actual template + binding + destination end to end). */
export function buildFinalizeEmailBody(
  d: FinalizeNoticeData,
  opts?: { test?: boolean },
): string {
  const lines: string[] = [];
  lines.push("毎月の領収証憑一式の確定（ファイナライズ）が完了しましたのでお知らせします。");
  lines.push("");
  lines.push(`対象月: ${d.monthLabel}`);
  lines.push(`改訹: ${d.revision > 1 ? `${d.revision}（差替え）` : "新規"}`);
  lines.push(`明細行数: ${d.rowCount}`);
  lines.push(`証憑ファイル数: ${d.receiptCount}`);
  lines.push("");
  lines.push("【勘定科目別集計】");
  for (const c of d.categoryTotals) {
    lines.push(`・${c.ja}: ${c.count}件 / ${formatYen(c.totalMinor)}`);
  }
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
    return (
      "※これは通知チャネルのテスト送信です。月次確定の通知ではありません。\r\n\r\n" +
      body
    );
  }
  return body;
}

/** Build the email subject. In test mode (opts.test) it is prefixed
 *  【テスト送信】 so a test send is unmistakable in the inbox. Pure. */
export function buildFinalizeEmailSubject(
  d: FinalizeNoticeData,
  opts?: { test?: boolean },
): string {
  const base =
    d.revision > 1
      ? `【領収証憑】${d.monthLabel}分 確定通知（改訂${d.revision}）`
      : `【領収証憑】${d.monthLabel}分 確定通知`;
  return opts?.test ? `【テスト送信】${base}` : base;
}

export type NotifyResult = { ok: true } | { ok: false; error: string };

/**
 * Send the finalize notification. NEVER throws — returns a result the caller
 * folds into finalize warnings + audit. The binding/from/to are injected so this
 * is unit-testable (pass a fake sender that resolves, or one that rejects, to
 * prove finalize survives a send failure).
 */
export async function sendFinalizeNotification(
  binding: EmailSender | null,
  from: string | null,
  to: string | null,
  data: FinalizeNoticeData,
  opts?: { test?: boolean },
): Promise<NotifyResult> {
  if (!binding) return { ok: false, error: "NOTIFY_EMAIL binding not configured" };
  if (!from) return { ok: false, error: "NOTIFY_FROM_ADDRESS not configured" };
  if (!to) return { ok: false, error: "ACCOUNTANT_EMAIL not configured" };

  try {
    const msg = createMimeMessage();
    msg.setSender({ addr: from });
    msg.setRecipient({ addr: to });
    msg.setSubject(buildFinalizeEmailSubject(data, opts));
    msg.addMessage({
      // mimetext wants exactly "text/plain" / "text/html" (no charset suffix);
      // it encodes the body as UTF-8 and emits charset=utf-8 in the MIME.
      contentType: "text/plain",
      data: buildFinalizeEmailBody(data, opts),
    });
    await binding.send(msg);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test-send (POST /api/receipts/notify/test) is an operator action: Clerk
 * session ONLY. Unlike /extract, a processor key alone is NOT accepted — the Mac
 * consumer must never be able to trigger a notification. `clerkActor` is the
 * resolved Clerk actor (null when there's no session, e.g. a processor-key-only
 * request). Returns the actor, or throws Unauthorized. Pure + unit-testable.
 */
export function authorizeNotifyTest(clerkActor: string | null): string {
  if (!clerkActor) {
    throw new Error("Unauthorized receipts request.");
  }
  return clerkActor;
}

/**
 * Production wrapper: reads the NOTIFY_EMAIL binding + env vars and sends.
 * Callers (both finalize routes) use this; it never throws. The test-send
 * endpoint passes { test: true } so the subject is prefixed 【テスト送信】 and the
 * body opens with a test banner.
 */
export async function notifyAccountantOfFinalize(
  data: FinalizeNoticeData,
  opts?: { test?: boolean },
): Promise<NotifyResult> {
  return sendFinalizeNotification(
    getNotifyEmail(),
    getNotifyFromAddress(),
    getAccountantEmail(),
    data,
    opts,
  );
}
