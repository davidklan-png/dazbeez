import { type Env } from '../../_lib/env';
import { getCard, saveContact } from '../../_lib/db';
import { decodeOAuthState, verifyGoogleIdToken } from '../../_lib/oauth';
import { queueContactNotifications } from '../../_lib/notifications';
import {
  extractOauthStateNonce,
  oauthErrorResponse,
  redirectToThanks,
} from '../../_lib/auth-flow';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const origin = url.origin;

  const form = await context.request.formData();
  const rawState = String(form.get('state') ?? '');
  const credential = String(form.get('credential') ?? '');

  if (!credential || !rawState) {
    return oauthErrorResponse(
      'Google sign-in issue',
      'Google did not return the information needed to complete sign-in. Please try again from the card page.',
      `${origin}/`,
    );
  }

  const stateData = decodeOAuthState(rawState);
  if (!stateData) {
    return oauthErrorResponse(
      'Google sign-in issue',
      'The sign-in session could not be verified. Please return to the card and try again.',
      `${origin}/`,
    );
  }

  const { cardToken: token, nonce: expectedNonce } = stateData;
  const retryHref = `${origin}/hi/${token}`;

  // CSRF protection — verify the per-page nonce cookie (set when the landing
  // page was served) matches the nonce encoded into state. Since we use a
  // JavaScript callback instead of login_uri, GIS does not set its own
  // g_csrf_token; our __Host-oauth_state nonce fills that role.
  const cookieHeader = context.request.headers.get('Cookie') ?? '';
  const pageNonce = extractOauthStateNonce(cookieHeader);
  if (!pageNonce || pageNonce !== expectedNonce) {
    return oauthErrorResponse(
      'Google sign-in issue',
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

  let userInfo;
  try {
    userInfo = await verifyGoogleIdToken(
      credential,
      context.env.GOOGLE_CLIENT_ID,
      expectedNonce,
    );
  } catch {
    return oauthErrorResponse(
      'Google sign-in issue',
      'Google sign-in could not be completed right now. Please try again or use the manual form instead.',
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
      source: 'google',
      cf_country: cf?.country ?? null,
      cf_city: cf?.city ?? null,
      user_agent: context.request.headers.get('user-agent'),
    });
  } catch {
    return oauthErrorResponse(
      'Google sign-in issue',
      'Your details could not be saved right now. Please try again or use the manual form instead.',
      retryHref,
      503,
    );
  }

  queueContactNotifications(context, {
    contactId: savedContact.id,
    token,
    cardLabel: card.label || token,
    source: 'google',
    name: userInfo.name,
    email: userInfo.email,
    followUpUrl: `${origin}/hi/${token}`,
  });

  return redirectToThanks(origin, savedContact.id);
};
