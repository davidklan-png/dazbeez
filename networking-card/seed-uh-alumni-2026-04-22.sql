-- Seed: UH alumni event, 2026-04-22.
-- 47 attendees. 20 have tier-specific personalization from research;
-- the remaining 27 fall through to tier='unknown' with a warm generic opener.
-- email_lower is NULL at seed time (we don't know attendees' emails yet);
-- matching happens via LinkedIn URL at tap time, and/or backfilled post-event
-- from Discord ping recognition.

-- ===========================================================================
-- TIER 1 — TOP: Japan-based direct peers / high-intent prospects
-- ===========================================================================

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('jp.linkedin.com/in/takeshi-ambiru-38070876', 'Takeshi Ambiru', 'uh-alumni-2026-04-22', 'top',
 'President, Aloha Works Co., Ltd. (Tokyo)',
 'Great to meet you, Takeshi — nice to run into another Japan-based bilingual consultant at a Hawaii event.',
 'Japan-based bilingual web/IT/automation shop president. Aloha Works does front-end/web; David does back-end AI/data/automation. Natural referral loop both directions.',
 'mailto_schedule', NULL);

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/kei-fujita-7115a8135', 'Kei Fujita', 'uh-alumni-2026-04-22', 'top',
 'Consultant, CX Transformation, EY Strategy & Consulting (Tokyo)',
 'Great to meet you, Kei — looking forward to comparing notes on Japan RPA and BPR engagements.',
 'EY Japan consultant in RPA / BPR / CX. Previously ABeam (RPA, SAP, AML/CFT). Peer and likely collaborator — could refer engagements too small for EY or co-deliver on bilingual projects.',
 'mailto_schedule', NULL);

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/scott-shimomura-0b37502', 'Scott Shimomura', 'uh-alumni-2026-04-22', 'top',
 'Head of Business Development, World Wide Technology (Tokyo)',
 'Great to meet you, Scott — looking forward to trading notes on enterprise Japan data and cloud work.',
 'Tokyo enterprise tech BD at WWT. Cloud / SaaS / data analytics for Japanese corporates. Natural co-sell or referral partner — your AI/automation layer on top of what his clients already buy.',
 'mailto_schedule', NULL);

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/junpei', 'Junpei Takatsuki', 'uh-alumni-2026-04-22', 'top',
 'Director, Strategy & Innovation, QVC Japan (Tokyo)',
 'Great to meet you, Junpei — would love to hear what innovation looks like on the ground at QVC Japan.',
 'Innovation mandate at QVC Japan. Retail / CRM / content workflows = strong automation targets. Shidler MBA ''05 (Japan Focus), Keio econ. Potential direct client.',
 'mailto_schedule', NULL);

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/kennard-wong-b5341525', 'Kennard Wong', 'uh-alumni-2026-04-22', 'top',
 'President, Unifrutti Japan; President, UH Alumni Japan Chapter',
 'Great to meet you, Kennard — as a fellow Japan-based UH alum I''d love to hear about the Japan chapter community.',
 'TRIPLE VALUE. Japan-based business operator (import/logistics — automation targets) + former EY ShinNihon auditor + UH Alumni Japan Chapter President (the single best door into the Japan-based UH alumni network). Mention you''re Japan-based immediately.',
 'mailto_schedule', NULL);

-- ===========================================================================
-- TIER 2 — SECOND: Connectors, referral sources, network hubs
-- ===========================================================================

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/fidelconsulting', 'Lawrence Kieffer', 'uh-alumni-2026-04-22', 'second',
 'CPC, Fidel Consulting (IT executive recruiter)',
 'Great to meet you, Lawrence — recruiters always have the best read on who''s hiring and who''s hurting.',
 'IT exec headhunter — places CTOs, CIOs, IT Directors. Knows every tech decision-maker in his market. A warm intro from him = direct line to David''s ideal client pipeline.',
 'mailto_schedule', NULL);

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/aj-halagao-5422344a', 'AJ Halagao', 'uh-alumni-2026-04-22', 'second',
 'President, Hawaii Leadership Forum; PACE Vice Chair',
 'Great to meet you, AJ — would love to hear what themes are coming up across HLF cohorts.',
 'Hawaii civic/business super-connector. MBA Shidler ''04, JD UCLA. Chairs Honolulu Grants-in-Aid. PACE vice chair, UH Foundation board. Companies coming through HLF programs are pipeline leads.',
 'mailto_schedule', NULL);

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/sandra-fujiyama-60969b7', 'Sandra Fujiyama', 'uh-alumni-2026-04-22', 'second',
 'Executive Director, PACE, UH Shidler',
 'Great to meet you, Sandra — the PACE program looks like it''s found real rhythm lately.',
 'Runs UH innovation hub. Former Wilson Sonsini IP partner. PACE cohort startups hit AI / data / automation walls regularly. Warm referral potential for inbound leads.',
 'mailto_schedule', NULL);

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/bianca-mordasini', 'Bianca Mordasini', 'uh-alumni-2026-04-22', 'second',
 'Senior Director, Alumni & External Relations, UH Shidler',
 'Great to meet you, Bianca — I''d love to plug into whatever Shidler alumni activity happens in Tokyo.',
 'Shidler alumni network hub. Knows every donor and active alumnus. Former PR/digital director at Trump Waikiki. 2020 Young Pro of the Year. Direct path to warm intros across the college community.',
 'mailto_schedule', NULL);

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/jlieu', 'Jennifer Lieu', 'uh-alumni-2026-04-22', 'second',
 'Director of Development, UH Shidler',
 'Great to meet you, Jennifer — mention this to Bianca if you run into her; would love to stay close to the college.',
 'Shidler development/fundraising. Knows every major donor — overlaps heavily with the people who hire consultants. Pair outreach with Bianca.',
 'mailto_schedule', NULL);

