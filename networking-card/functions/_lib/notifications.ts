import type { Env } from './env';
import { getKnownAttendee, logNotificationFailure } from './db';
import { sendDiscordNotification } from './discord';
import { sendAcknowledgmentEmail } from './email';
import {
  buildPersonalizedDiscord,
  buildPersonalizedEmail,
  type KnownAttendee,
} from './personalization';

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
    isNew: boolean;
    token: string;
    cardLabel: string;
    source: 'google' | 'linkedin' | 'manual';
    name: string;
    email: string;
    linkedinUrl?: string | null;
    followUpUrl: string;
  },
): void {
  if (!outboundNotificationsEnabled(context.env)) {
    return;
  }

  // Resolve the known attendee once (if any); reuse for both channels.
  const attendeePromise: Promise<KnownAttendee | null> = getKnownAttendee(
    context.env.DB,
    data.email,
    data.linkedinUrl ?? null,
  ).catch((error) => {
    console.error('getKnownAttendee failed', error);
    return null;
  });

  const discordTask = attendeePromise.then((attendee) => {
    const discordPayload = {
      name: data.name,
      email: data.email,
      source: data.source,
      label: data.cardLabel,
      personalization: attendee ? buildPersonalizedDiscord(attendee) : undefined,
    };
    return sendDiscordNotification(context.env.DISCORD_WEBHOOK_URL, discordPayload).catch((error) =>
      captureNotificationFailure(context.env, {
        contactId: data.contactId,
        token: data.token,
        channel: 'discord',
        error,
        payload: discordPayload,
      }),
    );
  });

  context.waitUntil(discordTask);

  if (!data.isNew) {
    return;
  }

  const emailTask = attendeePromise.then((attendee) => {
    const emailPayload = {
      name: data.name,
      email: data.email,
      followUpUrl: data.followUpUrl,
      personalization: attendee
        ? buildPersonalizedEmail({
            attendee,
            contactName: data.name,
            followUpUrl: data.followUpUrl,
          })
        : undefined,
    };
    return sendAcknowledgmentEmail(context.env.RESEND_API_KEY, emailPayload).catch((error) =>
      captureNotificationFailure(context.env, {
        contactId: data.contactId,
        token: data.token,
        channel: 'email',
        error,
        payload: emailPayload,
      }),
    );
  });

  context.waitUntil(emailTask);
}
