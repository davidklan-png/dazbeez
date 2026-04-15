import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONTACT_CARD,
  generateVCard,
  getVCardSummary,
  normalizeContactCardProfile,
  renderVCardSavedSheet,
} from '../functions/_lib/vcard';

test('generateVCard uses the centralized contact data', () => {
  const vcard = generateVCard();

  assert.match(vcard, new RegExp(`FN:${DEFAULT_CONTACT_CARD.fullName}`));
  assert.match(vcard, new RegExp(`ORG:${DEFAULT_CONTACT_CARD.organization}`));
  assert.match(vcard, new RegExp(`EMAIL;TYPE=INTERNET:${DEFAULT_CONTACT_CARD.email}`));
  assert.match(vcard, new RegExp(`URL:${DEFAULT_CONTACT_CARD.website}`));
  assert.match(vcard, new RegExp(`X-SOCIALPROFILE;TYPE=linkedin:${DEFAULT_CONTACT_CARD.linkedin}`));
});

test('saved sheet lists the contact fields and destination hints', () => {
  const summary = getVCardSummary();
  const sheet = renderVCardSavedSheet();

  assert.ok(summary.some((item) => item.label === 'File' && item.value === DEFAULT_CONTACT_CARD.fileName));
  assert.match(sheet, /What is in the card/);
  assert.match(sheet, /Where it usually goes/);
  assert.match(sheet, /Downloads folder as david-klan\.vcf/);
});

test('normalizeContactCardProfile cleans editable values', () => {
  const profile = normalizeContactCardProfile({
    fileName: ' David Klan Contact ',
    email: 'DAVID@DAZBEEZ.COM',
  });

  assert.equal(profile.fileName, 'David-Klan-Contact.vcf');
  assert.equal(profile.email, 'david@dazbeez.com');
});
