export interface ContactCardProfile {
  fileName: string;
  familyName: string;
  givenName: string;
  fullName: string;
  organization: string;
  title: string;
  email: string;
  website: string;
  linkedin: string;
}

export const DEFAULT_CONTACT_CARD: ContactCardProfile = {
  fileName: 'david-klan.vcf',
  familyName: 'Klan',
  givenName: 'David',
  fullName: 'David Klan',
  organization: 'Dazbeez',
  title: 'AI, Automation & Data Consultant',
  email: 'david@dazbeez.com',
  website: 'https://dazbeez.com',
  linkedin: 'https://www.linkedin.com/in/david-klan',
};

function sanitizeSingleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function sanitizeFileName(value: string): string {
  const trimmed = sanitizeSingleLine(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const withExtension = trimmed.toLowerCase().endsWith('.vcf')
    ? trimmed
    : `${trimmed || 'contact-card'}.vcf`;
  return withExtension || DEFAULT_CONTACT_CARD.fileName;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function normalizeContactCardProfile(
  input?: Partial<ContactCardProfile> | null,
): ContactCardProfile {
  const merged = {
    ...DEFAULT_CONTACT_CARD,
    ...(input ?? {}),
  };

  return {
    fileName: sanitizeFileName(merged.fileName),
    familyName: sanitizeSingleLine(merged.familyName) || DEFAULT_CONTACT_CARD.familyName,
    givenName: sanitizeSingleLine(merged.givenName) || DEFAULT_CONTACT_CARD.givenName,
    fullName: sanitizeSingleLine(merged.fullName) || DEFAULT_CONTACT_CARD.fullName,
    organization: sanitizeSingleLine(merged.organization) || DEFAULT_CONTACT_CARD.organization,
    title: sanitizeSingleLine(merged.title) || DEFAULT_CONTACT_CARD.title,
    email: sanitizeSingleLine(merged.email).toLowerCase() || DEFAULT_CONTACT_CARD.email,
    website: sanitizeSingleLine(merged.website) || DEFAULT_CONTACT_CARD.website,
    linkedin: sanitizeSingleLine(merged.linkedin) || DEFAULT_CONTACT_CARD.linkedin,
  };
}

export function getVCardSummary(
  profile: ContactCardProfile = DEFAULT_CONTACT_CARD,
): Array<{ label: string; value: string }> {
  const normalized = normalizeContactCardProfile(profile);
  return [
    { label: 'Name', value: normalized.fullName },
    { label: 'Company', value: normalized.organization },
    { label: 'Title', value: normalized.title },
    { label: 'Email', value: normalized.email },
    { label: 'Website', value: normalized.website },
    { label: 'LinkedIn', value: normalized.linkedin },
    { label: 'File', value: normalized.fileName },
  ];
}

export function renderVCardSavedSheet(
  profile: ContactCardProfile = DEFAULT_CONTACT_CARD,
): string {
  const normalized = normalizeContactCardProfile(profile);
  const detailRows = getVCardSummary(normalized)
    .map(
      (item) => `
        <li class="detail-row">
          <span class="detail-label">${escapeHtml(item.label)}</span>
          <span class="detail-value">${escapeHtml(item.value)}</span>
        </li>`,
    )
    .join('');

  return `
    <div id="vcard-sheet" class="sheet-backdrop" hidden aria-hidden="true">
      <div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="vcard-sheet-title">
        <div class="sheet-pill" aria-hidden="true"></div>
        <p class="sheet-eyebrow">Saved Contact</p>
        <h2 id="vcard-sheet-title">${escapeHtml(normalized.fullName)}&apos;s contact card was downloaded</h2>
        <p class="sheet-copy">Your device usually saves this as a <strong>${escapeHtml(normalized.fileName)}</strong> file and may also open a contacts import sheet right away.</p>

        <div class="sheet-section">
          <h3>What is in the card</h3>
          <ul class="detail-list">
            ${detailRows}
          </ul>
        </div>

        <div class="sheet-section">
          <h3>Where it usually goes</h3>
          <ul class="detail-list">
            <li class="detail-row">
              <span class="detail-label">iPhone / iPad</span>
              <span class="detail-value">Contacts import sheet or Files / Downloads</span>
            </li>
            <li class="detail-row">
              <span class="detail-label">Android</span>
              <span class="detail-value">Contacts chooser or Files / Downloads</span>
            </li>
            <li class="detail-row">
              <span class="detail-label">Desktop browser</span>
              <span class="detail-value">Downloads folder as ${escapeHtml(normalized.fileName)}</span>
            </li>
          </ul>
        </div>

        <p class="sheet-note">If nothing opened automatically, check your Downloads folder and open the file from there.</p>
        <button type="button" class="btn btn-amber sheet-close" data-vcard-sheet-close>Continue</button>
      </div>
    </div>`;
}

export function generateVCard(
  profile: ContactCardProfile = DEFAULT_CONTACT_CARD,
): string {
  const normalized = normalizeContactCardProfile(profile);

  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${normalized.familyName};${normalized.givenName};;;`,
    `FN:${normalized.fullName}`,
    `ORG:${normalized.organization}`,
    `TITLE:${normalized.title}`,
    `EMAIL;TYPE=INTERNET:${normalized.email}`,
    `URL:${normalized.website}`,
    `X-SOCIALPROFILE;TYPE=linkedin:${normalized.linkedin}`,
    'END:VCARD',
  ].join('\r\n');
}
