import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { createAuditEntry } from "@/lib/receipts/audit";
import { stringifyJson } from "@/lib/receipts/db-utils";
import {
  getAccountantEmail,
  getNotifyFromAddress,
  getReceiptsDb,
  getResendApiKeyOrNull,
} from "@/lib/cloudflare-runtime";
import { getComplianceSettings } from "@/lib/receipts/settings";
import { authorizeNotifyTest, resolveNotificationRecipient, sendViaResend } from "@/lib/receipts/notify";

// POST /api/receipts/notify/test
//
// A generic DELIVERY-CHANNEL probe (Phase B). Sends a small, clearly-labelled
// test email to the configured delivery recipients — To: accountant, Cc:
// business manager when set — to verify the Resend config + recipient addresses
// are reachable, WITHOUT finalizing or delivering a real pack. Powers the
// ComplianceSettingsForm "テスト送信" button.
//
// Post-decoupling this is NOT a finalize notification: finalize sends no email,
// and delivery is the operator's explicit POST .../send. The previous route
// composed a "ファイナライズが完了しました" + download-link email for a model that no
// longer exists; it also pulled a month + bundle + payment-due date just to
// build that body. This probe needs none of that — it reads Settings only.
export async function POST(request: Request) {
  try {
    let clerkActor: string | null = null;
    try { clerkActor = await requireReceiptsActor(request.headers); } catch { clerkActor = null; }
    const actor = authorizeNotifyTest(clerkActor);

    const settings = await getComplianceSettings();
    const to = resolveNotificationRecipient(
      settings.notification_recipient,
      getAccountantEmail(),
    ).email;
    const cc = (settings.notification_cc_recipient ?? "").trim() || null;
    const apiKey = getResendApiKeyOrNull();
    const from = getNotifyFromAddress();

    const audit = (result: { ok: true } | { ok: false; error: string }) =>
      createAuditEntry(getReceiptsDb(), {
        actor,
        action: "export.notification_test",
        objectType: "export",
        objectId: "channel-probe",
        newValueJson: stringifyJson({ ...result, to, cc }),
      });

    if (!to) {
      const result = { ok: false, error: "No delivery recipient (To) configured (set it in Settings → Compliance)." } as const;
      await audit(result);
      return NextResponse.json(result, { status: 200 });
    }
    if (!apiKey || !from) {
      const result = { ok: false, error: "Delivery not configured (RESEND_API_KEY / NOTIFY_FROM_ADDRESS)." } as const;
      await audit(result);
      return NextResponse.json(result, { status: 200 });
    }

    const subject = "【テスト】領収証憑の月次配信チャネル テスト送信";
    const lines = [
      "これは領収証憑の月次配信チャネルのテスト送信です。",
      "月次確定（ファイナライズ）の通知ではなく、配信設定が正しく機能するかの確認用です。",
      "",
      `送信先 (To): ${to}`,
      ...(cc ? [`写先 (Cc): ${cc}`] : []),
      "",
      "このメールが受信トレイに届いていれば、配信チャネルは正常に機能しています。",
    ];
    const text = lines.join("\r\n");
    const html =
      `<!DOCTYPE html><html><body><div style="white-space:pre-wrap;font-family:sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">` +
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
      `</div></body></html>`;

    const result = await sendViaResend(fetch, apiKey, from, to, subject, text, html, cc);
    await audit(result);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/notify/test] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Test send failed." },
      { status: 500 },
    );
  }
}
