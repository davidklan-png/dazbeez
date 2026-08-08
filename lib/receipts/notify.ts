// Email transport + recipient resolution for the receipts module.
//
// Transport: Resend REST API (POST api.resend.com/emails) — replaces the former
// Cloudflare Email Routing send_email binding.
//
// After Phase B decoupled finalize from delivery (D1/D2), finalize sends NO
// email. Two callers remain:
//  - Delivery (POST /api/receipts/export/{month}/send): sendDeliveryViaResend
//    attaches the sealed ZIP, sends To: accountant / Cc: business manager, and
//    carries an Idempotency-Key. A delivery FAILURE is a real event — the month
//    lands in sealed_undelivered (the seal stands; reporting-close waits), NOT
//    a swallowed warning. See delivery-state.ts + delivery-send.ts.
//  - Channel probe (POST /api/receipts/notify/test): sendViaResend sends a
//    small, clearly-labelled test email to the configured recipients to verify
//    the Resend config + addresses — WITHOUT finalizing or delivering a pack.
//
// This module is PURE (no D1/R2 bindings): every function takes its transport
// (fetch) and config (apiKey, addresses) as arguments, so the logic is unit-
// testable without bindings. The finalize-notification machinery that used to
// live here (composeFinalizeNoticeData / notifyAccountantOfFinalize / the email
// body builders / summarizeByCategory) was deleted when finalize stopped
// notifying — it had no caller but the test route, and its "ファイナライズが完了
// しました" framing described a model that no longer exists. The channel probe
// composes its own minimal body inline.
//
// Recipient resolution: Settings → Compliance (notification_recipient) →
// ACCOUNTANT_EMAIL var fallback → unconfigured {email:null}.

export type NotifyResult = { ok: true } | { ok: false; error: string };

// ─── Resend transport (isolated, mockable seam) ─────────────────────────────

/** Plain email send (no attachment). Used by the channel-probe route. `cc` is
 *  optional — null/omitted drops the field from the payload entirely (mirrors
 *  sendDeliveryViaResend; never cc:null/cc:""). Never throws across the
 *  boundary — returns {ok, error?}. */
export async function sendViaResend(
  fetchImpl: typeof fetch,
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  text: string,
  html: string,
  cc: string | null = null,
): Promise<NotifyResult> {
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], cc: cc ? [cc] : undefined, subject, text, html }),
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

/** A Resend attachment — a filename plus the file content as base64 (Resend's
 *  `attachments[].content` is base64). The filename MUST be ASCII (the pack
 *  container name) — checked by the caller (B-4). */
export interface ResendAttachment {
  filename: string;
  contentBase64: string;
}

/** Delivery send via Resend. Extends {@link sendViaResend} with the ZIP
 *  attachment, a Cc recipient, and an `Idempotency-Key` header.
 *
 *  B-3: the key is derived from the attempt_id — stable across retries of one
 *  attempt, new per operator send — so a response-timeout retry does not
 *  double-send. On success the provider message id is returned so the caller
 *  can record it on the delivery row. */
export async function sendDeliveryViaResend(
  fetchImpl: typeof fetch,
  apiKey: string,
  from: string,
  to: string,
  cc: string | null,
  subject: string,
  text: string,
  html: string,
  attachment: ResendAttachment,
  idempotencyKey: string,
): Promise<
  | { ok: true; messageId?: string }
  | { ok: false; error: string; status?: number }
> {
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [to],
        cc: cc ? [cc] : undefined,
        subject,
        text,
        html,
        attachments: [
          { filename: attachment.filename, content: attachment.contentBase64 },
        ],
      }),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: unknown };
      const message = typeof errBody.message === "string" ? errBody.message : `Resend API returned ${res.status}`;
      // status lets the caller classify: 4xx = definitive (rejected); the caller
      // defaults everything else (5xx, and the catch below) to ambiguous.
      return { ok: false, error: message, status: res.status };
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, messageId: typeof body.id === "string" ? body.id : undefined };
  } catch (err) {
    // No response (timeout / network) — status undefined ⇒ caller classifies
    // ambiguous. Never infer "definitely not sent" from the absence of a response.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function authorizeNotifyTest(clerkActor: string | null): string {
  if (!clerkActor) throw new Error("Unauthorized receipts request.");
  return clerkActor;
}

// ─── Recipient validation + resolution + D7 message ─────────────────────────

/** The email-address shape every delivery recipient must match. Same regex as
 *  the compliance-settings PATCH validation (`settings/compliance/route.ts`)
 *  and the contact route. A delivery address is checked at SEND time too
 *  (Change 5) because the To may come from the unvalidated ACCOUNTANT_EMAIL
 *  fallback — a malformed address is a definitive Resend 4xx, correct but a
 *  wasted attempt and a confusing audit entry. Catch it first as a clear 422. */
const DELIVERY_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidDeliveryAddress(email: string): boolean {
  return DELIVERY_EMAIL_RE.test(email.trim());
}

/**
 * D7 — the message returned when a delivery-recipient setting is edited.
 * Describes ACTUAL behaviour after finalize was decoupled from delivery (Phase
 * B): the address receives the monthly pack when the OPERATOR sends it — NOT
 * automatically on finalize — and the field is audited. The pre-decoupling D7
 * wording ("receives the pack automatically on finalize", §15) is now FALSE and
 * must not be reproduced.
 */
export function recipientSettingMessage(
  field: "notification_recipient" | "notification_cc_recipient",
): string {
  const role = field === "notification_cc_recipient" ? "CC（写先行）" : "送信先（To）";
  return (
    `このアドレスは、毎月の領収証憑一式がオペレーターによって送信される際の${role}として使用されます。` +
    `確定（ファイナライズ）時の自動送信は行われません。配信は明示的な送信操作によって行われます。` +
    `この項目の変更は監査ログに記録されます。`
  );
}

export function resolveNotificationRecipient(
  settingsValue: string | null | undefined,
  fallback: string | null,
): { email: string | null; source: "settings" | "fallback" | null } {
  if (settingsValue) return { email: settingsValue, source: "settings" };
  if (fallback) return { email: fallback, source: "fallback" };
  return { email: null, source: null };
}
