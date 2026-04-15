import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet as hiRoute } from '../functions/hi/[token]';
import {
  onRequestGet as googleCallback,
  onRequestPost as googleCallbackPost,
} from '../functions/auth/google/callback';
import { onRequestGet as linkedinCallback } from '../functions/auth/linkedin/callback';
import { onRequestPost as submitRoute } from '../functions/submit';
import { encodeOAuthState } from '../functions/_lib/oauth';
import {
  createEnv,
  createFakeD1Database,
  createFakeDbState,
  createGoogleJwks,
  createIdToken,
  createPagesContext,
} from './helpers';

test('hi route returns 404 for an unknown card token', async () => {
  const env = createEnv({
    DB: createFakeD1Database(createFakeDbState()),
  });
  const { context } = createPagesContext({
    url: 'https://hi.dazbeez.com/hi/missing-token',
    params: { token: 'missing-token' },
    env,
  });

  const response = await hiRoute(context as never);

  assert.equal(response.status, 404);
});

test('hi route renders the Google GIS button and sets the CSRF cookie', async () => {
  const dbState = createFakeDbState([{ token: 'card-1', label: 'card-1' }]);
  const env = createEnv({
    DB: createFakeD1Database(dbState),
  });
  const { context, waitUntilCalls } = createPagesContext({
    url: 'https://hi.dazbeez.com/hi/card-1',
    params: { token: 'card-1' },
    env,
  });

  const response = await hiRoute(context as never);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('Set-Cookie') ?? '',
    /__Host-oauth_state=.*HttpOnly; Secure; SameSite=Lax; Max-Age=300/,
  );
  assert.match(html, /https:\/\/accounts\.google\.com\/gsi\/client/);
  assert.match(html, /class="g_id_signin"/);
  assert.match(html, /data-login_uri="https:\/\/hi\.dazbeez\.com\/auth\/google\/callback"/);
  assert.match(html, /data-use_fedcm_for_button="true"/);
  assert.doesNotMatch(html, /Share your info with LinkedIn/);
  assert.match(html, /Save David&rsquo;s contact/);
  assert.match(html, /What is in the card/);
  assert.match(html, /Where it usually goes/);

  await Promise.all(waitUntilCalls);
  assert.equal(dbState.taps.length, 1);
});

test('hi route degrades cleanly when a provider is not configured', async () => {
  const dbState = createFakeDbState([{ token: 'card-1', label: 'card-1' }]);
  const env = createEnv({
    DB: createFakeD1Database(dbState),
    GOOGLE_CLIENT_ID: '',
  });
  const { context } = createPagesContext({
    url: 'https://hi.dazbeez.com/hi/card-1',
    params: { token: 'card-1' },
    env,
  });

  const response = await hiRoute(context as never);
  const html = await response.text();

  assert.doesNotMatch(html, /client_id=undefined/);
  assert.match(
    html,
    /Google sign-in is temporarily unavailable\. You can still use the manual form below\./,
  );
});

test('manual submit stores the contact and redirects to thanks', async () => {
  const dbState = createFakeDbState([{ token: 'card-1', label: 'card-1' }]);
  const env = createEnv({
    DB: createFakeD1Database(dbState),
  });
  const form = new FormData();
  form.set('token', 'card-1');
  form.set('name', 'Casey Contact');
  form.set('email', 'casey@example.com');

  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('{}'));

  try {
    const { context, waitUntilCalls } = createPagesContext({
      url: 'https://hi.dazbeez.com/submit',
      method: 'POST',
      body: form,
      env,
    });

    const response = await submitRoute(context as never);

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('Location'),
      'https://hi.dazbeez.com/thanks?contact_id=1',
    );

    await Promise.all(waitUntilCalls);
    assert.equal(dbState.contacts.length, 1);
    assert.equal(fetchMock.mock.calls.length, 2);
    assert.equal(dbState.contactEvents.length, 1);
    assert.equal(dbState.contactEvents[0].source, 'manual');
  } finally {
    fetchMock.mock.restore();
  }
});

test('manual submit rejects missing required fields', async () => {
  const env = createEnv();
  const form = new FormData();
  form.set('token', 'card-1');
  form.set('name', 'Casey Contact');

  const { context } = createPagesContext({
    url: 'https://hi.dazbeez.com/submit',
    method: 'POST',
    body: form,
    env,
  });

  const response = await submitRoute(context as never);

  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'Missing required fields');
});

