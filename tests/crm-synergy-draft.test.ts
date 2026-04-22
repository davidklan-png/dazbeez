import test from "node:test";
import assert from "node:assert/strict";
import mixedFixture from "@/tests/fixtures/mixed-ja-en-card.json";
import { analyzeSynergy, createEmailDraft } from "@/lib/crm-synergy";
import { normalizeExtractedFields } from "@/lib/crm-normalization";

const profile = {
  my_name: "David Klan",
  my_title: "AI, Automation & Data Consultant / IT PM + AI/ML Engineer",
  my_company: "Dazbeez G.K.",
  my_company_summary: "Dazbeez builds AI, automation, and data systems designed to stay correct.",
  my_personal_summary: "David helps experts do meaningful work with AI.",
  my_services: ["AI integration", "workflow automation", "data management", "governance", "project management"],
  my_target_industries: ["insurance", "finance", "professional services", "education", "logistics", "Japan-regulated businesses"],
  my_value_props: ["Auditable AI", "Maintainable delivery"],
  my_case_studies: [],
  my_company_website: "https://dazbeez.com",
  my_personal_website: "https://kinokoholic.com",
  my_linkedin: "https://www.linkedin.com/in/david-klan",
  my_discord_invite: "https://discord.gg/example",
  preferred_email_tone: "warm, intelligent, concise, practical",
  default_call_to_action: "Invite a practical follow-up conversation."
};

test("synergy analysis rewards regulated bilingual workflow overlap", () => {
  const normalized = normalizeExtractedFields(mixedFixture.fields);
  const synergy = analyzeSynergy({
    contactName: normalized.full_name,
    companyName: normalized.company_name,
    jobTitle: normalized.job_title,
    department: normalized.department,
    website: normalized.website,
    batchContext: {
      eventName: "Tokyo AI Meetup",
      eventDate: "2026-04-21",
      eventLocation: "Tokyo",
      notesAboutConversations: "Discussed bilingual compliance workflows and practical AI adoption."
    },
    extracted: normalized,
    enrichmentFacts: [
      {
        factType: "industry",
        label: "Industry",
        value: "Finance",
        sourceUrl: "https://mori-fg.co.jp",
        sourceTitle: "Mori Financial Group",
        sourceSnippet: "Financial services and governance",
        evidenceStrength: "high",
        retrievedAt: "2026-04-22T00:00:00.000Z"
      }
    ],
    profile
  });

  assert.ok(synergy.synergyScore >= 60);
  assert.ok(synergy.reasons.length >= 2);
});

test("draft generation always includes required Dazbeez links", () => {
  const normalized = normalizeExtractedFields(mixedFixture.fields);
  const synergy = analyzeSynergy({
    contactName: normalized.full_name,
    companyName: normalized.company_name,
    jobTitle: normalized.job_title,
    department: normalized.department,
    website: normalized.website,
    batchContext: {
      eventName: "Tokyo AI Meetup",
      eventDate: "2026-04-21",
      eventLocation: "Tokyo",
      notesAboutConversations: "Discussed governance."
    },
    extracted: normalized,
    enrichmentFacts: [],
    profile
  });
  const draft = createEmailDraft({
    contactName: normalized.full_name,
    companyName: normalized.company_name,
    profile,
    synergy,
    batchContext: {
      eventName: "Tokyo AI Meetup",
      eventDate: "2026-04-21",
      eventLocation: "Tokyo",
      notesAboutConversations: "Discussed governance."
    }
  });

  assert.match(draft.plainTextBody, /https:\/\/dazbeez\.com/);
  assert.match(draft.plainTextBody, /https:\/\/kinokoholic\.com/);
  assert.match(draft.plainTextBody, /https:\/\/www\.linkedin\.com\/in\/david-klan/);
  assert.match(draft.plainTextBody, /https:\/\/discord\.gg\/example/);
});

test("draft with missing discord invite omits discord line and has needs_review status", () => {
  const normalized = normalizeExtractedFields(mixedFixture.fields);
  const synergy = analyzeSynergy({
    contactName: normalized.full_name,
    companyName: normalized.company_name,
    jobTitle: normalized.job_title,
    department: normalized.department,
    website: normalized.website,
    batchContext: {
      eventName: "Tokyo AI Meetup",
      eventDate: "2026-04-21",
      eventLocation: "Tokyo",
      notesAboutConversations: "Discussed governance."
    },
    extracted: normalized,
    enrichmentFacts: [],
    profile: {
      ...profile,
      my_discord_invite: "",
    }
  });
  const draft = createEmailDraft({
    contactName: normalized.full_name,
    companyName: normalized.company_name,
    profile: {
      ...profile,
      my_discord_invite: "",
    },
    synergy,
    batchContext: {
      eventName: "Tokyo AI Meetup",
      eventDate: "2026-04-21",
      eventLocation: "Tokyo",
      notesAboutConversations: "Discussed governance."
    }
  });

  assert.doesNotMatch(draft.plainTextBody, /discord/i);
  assert.equal(draft.status, "needs_review");
});

test("synergy analysis awards points for Japanese-language financial company", () => {
  const synergy = analyzeSynergy({
    contactName: "三井 太郎",
    companyName: "三井保険株式会社",
    jobTitle: "業務部長",
    department: null,
    website: null,
    batchContext: {
      eventName: null,
      eventDate: null,
      eventLocation: null,
      notesAboutConversations: null
    },
    extracted: {
      full_name: null,
      first_name: null,
      last_name: null,
      full_name_native: null,
      job_title: null,
      department: null,
      company_name: null,
      company_name_native: null,
      email: null,
      phone: null,
      mobile: null,
      website: null,
      linkedin_url: null,
      address: null,
      postal_code: null,
      city: null,
      state_prefecture: null,
      country: null,
      notes_from_card: null,
      raw_ocr_text: "",
      pronouns: null,
      furigana: null,
      emails: [],
      phone_numbers: [],
    },
    enrichmentFacts: [],
    profile
  });

  assert.ok(synergy.reasons.length >= 1);
  assert.ok(synergy.reasons.some((reason) => reason.title === "Industry overlap"));
});
