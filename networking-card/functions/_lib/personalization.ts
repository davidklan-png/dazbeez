// Personalization helpers for the post-tap experience.
//
// Flow:
//   1. After saveContact() resolves, notifications.ts calls lookupAttendee()
//      with the submitted email + linkedin_url. Either returns a row from
//      known_attendees or null.
//   2. thanks.ts / notifications.ts branch on that result and assemble the
//      appropriate copy via the build* helpers below.
//
// Unknown tappers (lookup returned null) still get their first name used in
// the thanks heading and email greeting — the build* helpers accept a name
// argument for that case.

export type AttendeeTier = 'top' | 'second' | 'third' | 'early' | 'unknown';
export type AttendeeCta = 'mailto_schedule' | 'mailto_resource' | 'linkedin_only';

export interface KnownAttendee {
  id: number;
  email_lower: string | null;
  linkedin_url: string | null;
  display_name: string;
  event_slug: string;
  tier: AttendeeTier;
  role_company: string | null;
  opener: string;
  david_notes: string | null;
  cta_type: AttendeeCta;
  topic_hint: string | null;
}

const DAVID_EMAIL = 'david@dazbeez.com';

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalize a LinkedIn URL for matching against the stored index.
 * Strips protocol, "www.", trailing slash, lowercases. Returns null if input
 * is empty or clearly not a LinkedIn profile URL.
 */
export function normalizeLinkedinUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim().toLowerCase();
  if (!trimmed) return null;
  const withoutProtocol = trimmed.replace(/^https?:\/\//, '');
  const withoutWww = withoutProtocol.replace(/^www\./, '');
  const withoutTrailingSlash = withoutWww.replace(/\/+$/, '');
  if (!withoutTrailingSlash.includes('linkedin.com/')) return null;
  return withoutTrailingSlash;
}

export function firstName(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/\s+/);
  return parts[0];
}

// --- mailto URL assembly ---------------------------------------------------

export function buildMailtoUrl(args: { subject: string; body: string }): string {
  const params = new URLSearchParams();
  params.set('subject', args.subject);
  params.set('body', args.body);
  // URLSearchParams uses "+" for spaces; mailto clients tolerate it, but
  // encodeURIComponent-style "%20" is more broadly compatible.
  const qs = params.toString().replace(/\+/g, '%20');
  return `mailto:${DAVID_EMAIL}?${qs}`;
}

function scheduleMailto(first: string): string {
  return buildMailtoUrl({
    subject: '15 min follow-up from the UH alumni event',
    body: [
      'Hi David,',
      '',
      'Great meeting you yesterday. Wanted to grab 15 minutes to continue the conversation — here are a couple of times that work on my end:',
      '',
      '- ',
      '- ',
      '',
      'Best,',
      first,
    ].join('\n'),
  });
}

function resourceMailto(first: string, topicHint: string | null): string {
  const topic = topicHint && topicHint.trim().length > 0 ? topicHint : 'what we discussed';
  return buildMailtoUrl({
    subject: 'Following up from the UH alumni event',
    body: [
      'Hi David,',
      '',
      `Great meeting you yesterday. You mentioned you could share a writeup related to ${topic} — would love to see it when you have a moment.`,
      '',
      'Best,',
      first,
    ].join('\n'),
  });
}

// --- HTML escaping --------------------------------------------------------

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

// --- /thanks body assembly -------------------------------------------------

export interface ThanksBody {
  heading: string;
  openerHtml: string; // may be empty string
  ctaHtml: string;    // may be empty string (for linkedin_only or unknown)
}

/**
 * Build the personalized portion of the /thanks page body.
 *
 * For known attendees: returns tier-appropriate heading + opener paragraph +
 * primary CTA button HTML.
 *
 * For unknown tappers (attendee=null): returns a name-only heading and
 * empty opener/cta so the caller can keep its existing generic body.
 */
export function buildThanksBody(args: {
  attendee: KnownAttendee | null;
  contactName: string;
}): ThanksBody {
  const first = firstName(args.contactName) || 'there';
  const safeFirst = escapeHtml(first);

  if (!args.attendee) {
    return {
      heading: `Great to meet you, ${safeFirst}!`,
      openerHtml: '',
      ctaHtml: '',
    };
  }

  const attendee = args.attendee;
  const heading = `Great to meet you, ${safeFirst}!`;
  const openerHtml = attendee.opener
    ? `<p class="pitch">${escapeHtml(attendee.opener)}</p>`
    : '';

  let ctaHtml = '';
  switch (attendee.cta_type) {
    case 'mailto_schedule': {
      const href = scheduleMailto(first);
      ctaHtml = `<a href="${escapeAttribute(href)}" class="btn btn-amber">Grab 15 min?</a>`;
      break;
    }
    case 'mailto_resource': {
      const href = resourceMailto(first, attendee.topic_hint);
      ctaHtml = `<a href="${escapeAttribute(href)}" class="btn btn-amber">Send me that writeup</a>`;
      break;
    }
    case 'linkedin_only':
    default:
      ctaHtml = '';
      break;
  }

  return { heading, openerHtml, ctaHtml };
}

