import { type Env } from '../../_lib/env';
import { getCard, insertContact } from '../../_lib/db';
import { exchangeGoogleCode, decodeOAuthState } from '../../_lib/oauth';
import { sendDiscordNotification } from '../../_lib/discord';
import { sendAcknowledgmentEmail } from '../../_lib/email';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const code = url.searchParams.get('code');
  const rawState = url.searchParams.get('state');

  if (!code || !rawState) {
    return new Response('Missing code or state', { status: 400 });
  }

  const stateData = decodeOAuthState(rawState);
  if (!stateData) {
    return new Response('Invalid OAuth state', { status: 400 });
  }

  // Verify CSRF nonce matches the cookie set when the hi/ page was served.
  const cookieHeader = context.request.headers.get('Cookie') ?? '';
  const nonceCookie = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith('__Host-oauth_state='));
  const cookieNonce = nonceCookie?.slice('__Host-oauth_state='.length);
  if (!cookieNonce || cookieNonce !== stateData.nonce) {
    return new Response('OAuth state mismatch', { status: 400 });
  }

  const { cardToken: token } = stateData;
  const card = await getCard(context.env.DB, token);
  if (!card) {
    return new Response('Invalid card token', { status: 400 });
  }

  const origin = url.origin;
  const userInfo = await exchangeGoogleCode(
    {
      clientId: context.env.GOOGLE_CLIENT_ID,
      clientSecret: context.env.GOOGLE_CLIENT_SECRET,
      redirectUri: `${origin}/auth/google/callback`,
    },
    code,
  );

  const cf = context.request.cf as Record<string, string> | undefined;
  const contactId = await insertContact(context.env.DB, {
    token,
    name: userInfo.name,
    email: userInfo.email,
    source: 'google',
    cf_country: cf?.country ?? null,
    cf_city: cf?.city ?? null,
    user_agent: context.request.headers.get('user-agent'),
  });

  context.waitUntil(
    sendDiscordNotification(context.env.DISCORD_WEBHOOK_URL, {
      name: userInfo.name,
      email: userInfo.email,
      source: 'google',
      label: card.label || token,
    }),
  );
  context.waitUntil(
    sendAcknowledgmentEmail(context.env.RESEND_API_KEY, userInfo),
  );

  return Response.redirect(`${origin}/thanks?contact_id=${contactId}`, 302);
};
