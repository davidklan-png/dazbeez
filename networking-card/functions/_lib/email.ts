export async function sendAcknowledgmentEmail(
  resendApiKey: string,
  to: { name: string; email: string },
): Promise<void> {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'David Klan <david@dazbeez.com>',
      to: [`${to.name} <${to.email}>`],
      subject: 'Great meeting you',
      text: [
        `Hi ${to.name},`,
        '',
        'Great meeting you! I\'m David Klan \u2014 I run Dazbeez, an AI, Automation & Data consultancy. If anything comes up where I can help, don\'t hesitate to reach out.',
        '',
        'Best,',
        'David Klan',
        'david@dazbeez.com',
        'https://dazbeez.com',
      ].join('\n'),
    }),
  });
}
