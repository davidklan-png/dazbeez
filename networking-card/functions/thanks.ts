import { page } from './_lib/html';
import { renderVCardSavedSheet } from './_lib/vcard';
import { getVCardProfile } from './_lib/db';

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async (context) => {
  const url = new URL(context.request.url);
  const contactId = encodeURIComponent(url.searchParams.get('contact_id') || '0');
  const rawToken = url.searchParams.get('token');
  const safeToken = rawToken ? escapeAttribute(rawToken) : null;
  const vcardProfile = await getVCardProfile(context.env.DB);

  const backToCardLink = safeToken
    ? `<a href="/hi/${safeToken}" class="btn btn-outline">Back to David&rsquo;s card</a>`
    : '';

  const html = page(
    'Thanks!',
    `
    <div class="thanks-icon">\ud83e\udd1d</div>
    <h1>Thanks for connecting!</h1>
    <p class="pitch">Great meeting you. Save my contact now, and keep the card handy for the next time you want to explore what Dazbeez can help with.</p>

    <div class="links">
      ${backToCardLink}
      <a href="/vcard/${contactId}" class="btn btn-amber" download="${vcardProfile.fileName}" data-vcard-download>Save my contact</a>
      <a href="https://www.linkedin.com/in/david-klan" target="_blank" rel="noopener" class="btn btn-linkedin">Connect with me on LinkedIn</a>
      <a href="https://dazbeez.com/services" class="btn btn-outline">What I do</a>
      <a href="https://dazbeez.com/inquiry" class="btn btn-outline">Start an inquiry</a>
    </div>

    <p class="subcopy">A later tap can take you straight back into services, questions, follow-up, or my LinkedIn profile when the need is clearer.</p>
    ${renderVCardSavedSheet(vcardProfile)}`,
  );

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
};