-- ===========================================================================
-- TIER 3 — THIRD: Credible adjacencies, referral potential, topic overlap
-- ===========================================================================

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/teruo-saito-b527b410', 'Teruo Saito', 'uh-alumni-2026-04-22', 'third',
 'Attorney, Anderson Mori & Tomotsune (Tokyo)',
 'Great to meet you, Teruo — APPI enforcement seems to shift every few months lately; curious what you''re hearing.',
 'Senior partner at top Japan international law firm. Former AIG Japan GC. PhD Hitotsubashi. Law firms with int''l clients regularly need bilingual AI / compliance advisory support. Referral potential from his corporate clients.',
 'mailto_resource', 'APPI and cross-border data governance');

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/steve-sombrero-8838834', 'Steve Sombrero', 'uh-alumni-2026-04-22', 'third',
 'President, Cushman & Wakefield ChaneyBrooks, Hawaii',
 'Great to meet you, Steve — Hawaii-Japan bridge people are rare; glad our paths crossed.',
 'Prominent Hawaii-Japan business bridge. Fluent Japanese (Okinawa/Tokyo family). MBA Shidler. Real estate ops (property mgmt, transaction pipelines, tenant reporting) are automation targets. Japan-America Society board.',
 'mailto_resource', 'replacing SaaS with self-hosted automation');

INSERT INTO known_attendees (display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('Cindy Yoshiko Shirata', 'uh-alumni-2026-04-22', 'third',
 'Specially Appointed Professor, Tokyo International University',
 'Great to meet you, Shirata-sensei — SAF2002 came up in my early reading on Japanese financial data.',
 'Pioneer in data-driven bankruptcy prediction using Japanese corporate data (SAF2002, CART / decision-tree). Marquis Who''s Who Lifetime Achiever. Not a client; a credible Tokyo academic peer in data / accounting.',
 'mailto_resource', 'data governance for Japanese regulatory environments');

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/dklchun', 'Daniel Chun', 'uh-alumni-2026-04-22', 'third',
 'Regional Vice President Hawaii, Alaska Airlines',
 'Great to meet you, Daniel — the HTA board seems to have a lot on its plate at the moment.',
 'Senior Hawaii airline exec, deep government and tourism ties. UH Manoa TIM. HTA board. Former Governor''s Tourism Liaison. Not immediate client target but a high-quality Hawaii business community connector. Long-term referral.',
 'mailto_resource', 'automation case studies from transportation and services');

INSERT INTO known_attendees (display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('Robert Zheng', 'uh-alumni-2026-04-22', 'third',
 'VP Business Development, WATG, Honolulu',
 'Great to meet you, Robert — hospitality design feels like a space where the data layer is still mostly untapped.',
 'Senior BD at global hospitality design firm. 5 years in Singapore office. Asia/Pacific exposure. Strong network node across Hawaii / SE Asia / China business. Good connector; not a direct client fit.',
 'mailto_resource', 'data workflows in hospitality projects');

INSERT INTO known_attendees (display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('David Lau', 'uh-alumni-2026-04-22', 'third',
 'Technical Sales Engineer, cybersecurity / AI-assisted security (Honolulu)',
 'Great to meet you, David — AI in security ops is one of the few places where the hype seems to track the reality.',
 'UNCERTAIN which David Lau — multiple Hawaii matches (cybersecurity SE, Chinese Chamber past president / Finance Factors director, real estate attorney). Cybersecurity SE is the most interesting fit for AI-assisted security automation. Probe lightly before assuming.',
 'mailto_resource', 'AI-assisted security automation');

-- ===========================================================================
-- TIER 4 — EARLY CAREER: Rising contacts, long-term relationships
-- ===========================================================================

INSERT INTO known_attendees (display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('Cassie Matsumoto', 'uh-alumni-2026-04-22', 'early',
 'Student, UH Shidler (Accounting + MIS + International Business)',
 'Great to meet you, Cassie — ping me when you land in Japan for the spring semester; happy to share a coffee list.',
 'Triple major Accounting + MIS + IB. Japan study abroad Spring 2026. Aspires CPA / tax attorney. Rising star — worth a long-term relationship. Follow up when she''s in Japan.',
 'linkedin_only', NULL);

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/kathleen-racoma-b1846a2b1', 'Kathleen Racoma', 'uh-alumni-2026-04-22', 'early',
 'BBA Candidate, UH Shidler; Intern, UHERO',
 'Great to meet you, Kathleen — UHERO does some of the most useful quiet work happening in Hawaii right now.',
 'UHERO economic research + Finance + IB. Rising data professional. Good long-term contact in the Hawaii data / economics space.',
 'linkedin_only', NULL);

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/codychenin', 'Cody Chen', 'uh-alumni-2026-04-22', 'early',
 'Student, UH Shidler ITM; NASA Langley intern (Summer 2025)',
 'Great to meet you, Cody — NASA Langley is a strong signal; looking forward to seeing where you head next.',
 'ITMA VP, NASA Langley engineering intern. Strong trajectory in the tech / data space. Future collaborator candidate.',
 'linkedin_only', NULL);

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type, topic_hint) VALUES
('linkedin.com/in/carlymiyamoto', 'Carly Miyamoto', 'uh-alumni-2026-04-22', 'early',
 'Student, UH Shidler; Media Assistant, PACE',
 'Great to meet you, Carly — bilingual marketing is its own craft and the good ones are rare.',
 'PACE media assistant, PacRim Marketing intern (Japanese / Korean content). Bilingual marketing skillset. Future collaborator candidate.',
 'linkedin_only', NULL);

