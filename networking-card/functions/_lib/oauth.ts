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

interface GoogleJwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface GoogleIdTokenPayload {
  aud: string | string[];
  email?: string;
  email_verified?: boolean;
  exp?: number;
  family_name?: string;
  given_name?: string;
  hd?: string;
  iat?: number;
  iss?: string;
  name?: string;
  nonce?: string;
  sub?: string;
}

function decodeBase64UrlJson<T>(segment: string): T {
  return JSON.parse(decodeBase64Url(segment)) as T;
}

function decodeBase64UrlBytes(segment: string): Uint8Array {
  const binary = decodeBase64Url(segment);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function getGoogleSigningKey(kid: string) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/certs');

  if (!response.ok) {
    throw new Error(`Google cert fetch failed: ${await response.text()}`);
  }

  const payload = (await response.json()) as { keys?: JsonWebKey[] };
  const jwk = payload.keys?.find((candidate) => {
    const key = candidate as JsonWebKey & { kid?: string; kty?: string };
    return key.kid === kid && key.kty === 'RSA';
  });

  if (!jwk) {
    throw new Error('Google signing key not found');
  }

  return jwk;
}

export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  expectedNonce?: string,
): Promise<{ name: string; email: string }> {
  const segments = idToken.split('.');
  if (segments.length !== 3) {
    throw new Error('Google ID token is malformed');
  }

  const [headerSegment, payloadSegment, signatureSegment] = segments;
  const header = decodeBase64UrlJson<GoogleJwtHeader>(headerSegment);
  const payload = decodeBase64UrlJson<GoogleIdTokenPayload>(payloadSegment);

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Google ID token uses an unsupported signing algorithm');
  }

  const jwk = await getGoogleSigningKey(header.kid);
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['verify'],
  );

  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    decodeBase64UrlBytes(signatureSegment),
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
  );

  if (!verified) {
    throw new Error('Google ID token signature is invalid');
  }

  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(clientId)) {
    throw new Error('Google ID token audience mismatch');
  }

  if (!payload.iss || !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) {
    throw new Error('Google ID token issuer mismatch');
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) {
    throw new Error('Google ID token has expired');
  }

  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw new Error('Google ID token nonce mismatch');
  }

  if (!payload.email) {
    throw new Error('Google ID token is missing email');
  }

  const fallbackName =
    [payload.given_name, payload.family_name].filter(Boolean).join(' ').trim() ||
    payload.email;

  return {
    name: payload.name?.trim() || fallbackName,
    email: payload.email,
  };
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
  return verifyGoogleIdToken(tokens.id_token, config.clientId);
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