test('manual submit rejects an invalid card token', async () => {
  const env = createEnv();
  const form = new FormData();
  form.set('token', 'missing-card');
  form.set('name', 'Casey Contact');
  form.set('email', 'casey@example.com');

  const { context } = createPagesContext({
    url: 'https://hi.dazbeez.com/submit',
    method: 'POST',
    body: form,
    env,
  });

  const response = await submitRoute(context as never);

  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'Invalid card token');
});

test('manual submit deduplicates an existing contact and updates details', async () => {
  const dbState = createFakeDbState(
    [{ token: 'card-1', label: 'card-1' }],
    {
      contacts: [
        {
          token: 'card-1',
          name: 'Casey Old',
          email: 'casey@example.com',
          source: 'google',
          company: 'Old Co',
        },
      ],
    },
  );
  const env = createEnv({
    DB: createFakeD1Database(dbState),
  });
  const form = new FormData();
  form.set('token', 'card-1');
  form.set('name', 'Casey Contact');
  form.set('email', 'casey@example.com');
  form.set('company', 'New Co');

  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('{}'));

  try {
    const { context, waitUntilCalls } = createPagesContext({
      url: 'https://hi.dazbeez.com/submit',
      method: 'POST',
      body: form,
      env,
    });

    const response = await submitRoute(context as never);

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('Location'),
      'https://hi.dazbeez.com/thanks?contact_id=1',
    );

    await Promise.all(waitUntilCalls);
    assert.equal(dbState.contacts.length, 1);
    assert.equal(dbState.contacts[0].name, 'Casey Contact');
    assert.equal(dbState.contacts[0].company, 'New Co');
    assert.equal(dbState.contacts[0].source, 'google');
    assert.deepEqual(
      dbState.contactMethods
        .filter((entry) => entry.contact_id === 1)
        .map((entry) => entry.method)
        .sort(),
      ['google', 'manual'],
    );
    assert.deepEqual(
      dbState.contactEvents
        .filter((entry) => entry.contact_id === 1)
        .map((entry) => entry.source)
        .sort(),
      ['google', 'manual'],
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test('manual submit returns a recoverable error page when contact storage fails', async () => {
  const dbState = createFakeDbState(
    [{ token: 'card-1', label: 'card-1' }],
    { failInsertContact: true },
  );
  const env = createEnv({
    DB: createFakeD1Database(dbState),
  });
  const form = new FormData();
  form.set('token', 'card-1');
  form.set('name', 'Casey Contact');
  form.set('email', 'casey@example.com');

  const { context } = createPagesContext({
    url: 'https://hi.dazbeez.com/submit',
    method: 'POST',
    body: form,
    env,
  });

  const response = await submitRoute(context as never);
  const html = await response.text();

  assert.equal(response.status, 503);
  assert.match(html, /Could not save your details/);
  assert.match(html, /Back to card/);
});

test('google callback rejects mismatched CSRF state and clears the cookie', async () => {
  const env = createEnv({
    DB: createFakeD1Database(createFakeDbState([{ token: 'card-1', label: 'card-1' }])),
  });
  const state = encodeOAuthState('expected-nonce', 'card-1');
  const { context } = createPagesContext({
    url: `https://hi.dazbeez.com/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
    headers: {
      Cookie: '__Host-oauth_state=different-nonce',
    },
    env,
  });

  const response = await googleCallback(context as never);
  const html = await response.text();

  assert.equal(response.status, 400);
  assert.match(html, /Google sign-in issue/);
  assert.match(response.headers.get('Set-Cookie') ?? '', /Max-Age=0/);
});

test('google callback completes the legacy GET happy path and clears the CSRF cookie', async () => {
  const dbState = createFakeDbState([{ token: 'card-1', label: 'card-1' }]);
  const env = createEnv({
    DB: createFakeD1Database(dbState),
  });
  const state = encodeOAuthState('expected-nonce', 'card-1');

  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          id_token: createIdToken({
            aud: env.GOOGLE_CLIENT_ID,
            exp: Math.floor(Date.now() / 1000) + 3600,
            iss: 'https://accounts.google.com',
            name: 'Google Person',
            nonce: 'expected-nonce',
            email: 'google.person@example.com',
          }),
        });
      }

      if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return Response.json(createGoogleJwks());
      }

      return new Response('{}');
    },
  );

  try {
    const { context, waitUntilCalls } = createPagesContext({
      url: `https://hi.dazbeez.com/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      headers: {
        Cookie: '__Host-oauth_state=expected-nonce',
      },
      env,
    });

    const response = await googleCallback(context as never);

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('Location'),
      'https://hi.dazbeez.com/thanks?contact_id=1',
    );
    assert.match(response.headers.get('Set-Cookie') ?? '', /Max-Age=0/);

    await Promise.all(waitUntilCalls);
    assert.equal(dbState.contacts.length, 1);
    assert.equal(dbState.contacts[0].source, 'google');
    assert.equal(fetchMock.mock.calls.length, 4);
  } finally {
    fetchMock.mock.restore();
  }
});

