import { type Env } from './_lib/env';
import { getCard, insertContact } from './_lib/db';
import { sendDiscordNotification } from './_lib/discord';
import { sendAcknowledgmentEmail } from './_lib/email';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const form = await context.request.formData();
  const token = form.get('token') as string;
  const name = (form.get('name') as string)?.trim();
  const email = (form.get('email') as string)?.trim();
  const company = (form.get('company') as string)?.trim() || undefined;
  const linkedinUrl = (form.get('linkedin_url') as string)?.trim() || undefined;

  if (!token || !name || !email) {
    return new Response('Missing required fields', { status: 400 });
  }

  const card = await getCard(context.env.DB, token);
  if (!card) {
    return new Response('Invalid card token', { status: 400 });
  }

  const cf = context.request.cf as Record<string, string> | undefined;
  const contactId = await insertContact(context.env.DB, {
    token,
    name,
    email,
    source: 'manual',
    company,
    linkedin_url: linkedinUrl,
    cf_country: cf?.country ?? null,
    cf_city: cf?.city ?? null,
    user_agent: context.request.headers.get('user-agent'),
  });

  context.waitUntil(
    sendDiscordNotification(context.env.DISCORD_WEBHOOK_URL, {
      name,
      email,
      source: 'manual',
      label: card.label || token,
    }),
  );
  context.waitUntil(
    sendAcknowledgmentEmail(context.env.RESEND_API_KEY, { name, email }),
  );

  const origin = new URL(context.request.url).origin;
  return Response.redirect(`${origin}/thanks?contact_id=${contactId}`, 302);
};
