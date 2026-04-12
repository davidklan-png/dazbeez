export async function sendDiscordNotification(
  webhookUrl: string,
  data: { name: string; email: string; source: string; label: string },
): Promise<void> {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [
        {
          title: '\ud83d\udcc7 New Contact',
          fields: [
            { name: 'Name', value: data.name, inline: true },
            { name: 'Email', value: data.email, inline: true },
            { name: 'Source', value: data.source, inline: true },
            { name: 'Card', value: data.label || '(unlabeled)', inline: true },
          ],
          color: 0xf59e0b,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  });
}