test('google callback completes the GIS POST happy path and clears the CSRF cookie', async () => {
  const dbState = createFakeDbState([{ token: 'card-1', label: 'card-1' }]);
  const env = createEnv({
    DB: createFakeD1Database(dbState),
  });
  const state = encodeOAuthState('expected-nonce', 'card-1');
  const form = new FormData();
  form.set('credential', createIdToken({
    aud: env.GOOGLE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iss: 'https://accounts.google.com',
    name: 'Google GIS Person',
    nonce: 'expected-nonce',
    email: 'google.gis@example.com',
  }));
  form.set('g_csrf_token', 'gsi-csrf-token');
  form.set('state', state);

  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return Response.json(createGoogleJwks());
      }

      return new Response('{}');
    },
  );

  try {
    const { context, waitUntilCalls } = createPagesContext({
      url: 'https://hi.dazbeez.com/auth/google/callback',
      method: 'POST',
      headers: {
        Cookie: 'g_csrf_token=gsi-csrf-token; __Host-oauth_state=expected-nonce',
      },
      body: form,
      env,
    });

    const response = await googleCallbackPost(context as never);

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('Location'),
      'https://hi.dazbeez.com/thanks?contact_id=1',
    );
    assert.match(response.headers.get('Set-Cookie') ?? '', /Max-Age=0/);

    await Promise.all(waitUntilCalls);
    assert.equal(dbState.contacts.length, 1);
    assert.equal(dbState.contacts[0].email, 'google.gis@example.com');
    assert.equal(dbState.contacts[0].source, 'google');
    assert.equal(fetchMock.mock.calls.length, 3);
  } finally {
    fetchMock.mock.restore();
  }
});

test('google callback rejects GIS POST requests with mismatched g_csrf_token', async () => {
  const env = createEnv({
    DB: createFakeD1Database(createFakeDbState([{ token: 'card-1', label: 'card-1' }])),
  });
  const form = new FormData();
  form.set('credential', 'placeholder');
  form.set('g_csrf_token', 'different-token');
  form.set('state', encodeOAuthState('expected-nonce', 'card-1'));

  const { context } = createPagesContext({
    url: 'https://hi.dazbeez.com/auth/google/callback',
    method: 'POST',
    headers: {
      Cookie: 'g_csrf_token=expected-token; __Host-oauth_state=expected-nonce',
    },
    body: form,
    env,
  });

  const response = await googleCallbackPost(context as never);
  const html = await response.text();

  assert.equal(response.status, 400);
  assert.match(html, /Google sign-in session could not be verified/);
  assert.match(response.headers.get('Set-Cookie') ?? '', /Max-Age=0/);
});

