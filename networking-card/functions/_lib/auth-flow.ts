import { page } from './html';

export function extractCookie(cookieHeader: string, name: string): string | null {
  const prefix = `${name}=`;
  const match = cookieHeader
    .split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(prefix));

  return match?.slice(prefix.length) ?? null;
}

export function extractOauthStateNonce(cookieHeader: string): string | null {
  return extractCookie(cookieHeader, '__Host-oauth_state');
}

export function clearOauthStateCookie(): string {
  return '__Host-oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

export function flowErrorResponse(
  title: string,
  message: string,
  primaryHref: string,
  primaryLabel: string,
  status = 400,
): Response {
  const html = page(
    title,
    `
    <div class="thanks-icon">⚠️</div>
    <h1>${title}</h1>
    <p class="pitch">${message}</p>
    <div class="links">
      <a href="${primaryHref}" class="btn btn-amber">${primaryLabel}</a>
      <a href="https://dazbeez.com/contact" class="btn btn-outline">Contact David</a>
    </div>`,
  );

  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': clearOauthStateCookie(),
    },
  });
}

export function oauthErrorResponse(
  title: string,
  message: string,
  retryHref: string,
  status = 400,
): Response {
  return flowErrorResponse(title, message, retryHref, 'Back to card', status);
}

export function redirectToThanks(
  origin: string,
  contactId: number,
  token?: string,
): Response {
  const tokenSuffix = token ? `&token=${encodeURIComponent(token)}` : '';
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${origin}/thanks?contact_id=${contactId}${tokenSuffix}`,
      'Set-Cookie': clearOauthStateCookie(),
    },
  });
}
