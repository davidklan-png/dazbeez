import type { PersonalizedEmail } from './personalization';

export interface EmailRecipient {
  name: string;
  email: string;
  followUpUrl?: string;
  /**
   * When present, overrides the generic acknowledgment template with
   * personalized copy for a known event attendee.
   */
  personalization?: PersonalizedEmail;
}

function buildGenericTextLines(to: EmailRecipient): string[] {
  const followUpBlock = to.followUpUrl
    ? [
        '',
        `Keep this card handy and tap again later when you want to learn more: ${to.followUpUrl}`,
      ]
    : [];

  return [
    `Hi ${to.name},`,
    '',
    'Great meeting you! I\'m David Klan \u2014 I run Dazbeez, an AI, Automation & Data consultancy. You can save my contact card from the page and share your details with me in one tap whenever it is convenient.',
    '',
    'Connect with me on LinkedIn: https://www.linkedin.com/in/david-klan',
    ...followUpBlock,
    '',
    'Best,',
    'David Klan',
    'david@dazbeez.com',
    'https://dazbeez.com',
  ];
}

export async function sendAcknowledgmentEmail(
  resendApiKey: string,
  to: EmailRecipient,
): Promise<void> {
  const subject = to.personalization?.subject ?? 'Great meeting you';
  const textLines = to.personalization?.textLines ?? buildGenericTextLines(to);

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'David Klan <david@dazbeez.com>',
      to: [`${to.name} <${to.email}>`],
      subject,
      text: textLines.join('\n'),
    }),
  });
}
