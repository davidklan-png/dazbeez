import { type Env } from '../_lib/env';
import { logTap, getCard } from '../_lib/db';
import { page } from '../_lib/html';
import { getGoogleAuthUrl, getLinkedInAuthUrl } from '../_lib/oauth';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const raw = context.params.token;
  const token = (Array.isArray(raw) ? raw[0] : raw) as string;

  const card = await getCard(context.env.DB, token);
  if (!card) {
    return new Response('Not found', { status: 404 });
  }

  // Log tap asynchronously
  const cf = context.request.cf as Record<string, string> | undefined;
  const ua = context.request.headers.get('user-agent');
  context.waitUntil(
    logTap(
      context.env.DB,
      token,
      cf?.country ?? null,
      cf?.city ?? null,
      ua,
    ),
  );

  const origin = new URL(context.request.url).origin;
  const googleUrl = getGoogleAuthUrl(
    context.env.GOOGLE_CLIENT_ID,
    `${origin}/auth/google/callback`,
    token,
  );
  const linkedinUrl = getLinkedInAuthUrl(
    context.env.LINKEDIN_CLIENT_ID,
    `${origin}/auth/linkedin/callback`,
    token,
  );

  const html = page(
    'Hi from David',
    `
    <div class="photo">\ud83d\udc1d</div>
    <h1>David Klan</h1>
    <p class="pitch">AI, Automation &amp; Data &mdash; let&rsquo;s build something great.</p>

    <a href="${googleUrl}" class="btn btn-google">Sign in with Google</a>
    <a href="${linkedinUrl}" class="btn btn-linkedin">Sign in with LinkedIn</a>
    <button onclick="document.getElementById('manual-form').style.display='block';this.style.display='none'" class="btn btn-manual">Or enter your info</button>

    <form id="manual-form" method="POST" action="/submit">
      <input type="hidden" name="token" value="${token}">
      <div class="form-group">
        <label for="name">Name</label>
        <input type="text" id="name" name="name" required>
      </div>
      <div class="form-group">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" required>
      </div>
      <div class="form-group">
        <label for="company">Company (optional)</label>
        <input type="text" id="company" name="company">
      </div>
      <div class="form-group">
        <label for="linkedin_url">LinkedIn URL (optional)</label>
        <input type="url" id="linkedin_url" name="linkedin_url" placeholder="https://linkedin.com/in/...">
      </div>
      <button type="submit" class="btn btn-amber">Send</button>
    </form>

    <p class="privacy">Your info goes to David only, never shared.</p>`,
  );

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
};
