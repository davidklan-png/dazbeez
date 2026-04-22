import type { PersonalizedDiscord } from './personalization';

export interface DiscordPayload {
  name: string;
  email: string;
  source: string;
  label: string;
  /**
   * When present, overrides the embed title and color, and appends extra
   * fields with private research notes for David's eyes only.
   */
  personalization?: PersonalizedDiscord;
}

export async function sendDiscordNotification(
  webhookUrl: string,
  data: DiscordPayload,
): Promise<void> {
  const baseFields = [
    { name: 'Name', value: data.name, inline: true },
    { name: 'Email', value: data.email, inline: true },
    { name: 'Source', value: data.source, inline: true },
    { name: 'Card', value: data.label || '(unlabeled)', inline: true },
  ];

  const title = data.personalization?.title ?? '\ud83d\udcc7 New Contact';
  const color = data.personalization?.color ?? 0xf59e0b;
  const fields = [...baseFields, ...(data.personalization?.extraFields ?? [])];

  const embed: Record<string, unknown> = {
    title,
    fields,
    color,
    timestamp: new Date().toISOString(),
  };

  if (data.personalization?.footerText) {
    embed.footer = { text: data.personalization.footerText };
  }

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
}
