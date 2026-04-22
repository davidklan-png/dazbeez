import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMailtoUrl,
  buildPersonalizedEmail,
  buildThanksBody,
  normalizeLinkedinUrl,
  type KnownAttendee,
} from '../functions/_lib/personalization';

const topTierAttendee: KnownAttendee = {
  id: 1,
  email_lower: 'kei@example.com',
  linkedin_url: 'linkedin.com/in/kei-fujita-7115a8135',
  display_name: 'Kei Fujita',
  event_slug: 'uh-alumni-2026-04-22',
  tier: 'top',
  role_company: 'Consultant, EY Strategy & Consulting',
  opener: 'Great to meet you, Kei — looking forward to comparing notes on Japan RPA and BPR engagements.',
  david_notes: 'Potential collaborator.',
  cta_type: 'mailto_schedule',
  topic_hint: null,
};

test('buildThanksBody returns a schedule CTA for known top-tier attendees', () => {
  const body = buildThanksBody({
    attendee: topTierAttendee,
    contactName: 'Kei Fujita',
  });

  assert.equal(body.heading, 'Great to meet you, Kei!');
  assert.match(body.openerHtml, /comparing notes on Japan RPA and BPR engagements/);
  assert.match(body.ctaHtml, /Grab 15 min\?/);
  assert.match(body.ctaHtml, /mailto:david@dazbeez\.com\?subject=15%20min%20follow-up%20from%20the%20UH%20alumni%20event/);
});

test('buildThanksBody falls back to a name-only greeting for unknown attendees', () => {
  const body = buildThanksBody({
    attendee: null,
    contactName: 'Jordan Example',
  });

  assert.equal(body.heading, 'Great to meet you, Jordan!');
  assert.equal(body.openerHtml, '');
  assert.equal(body.ctaHtml, '');
});

test('buildPersonalizedEmail adds the tier-specific follow-up prompt', () => {
  const email = buildPersonalizedEmail({
    attendee: topTierAttendee,
    contactName: 'Kei Fujita',
    followUpUrl: 'https://hi.dazbeez.com/hi/card-1',
  });

  assert.equal(email.subject, 'Great meeting you at the UH alumni event');
  assert.match(email.textLines.join('\n'), /reply to this email with a couple of times that work/);
  assert.match(email.textLines.join('\n'), /https:\/\/hi\.dazbeez\.com\/hi\/card-1/);
});

test('normalizeLinkedinUrl trims protocol, www, and trailing slash', () => {
  assert.equal(
    normalizeLinkedinUrl('https://www.linkedin.com/in/Test-Profile/'),
    'linkedin.com/in/test-profile',
  );
  assert.equal(normalizeLinkedinUrl('https://example.com/in/test-profile'), null);
});

test('buildMailtoUrl encodes spaces as %20 for broader client compatibility', () => {
  const url = buildMailtoUrl({
    subject: 'Hello there',
    body: 'Line one\nLine two',
  });

  assert.equal(url, 'mailto:david@dazbeez.com?subject=Hello%20there&body=Line%20one%0ALine%20two');
});
