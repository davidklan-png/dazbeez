import { type Env } from '../../_lib/env';
import { getCard, saveContact } from '../../_lib/db';
import {
  exchangeGoogleCode,
  decodeOAuthState,
  verifyGoogleIdToken,
} from '../../_lib/oauth';
import { queueContactNotifications } from '../../_lib/notifications';
import {
  extractOauthStateNonce,
  oauthErrorResponse,
  redirectToThanks,
} from '../../_lib/auth-flow';

function extractCookieValue(cookieHeader: string, cookieName: string): string | null {
  return cookieHeader
    .split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1) ?? null;
}

async function completeGoogleSignIn(
  context: Parameters<PagesFunction<Env>>[0],
  rawState: string | null,
  getUserInfo: (token: string, origin: string) => Promise<{ name: string; email: string }>,
) {
  const url = new URL(context.request.url);
  const origin = url.origin;

  if (!rawState) {
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

  const { cardToken: token } = stateData;
  const retryHref = `${origin}/hi/${token}`;

  // Verify CSRF nonce matches the cookie set when the hi/ page was served.
  const cookieHeader = context.request.headers.get('Cookie') ?? '';
  const cookieNonce = extractOauthStateNonce(cookieHeader);
  if (!cookieNonce || cookieNonce !== stateData.nonce) {
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

  try {
    const userInfo = await getUserInfo(token, origin);

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
  } catch {
    return oauthErrorResponse(
      'Google sign-in issue',
      'Google sign-in could not be completed right now. Please try again or use the manual form instead.',
      retryHref,
      502,
    );
  }
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const code = url.searchParams.get('code');
  const rawState = url.searchParams.get('state');

  if (!code || !rawState) {
    const origin = url.origin;
    return oauthErrorResponse(
      'Google sign-in issue',
      'Google did not return the information needed to complete sign-in. Please try again from the card page.',
      `${origin}/`,
    );
  }

  return completeGoogleSignIn(context, rawState, async (_token, origin) => {
    return exchangeGoogleCode(
      {
        clientId: context.env.GOOGLE_CLIENT_ID,
        clientSecret: context.env.GOOGLE_CLIENT_SECRET,
        redirectUri: `${origin}/auth/google/callback`,
      },
      code,
    );
  });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const cookieHeader = context.request.headers.get('Cookie') ?? '';
  const cookieCsrfToken = extractCookieValue(cookieHeader, 'g_csrf_token');
  const form = await context.request.formData();
  const bodyCsrfToken = String(form.get('g_csrf_token') ?? '');
  const rawState = String(form.get('state') ?? '');
  const credential = String(form.get('credential') ?? '');

  if (!cookieCsrfToken || !bodyCsrfToken || cookieCsrfToken !== bodyCsrfToken) {
    const origin = new URL(context.request.url).origin;
    return oauthErrorResponse(
      'Google sign-in issue',
      'The Google sign-in session could not be verified. Please return to the card and try again.',
      `${origin}/`,
    );
  }

  if (!credential || !rawState) {
    const origin = new URL(context.request.url).origin;
    return oauthErrorResponse(
      'Google sign-in issue',
      'Google did not return the information needed to complete sign-in. Please try again from the card page.',
      `${origin}/`,
    );
  }

  return completeGoogleSignIn(context, rawState, async () => {
    const stateData = decodeOAuthState(rawState);
    const expectedNonce = stateData?.nonce;

    return verifyGoogleIdToken(
      credential,
      context.env.GOOGLE_CLIENT_ID,
      expectedNonce,
    );
  });
};
