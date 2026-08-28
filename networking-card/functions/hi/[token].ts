import { type Env } from '../_lib/env';
import { logTap, getCard, getVCardProfile } from '../_lib/db';
import { page } from '../_lib/html';
import { encodeOAuthState } from '../_lib/oauth';
import { renderVCardSavedSheet } from '../_lib/vcard';

function renderProviderNote(copy: string): string {
  return `<p class="provider-note">${copy}</p>`;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const raw = context.params.token;
  const token = (Array.isArray(raw) ? raw[0] : raw) as string;

  const card = await getCard(context.env.DB, token);
  if (!card) {
    return new Response('Not found', { status: 404 });
  }

  // Log tap asynchronously. asOrganization (the visitor's network — e.g.
  // "NTT Docomo" vs a hosting provider) is the human-vs-crawler signal;
  // cf_city is CGNAT-noisy and must not be trusted as a location.
  // The catch is permanent, same rule as the saveContact paths: a tap-logging
  // failure must announce itself in the logs, not silently stop the instrument
  // (e.g. if this ever deploys ahead of the taps ALTER).
  const cf = context.request.cf as Record<string, string> | undefined;
  const ua = context.request.headers.get('user-agent');
  context.waitUntil(
    logTap(
      context.env.DB,
      token,
      cf?.country ?? null,
      cf?.city ?? null,
      ua,
      cf?.asOrganization ?? null,
    ).catch((error) => console.error('[hi/:token] logTap failed', error)),
  );

  const vcardProfile = await getVCardProfile(context.env.DB);

  // Generate a random nonce for CSRF protection. The nonce is bound to this
  // page load via a short-lived cookie; the callback verifies it matches.
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const state = encodeOAuthState(nonce, token);

  const googleSignIn = context.env.GOOGLE_CLIENT_ID
    ? `
    <p class="divider-label">or one tap with Google</p>
    <script src="https://accounts.google.com/gsi/client" async defer></script>
    <script>
      function handleGisResponse(response) {
        var form = document.createElement('form');
        form.method = 'POST';
        form.action = '/auth/google/callback';
        var c = document.createElement('input');
        c.type = 'hidden'; c.name = 'credential'; c.value = response.credential;
        form.appendChild(c);
        var s = document.createElement('input');
        s.type = 'hidden'; s.name = 'state'; s.value = '${state}';
        form.appendChild(s);
        document.body.appendChild(form);
        form.submit();
      }
    </script>
    <div id="g_id_onload"
      data-client_id="${context.env.GOOGLE_CLIENT_ID}"
      data-callback="handleGisResponse"
      data-nonce="${nonce}"
      data-context="use"
      data-ux_mode="popup"
      data-auto_prompt="false"
      data-use_fedcm_for_button="true"
      data-button_auto_select="true"></div>
    <div class="google-signin-shell">
      <div
        class="g_id_signin"
        data-type="standard"
        data-shape="pill"
        data-theme="filled_blue"
        data-text="continue_with"
        data-size="large"
        data-logo_alignment="left"
        data-width="320"></div>
    </div>`
    : renderProviderNote(
        'Google sign-in is temporarily unavailable \u2014 the form above saves your details just the same.',
      );

  const html = page(
    'Hi from David',
    `
    <p class="eyebrow">Tap. Save. Connect.</p>
    <div class="photo">\ud83d\udc1d</div>
    <h1>David Klan</h1>
    <p class="pitch">Let&rsquo;s swap details.</p>

    <p class="divider-label">Save my details</p>
    <a href="/vcard/${token}" class="btn btn-amber" download="${vcardProfile.fileName}" data-vcard-download>Save David&rsquo;s contact</a>
    <a href="https://www.linkedin.com/in/david-klan" target="_blank" rel="noopener" class="btn btn-linkedin">Connect with David on LinkedIn</a>

    <p class="divider-label">Share yours</p>
    <form id="manual-form" method="POST" action="/submit">
      <input type="hidden" name="token" value="${token}">
      <div class="form-group">
        <label for="name">Name</label>
        <input type="text" id="name" name="name" autocomplete="name" required>
      </div>
      <div class="form-group">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" autocomplete="email" required>
      </div>
      <div class="form-group">
        <label for="company">Company (optional)</label>
        <input type="text" id="company" name="company" autocomplete="organization">
      </div>
      <div class="form-group">
        <label for="linkedin_url">LinkedIn URL (optional)</label>
        <input type="url" id="linkedin_url" name="linkedin_url" autocomplete="url" placeholder="https://linkedin.com/in/...">
      </div>
      <button type="submit" class="btn btn-amber">Send</button>
    </form>

    ${googleSignIn}

    <div class="footer-links">
      <a href="https://dazbeez.com/services">What I do</a>
      <a href="https://dazbeez.com/contact">Start an inquiry</a>
      <a href="https://dazbeez.com/business-card">About this card</a>
    </div>

    <p class="privacy">Your info goes to David only. Never shared.</p>
    ${renderVCardSavedSheet(vcardProfile)}`,
  );

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': `__Host-oauth_state=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
    },
  });
};