test('google callback logs notification failures without breaking the user flow', async () => {
  const dbState = createFakeDbState([{ token: 'card-1', label: 'card-1' }]);
  const env = createEnv({
    DB: createFakeD1Database(dbState),
  });
  const state = encodeOAuthState('expected-nonce', 'card-1');

  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          id_token: createIdToken({
            aud: env.GOOGLE_CLIENT_ID,
            exp: Math.floor(Date.now() / 1000) + 3600,
            iss: 'https://accounts.google.com',
            name: 'Google Person',
            nonce: 'expected-nonce',
            email: 'google.person@example.com',
          }),
        });
      }

      if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return Response.json(createGoogleJwks());
      }

      throw new Error('Webhook unavailable');
    },
  );

  try {
    const { context, waitUntilCalls } = createPagesContext({
      url: `https://hi.dazbeez.com/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      headers: {
        Cookie: '__Host-oauth_state=expected-nonce',
      },
      env,
    });

    const response = await googleCallback(context as never);

    assert.equal(response.status, 302);
    await Promise.all(waitUntilCalls);
    assert.equal(dbState.notificationFailures.length, 2);
    assert.equal(dbState.notificationFailures[0].channel, 'discord');
    assert.equal(dbState.notificationFailures[1].channel, 'email');
  } finally {
    fetchMock.mock.restore();
  }
});

test('google callback returns a recoverable error page when Google exchange fails', async () => {
  const env = createEnv({
    DB: createFakeD1Database(createFakeDbState([{ token: 'card-1', label: 'card-1' }])),
  });
  const state = encodeOAuthState('expected-nonce', 'card-1');

  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    return new Response('bad request', { status: 400 });
  });

  try {
    const { context } = createPagesContext({
      url: `https://hi.dazbeez.com/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      headers: {
        Cookie: '__Host-oauth_state=expected-nonce',
      },
      env,
    });

    const response = await googleCallback(context as never);
    const html = await response.text();

    assert.equal(response.status, 502);
    assert.match(html, /Back to card/);
    assert.match(html, /manual form/);
  } finally {
    fetchMock.mock.restore();
  }
});

test('linkedin callback completes the happy path', async () => {
  const dbState = createFakeDbState([{ token: 'card-1', label: 'card-1' }]);
  const env = createEnv({
    DB: createFakeD1Database(dbState),
  });
  const state = encodeOAuthState('expected-nonce', 'card-1');

  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url === 'https://www.linkedin.com/oauth/v2/accessToken') {
        return Response.json({ access_token: 'linkedin-access-token' });
      }

      if (url === 'https://api.linkedin.com/v2/userinfo') {
        return Response.json({
          name: 'LinkedIn Person',
          email: 'linkedin.person@example.com',
        });
      }

      return new Response('{}');
    },
  );

  try {
    const { context, waitUntilCalls } = createPagesContext({
      url: `https://hi.dazbeez.com/auth/linkedin/callback?code=abc&state=${encodeURIComponent(state)}`,
      headers: {
        Cookie: '__Host-oauth_state=expected-nonce',
      },
      env,
    });

    const response = await linkedinCallback(context as never);

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('Location'),
      'https://hi.dazbeez.com/thanks?contact_id=1',
    );

    await Promise.all(waitUntilCalls);
    assert.equal(dbState.contacts.length, 1);
    assert.equal(dbState.contacts[0].source, 'linkedin');
    assert.equal(fetchMock.mock.calls.length, 4);
  } finally {
    fetchMock.mock.restore();
  }
});

test('linkedin callback rejects mismatched CSRF state and clears the cookie', async () => {
  const env = createEnv({
    DB: createFakeD1Database(createFakeDbState([{ token: 'card-1', label: 'card-1' }])),
  });
  const state = encodeOAuthState('expected-nonce', 'card-1');
  const { context } = createPagesContext({
    url: `https://hi.dazbeez.com/auth/linkedin/callback?code=abc&state=${encodeURIComponent(state)}`,
    headers: {
      Cookie: '__Host-oauth_state=different-nonce',
    },
    env,
  });

  const response = await linkedinCallback(context as never);
  const html = await response.text();

  assert.equal(response.status, 400);
  assert.match(html, /LinkedIn sign-in issue/);
  assert.match(response.headers.get('Set-Cookie') ?? '', /Max-Age=0/);
});

test('linkedin callback returns a recoverable error page when LinkedIn exchange fails', async () => {
  const env = createEnv({
    DB: createFakeD1Database(createFakeDbState([{ token: 'card-1', label: 'card-1' }])),
  });
  const state = encodeOAuthState('expected-nonce', 'card-1');

  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    return new Response('bad request', { status: 400 });
  });

  try {
    const { context } = createPagesContext({
      url: `https://hi.dazbeez.com/auth/linkedin/callback?code=abc&state=${encodeURIComponent(state)}`,
      headers: {
        Cookie: '__Host-oauth_state=expected-nonce',
      },
      env,
    });

    const response = await linkedinCallback(context as never);
    const html = await response.text();

    assert.equal(response.status, 502);
    assert.match(html, /Back to card/);
    assert.match(html, /manual form/);
  } finally {
    fetchMock.mock.restore();
  }
});
