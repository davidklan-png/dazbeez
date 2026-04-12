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

  // Decode id_token payload (base64)
  const payload = JSON.parse(atob(tokens.id_token.split('.')[1]));
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