-- ===========================================================================
-- TIER 5 — UNKNOWN: No strong public research match. Name-only personalization.
-- LinkedIn URLs included where discovered during research so OAuth taps match.
-- ===========================================================================

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, opener, cta_type) VALUES
('linkedin.com/in/ncbonilla', 'Niko Bonilla', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Niko — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Noah Camacho', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Noah — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('King Chu', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you — thanks for coming out to the alumni event.',
 'linkedin_only');

-- Daniel Chun appears once in the tier-3 section (Alaska Airlines VP). No
-- placeholder row here.

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Miki Doyon', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Miki — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Stefan Fujimoto', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Stefan — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Ashureah Fuller', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Ashureah — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Jacob Gordon', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Jacob — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Michael Harada', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Michael — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Kaelyn Hartigan-Go', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Kaelyn — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Chie Hashimoto', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Chie — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Jinghui Huang', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Jinghui — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Kevin Ing', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Kevin — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Brent Kobayashi', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Brent — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Kyle Kumasaka', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Kyle — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Haruki Lee', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Haruki — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Holden Lim', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Holden — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('David Luedecke-Kobiki', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, David — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Kevin Maher', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Kevin — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, opener, cta_type) VALUES
('linkedin.com/in/kaceymiura', 'Kacey Miura', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Kacey — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, opener, cta_type) VALUES
('linkedin.com/in/laraho', 'Lara Miyakawa Ho', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Lara — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Maya Miyasato', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Maya — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Naomi Nakatsuka', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Naomi — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Kareem Qureshi', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Kareem — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, role_company, opener, david_notes, cta_type) VALUES
('linkedin.com/in/vance-roley-3121a47', 'Vance Roley', 'uh-alumni-2026-04-22', 'unknown',
 'Outgoing Dean, UH Shidler College of Business',
 'Great to meet you, Dean Roley — thank you for two decades of building the college.',
 'Outgoing Shidler Dean after ~20 years. PhD Harvard. Former Federal Reserve Kansas City. Not a client/collaborator but a notable elder to acknowledge.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Shoji Tsuchimoto', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Shoji — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (display_name, event_slug, tier, opener, cta_type) VALUES
('Justin Wu', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Justin — thanks for coming out to the alumni event.',
 'linkedin_only');

INSERT INTO known_attendees (linkedin_url, display_name, event_slug, tier, opener, cta_type) VALUES
('linkedin.com/in/alexis-yorimoto-a62024303', 'Alexis Yorimoto', 'uh-alumni-2026-04-22', 'unknown',
 'Great to meet you, Alexis — thanks for coming out to the alumni event.',
 'linkedin_only');

-- ===========================================================================
-- SELF-TEST ENTRY: lets David validate the personalized post-tap flow using
-- his own email / LinkedIn profile without waiting for a real attendee match.
-- ===========================================================================

INSERT INTO known_attendees (
  email_lower,
  linkedin_url,
  display_name,
  event_slug,
  tier,
  role_company,
  opener,
  david_notes,
  cta_type,
  topic_hint
) VALUES (
  'david@dazbeez.com',
  'linkedin.com/in/david-klan',
  'David Klan',
  'uh-alumni-2026-04-22',
  'top',
  'Founder, Dazbeez',
  'Great to meet you, David — this is the self-test personalization path for validating the post-tap experience.',
  'Self-test row for validating attendee matching, personalized thank-you copy, and the schedule CTA.',
  'mailto_schedule',
  NULL
);
