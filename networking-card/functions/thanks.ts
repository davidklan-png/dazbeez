import { page } from './_lib/html';

export const onRequestGet: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  const contactId = url.searchParams.get('contact_id') || '0';

  const html = page(
    'Thanks!',
    `
    <div class="thanks-icon">\ud83e\udd1d</div>
    <h1>Thanks for connecting!</h1>
    <p class="pitch">Great meeting you. I&rsquo;ll be in touch if anything comes up.</p>

    <div class="links">
      <a href="/vcard/${contactId}" class="btn btn-amber" download="david-klan.vcf">Save my contact</a>
      <a href="https://www.linkedin.com/in/davidklan" target="_blank" rel="noopener" class="btn btn-outline">Connect on LinkedIn</a>
    </div>`,
  );

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
};
