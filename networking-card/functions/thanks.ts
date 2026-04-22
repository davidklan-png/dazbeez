import { page } from './_lib/html';
import { renderVCardSavedSheet } from './_lib/vcard';
import { getContactById, getKnownAttendee, getVCardProfile } from './_lib/db';
import { buildThanksBody } from './_lib/personalization';

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
  const contactIdRaw = url.searchParams.get('contact_id');
  const contactIdParam = encodeURIComponent(contactIdRaw || '0');
  const rawToken = url.searchParams.get('token');
  const safeToken = rawToken ? escapeAttribute(rawToken) : null;
  const vcardProfile = await getVCardProfile(context.env.DB);

  // Resolve the contact + known-attendee match (if any). Both lookups are
  // best-effort — any failure falls through to the generic thank-you body.
  let thanksBody = { heading: 'Thanks for connecting!', openerHtml: '', ctaHtml: '' };
  const contactIdNum = contactIdRaw ? parseInt(contactIdRaw, 10) : NaN;
  if (Number.isFinite(contactIdNum) && contactIdNum > 0) {
    try {
      const contact = await getContactById(context.env.DB, contactIdNum);
      if (contact) {
        const attendee = await getKnownAttendee(
          context.env.DB,
          contact.email,
          contact.linkedin_url,
        );
        thanksBody = buildThanksBody({ attendee, contactName: contact.name });
      }
    } catch (error) {
      console.error('thanks personalization lookup failed', error);
    }
  }

  const backToCardLink = safeToken
    ? `<a href="/hi/${safeToken}" class="btn btn-outline">Back to David&rsquo;s card</a>`
    : '';

  // Default pitch — only rendered when we don't have a personalized opener.
  const defaultPitch = thanksBody.openerHtml
    ? ''
    : '<p class="pitch">Great meeting you. Save my contact now, and keep the card handy for the next time you want to explore what Dazbeez can help with.</p>';

  const html = page(
    'Thanks!',
    `
    <div class="thanks-icon">\ud83e\udd1d</div>
    <h1>${thanksBody.heading}</h1>
    ${thanksBody.openerHtml}
    ${defaultPitch}

    <div class="links">
      ${thanksBody.ctaHtml}
      ${backToCardLink}
      <a href="/vcard/${contactIdParam}" class="btn btn-amber" download="${vcardProfile.fileName}" data-vcard-download>Save my contact</a>
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
