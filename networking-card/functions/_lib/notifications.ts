import type { Env } from './env';
import { logNotificationFailure } from './db';
import { sendDiscordNotification } from './discord';
import { sendAcknowledgmentEmail } from './email';

export function outboundNotificationsEnabled(env: Env): boolean {
  return env.DISABLE_OUTBOUND_NOTIFICATIONS !== 'true';
}

function stringifyPayload(payload: unknown): string {
  return JSON.stringify(payload);
}

async function captureNotificationFailure(
  env: Env,
  data: {
    contactId: number;
    token: string;
    channel: 'discord' | 'email';
    error: unknown;
    payload: unknown;
  },
): Promise<void> {
  const errorMessage = data.error instanceof Error ? data.error.message : String(data.error);

  try {
    await logNotificationFailure(env.DB, {
      contactId: data.contactId,
      token: data.token,
      channel: data.channel,
      errorMessage,
      payloadJson: stringifyPayload(data.payload),
    });
  } catch (loggingError) {
    console.error('Failed to log notification failure', loggingError);
  }
}

export function queueContactNotifications(
  context: Pick<PagesFunction<Env> extends (ctx: infer T) => unknown ? T : never, 'env' | 'waitUntil'>,
  data: {
    contactId: number;
    token: string;
    cardLabel: string;
    source: 'google' | 'linkedin' | 'manual';
    name: string;
    email: string;
    followUpUrl: string;
  },
): void {
  if (!outboundNotificationsEnabled(context.env)) {
    return;
  }

  const discordPayload = {
    name: data.name,
    email: data.email,
    source: data.source,
    label: data.cardLabel,
  };
  const emailPayload = {
    name: data.name,
    email: data.email,
    followUpUrl: data.followUpUrl,
  };

  context.waitUntil(
    sendDiscordNotification(context.env.DISCORD_WEBHOOK_URL, discordPayload).catch((error) =>
      captureNotificationFailure(context.env, {
        contactId: data.contactId,
        token: data.token,
        channel: 'discord',
        error,
        payload: discordPayload,
      }),
    ),
  );
  context.waitUntil(
    sendAcknowledgmentEmail(context.env.RESEND_API_KEY, emailPayload).catch((error) =>
      captureNotificationFailure(context.env, {
        contactId: data.contactId,
        token: data.token,
        channel: 'email',
        error,
        payload: emailPayload,
      }),
    ),
  );
}
