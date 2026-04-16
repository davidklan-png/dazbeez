import { type Env } from './_lib/env';
import { getCard, saveContact } from './_lib/db';
import { flowErrorResponse } from './_lib/auth-flow';
import { queueContactNotifications } from './_lib/notifications';

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
  const origin = new URL(context.request.url).origin;
  let savedContact;
  try {
    savedContact = await saveContact(context.env.DB, {
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
  } catch {
    return flowErrorResponse(
      'Could not save your details',
      'Your information could not be saved right now. Please try again from the card or contact David directly.',
      `${origin}/hi/${token}`,
      'Back to card',
      503,
    );
  }

  queueContactNotifications(context, {
    contactId: savedContact.id,
    token,
    cardLabel: card.label || token,
    source: 'manual',
    name,
    email,
    followUpUrl: `${origin}/hi/${token}`,
  });

  return Response.redirect(
    `${origin}/thanks?contact_id=${savedContact.id}&token=${encodeURIComponent(token)}`,
    302,
  );
};
