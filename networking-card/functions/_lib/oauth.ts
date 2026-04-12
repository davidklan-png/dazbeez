// JWT segments use base64url (- and _ instead of + and /). atob() requires
// standard base64, so convert and restore any stripped padding first.
function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  return atob(padded);
}

// OAuth state helpers — encode a CSRF nonce + card token together so the
// callback can verify both without needing server-side session storage.
export function encodeOAuthState(nonce: string, cardToken: string): string {
  return btoa(`${nonce}:${cardToken}`);
}

export function decodeOAuthState(
  state: string,
): { nonce: string; cardToken: string } | null {
  try {
    const decoded = atob(state);
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) return null;
    return {
      nonce: decoded.slice(0, colonIdx),
      cardToken: decoded.slice(colonIdx + 1),
    };
  } catch {
    return null;
  }
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

// ---------- Google ----------

export function getGoogleAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeGoogleCode(
  config: OAuthConfig,
  code: string,
): Promise<{ name: string; email: string }> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed: ${await tokenRes.text()}`);
  }

  const tokens = (await tokenRes.json()) as { id_token: string };

  // Decode id_token payload (base64url → base64 → JSON)
  const payload = JSON.parse(decodeBase64Url(tokens.id_token.split('.')[1]));
  return { name: payload.name as string, email: payload.email as string };
}

// ---------- LinkedIn ----------

export function getLinkedInAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
}

export async function exchangeLinkedInCode(
  config: OAuthConfig,
  code: string,
): Promise<{ name: string; email: string }> {
  const tokenRes = await fetch(
    'https://www.linkedin.com/oauth/v2/accessToken',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
      }),
    },
  );

  if (!tokenRes.ok) {
    throw new Error(
      `LinkedIn token exchange failed: ${await tokenRes.text()}`,
    );
  }

  const tokens = (await tokenRes.json()) as { access_token: string };

  // Fetch profile via OpenID Connect userinfo
  const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!profileRes.ok) {
    throw new Error(
      `LinkedIn profile fetch failed: ${await profileRes.text()}`,
    );
  }

  const profile = (await profileRes.json()) as {
    name: string;
    email: string;
  };
  return { name: profile.name, email: profile.email };
}