// --- Personalized acknowledgment email assembly ----------------------------

export interface PersonalizedEmail {
  subject: string;
  textLines: string[];
}

/**
 * Build the personalized acknowledgment email body. Caller hands the result
 * to sendAcknowledgmentEmail() via its `personalization` parameter.
 */
export function buildPersonalizedEmail(args: {
  attendee: KnownAttendee;
  contactName: string;
  followUpUrl?: string;
}): PersonalizedEmail {
  const first = firstName(args.contactName) || args.contactName;
  const lines: string[] = [
    `Hi ${first},`,
    '',
    args.attendee.opener,
    '',
    "I'm David Klan — I run Dazbeez, an AI, Automation & Data consultancy. You can save my contact card from the thank-you page whenever it is convenient.",
  ];

  if (args.attendee.cta_type === 'mailto_schedule') {
    lines.push('');
    lines.push('If it feels useful, reply to this email with a couple of times that work and we can compare notes for 15 minutes next week.');
  } else if (args.attendee.cta_type === 'mailto_resource') {
    const topic = args.attendee.topic_hint && args.attendee.topic_hint.trim().length > 0
      ? args.attendee.topic_hint
      : 'what we discussed';
    lines.push('');
    lines.push(`Happy to send over something relevant to ${topic} — just reply and I\'ll dig it out.`);
  }

  lines.push('');
  lines.push('Connect with me on LinkedIn: https://www.linkedin.com/in/david-klan');

  if (args.followUpUrl) {
    lines.push('');
    lines.push(`Keep this card handy and tap again later: ${args.followUpUrl}`);
  }

  lines.push('');
  lines.push('Best,');
  lines.push('David Klan');
  lines.push('david@dazbeez.com');
  lines.push('https://dazbeez.com');

  return {
    subject: 'Great meeting you at the UH alumni event',
    textLines: lines,
  };
}

// --- Personalized Discord embed assembly -----------------------------------

const TIER_EMOJI: Record<AttendeeTier, string> = {
  top: '\u2b50\u2b50\u2b50',      // ⭐⭐⭐
  second: '\u2b50\u2b50',          // ⭐⭐
  third: '\u2b50',                  // ⭐
  early: '\ud83c\udf31',           // 🌱
  unknown: '\ud83d\udcc7',         // 📇
};

const TIER_COLOR: Record<AttendeeTier, number> = {
  top: 0xd97706,      // amber-600 (hot)
  second: 0xf59e0b,   // amber-500 (default brand)
  third: 0xfbbf24,    // amber-400
  early: 0x34d399,    // emerald-400
  unknown: 0x9ca3af,  // gray-400
};

const WALK_OVER_HINT = 'Still on-site? Consider walking over.';

export interface PersonalizedDiscord {
  title: string;
  color: number;
  extraFields: Array<{ name: string; value: string; inline: boolean }>;
  footerText?: string;
}

/**
 * Build the personalized Discord embed additions. Caller merges these with
 * the default payload in discord.ts.
 */
export function buildPersonalizedDiscord(attendee: KnownAttendee): PersonalizedDiscord {
  const emoji = TIER_EMOJI[attendee.tier];
  const tierLabel =
    attendee.tier === 'top' ? 'TOP TIER'
    : attendee.tier === 'second' ? 'SECOND TIER'
    : attendee.tier === 'third' ? 'THIRD TIER'
    : attendee.tier === 'early' ? 'EARLY CAREER'
    : 'KNOWN ATTENDEE';

  const title = `${emoji} ${tierLabel} — New Contact`;
  const color = TIER_COLOR[attendee.tier];

  const extraFields: Array<{ name: string; value: string; inline: boolean }> = [];
  if (attendee.role_company) {
    extraFields.push({ name: 'Role', value: attendee.role_company, inline: false });
  }
  if (attendee.david_notes) {
    // Discord embed field value limit is 1024 chars.
    const truncated = attendee.david_notes.length > 1000
      ? attendee.david_notes.slice(0, 1000) + '…'
      : attendee.david_notes;
    extraFields.push({ name: 'Notes', value: truncated, inline: false });
  }

  return {
    title,
    color,
    extraFields,
    footerText: (attendee.tier === 'top' || attendee.tier === 'second')
      ? WALK_OVER_HINT
      : undefined,
  };
}
