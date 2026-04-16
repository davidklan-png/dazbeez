import { type Env } from '../../_lib/env';
import { getCard, saveContact } from '../../_lib/db';
import { exchangeLinkedInCode, decodeOAuthState } from '../../_lib/oauth';
import { queueContactNotifications } from '../../_lib/notifications';
import {
  extractOauthStateNonce,
  oauthErrorResponse,
  redirectToThanks,
} from '../../_lib/auth-flow';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const origin = url.origin;
  const code = url.searchParams.get('code');
  const rawState = url.searchParams.get('state');

  if (!code || !rawState) {
    return oauthErrorResponse(
      'LinkedIn sign-in issue',
      'LinkedIn did not return the information needed to complete sign-in. Please try again from the card page.',
      `${origin}/`,
    );
  }

  const stateData = decodeOAuthState(rawState);
  if (!stateData) {
    return oauthErrorResponse(
      'LinkedIn sign-in issue',
      'The sign-in session could not be verified. Please return to the card and try again.',
      `${origin}/`,
    );
  }

  const { cardToken: token } = stateData;
  const retryHref = `${origin}/hi/${token}`;

  // Verify CSRF nonce matches the cookie set when the hi/ page was served.
  const cookieHeader = context.request.headers.get('Cookie') ?? '';
  const cookieNonce = extractOauthStateNonce(cookieHeader);
  if (!cookieNonce || cookieNonce !== stateData.nonce) {
    return oauthErrorResponse(
      'LinkedIn sign-in issue',
      'Your sign-in session expired or was opened in a different browser context. Please start again from the card page.',
      retryHref,
    );
  }

  const card = await getCard(context.env.DB, token);
  if (!card) {
    return oauthErrorResponse(
      'Card not found',
      'That card link is no longer valid. Please rescan the card or contact David directly.',
      `${origin}/`,
    );
  }

  let userInfo: { name: string; email: string };
  try {
    userInfo = await exchangeLinkedInCode(
      {
        clientId: context.env.LINKEDIN_CLIENT_ID,
        clientSecret: context.env.LINKEDIN_CLIENT_SECRET,
        redirectUri: `${origin}/auth/linkedin/callback`,
      },
      code,
    );
  } catch {
    return oauthErrorResponse(
      'LinkedIn sign-in issue',
      'LinkedIn sign-in could not be completed right now. Please try again or use the manual form instead.',
      retryHref,
      502,
    );
  }

  const cf = context.request.cf as Record<string, string> | undefined;
  let savedContact;
  try {
    savedContact = await saveContact(context.env.DB, {
      token,
      name: userInfo.name,
      email: userInfo.email,
      source: 'linkedin',
      cf_country: cf?.country ?? null,
      cf_city: cf?.city ?? null,
      user_agent: context.request.headers.get('user-agent'),
    });
  } catch {
    return oauthErrorResponse(
      'LinkedIn sign-in issue',
      'Your details could not be saved right now. Please try again or use the manual form instead.',
      retryHref,
      503,
    );
  }

  queueContactNotifications(context, {
    contactId: savedContact.id,
    token,
    cardLabel: card.label || token,
    source: 'linkedin',
    name: userInfo.name,
    email: userInfo.email,
    followUpUrl: `${origin}/hi/${token}`,
  });

  return redirectToThanks(origin, savedContact.id, token);
};
