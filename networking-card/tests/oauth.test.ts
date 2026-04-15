import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeOAuthState,
  encodeOAuthState,
  getLinkedInAuthUrl,
} from '../functions/_lib/oauth';
import {
  clearOauthStateCookie,
  extractOauthStateNonce,
} from '../functions/_lib/auth-flow';

test('encodeOAuthState round-trips with decodeOAuthState', () => {
  const encoded = encodeOAuthState('nonce-123', 'card-abc');

  assert.deepEqual(decodeOAuthState(encoded), {
    nonce: 'nonce-123',
    cardToken: 'card-abc',
  });
});

test('decodeOAuthState returns null for malformed values', () => {
  assert.equal(decodeOAuthState('not-base64'), null);
});

test('getLinkedInAuthUrl requests the OIDC scopes we depend on', () => {
  const url = new URL(
    getLinkedInAuthUrl(
      'linkedin-client-id',
      'https://hi.dazbeez.com/auth/linkedin/callback',
      'encoded-state',
    ),
  );

  assert.equal(url.origin, 'https://www.linkedin.com');
  assert.equal(url.searchParams.get('client_id'), 'linkedin-client-id');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
});

test('extractOauthStateNonce finds the CSRF cookie among other cookies', () => {
  const cookieHeader = [
    'foo=bar',
    '__Host-oauth_state=nonce-from-cookie',
    'theme=dark',
  ].join('; ');

  assert.equal(extractOauthStateNonce(cookieHeader), 'nonce-from-cookie');
});

test('clearOauthStateCookie expires the CSRF cookie', () => {
  assert.match(clearOauthStateCookie(), /Max-Age=0/);
  assert.match(clearOauthStateCookie(), /__Host-oauth_state=/);
});
