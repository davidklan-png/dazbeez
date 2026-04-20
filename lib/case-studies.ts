import type { ServiceSlug } from "@/lib/services";

export type CaseStudySlug =
  | "receipt-classification"
  | "japanese-tax-expert"
  | "ceremony-scripts"
  | "enterprise-ai-enablement"
  | "networking-card";

export type CaseStudy = {
  slug: CaseStudySlug;
  title: string;
  tagline: string;
  client: string;
  problem: string;
  solution: string;
  outcome: string;
  techStack: string[];
  relatedServices: ServiceSlug[];
};

export const caseStudies: Record<CaseStudySlug, CaseStudy> = {
  "receipt-classification": {
    slug: "receipt-classification",
    title: "Receipt Classification & Tax Matching",
    tagline: "OCR + NTA validation for Japanese cooperative expense reconciliation",
    client: "Japanese consumer cooperative",
    problem:
      "The cooperative processed hundreds of paper receipts each month against credit card statements for tax filing. The matching process was entirely manual, spread across multiple staff members, and produced no audit trail — leaving the cooperative exposed during NTA reviews and burning hours each period that should have gone elsewhere.",
    solution:
      "Built a mobile-first capture workflow using Google Cloud Vision API to extract merchant name, date, and amount from Japanese receipts. A classification layer validates each NTA invoice registration number against the official registry and matches receipts to the corresponding card transactions. Anomalies surface for human review; clean matches pass straight through. Results export in MoneyForward-compatible CSV with a tamper-evident audit log persisted to a FastAPI + SQLite backend.",
    outcome:
      "Monthly reconciliation time cut by over 70%. Every matched receipt now carries an NTA-compliant audit record retained for seven years. The MoneyForward export eliminated double-entry work for the accounting team entirely.",
    techStack: [
      "Google Cloud Vision API",
      "FastAPI",
      "SQLite",
      "React / Vite",
      "Python",
      "NTA invoice registry validation",
    ],
    relatedServices: ["ai", "data"],
  },

  "japanese-tax-expert": {
    slug: "japanese-tax-expert",
    title: "Japanese Tax Expert System",
    tagline: "Citation-backed RAG over NTA and e-Gov for tax advisory workflows",
    client: "Tax advisory firm",
    problem:
      "Japanese tax advisors needed to locate specific statutory provisions quickly and produce defensible citations for client communications. Searching NTA publications and e-Gov PDFs manually was slow, prone to missing recent amendments, and gave no structured way to share query results across the firm.",
    solution:
      "Built a multi-tenant RAG system ingesting NTA publications and e-Gov statutory data into a vector store. Each query returns a grounded answer with direct citations — section, article, effective date — linked to the source document. Tenant isolation ensures each firm sees only its own query history and document set, with per-tenant document upload for custom memoranda.",
    outcome:
      "Statutory lookup time reduced from hours to minutes. Every answer ships with a verifiable citation the advisor can share with clients directly. Multi-tenant architecture lets the same deployment serve multiple advisory practices without data bleed.",
    techStack: [
      "RAG pipeline",
      "Vector search",
      "LLM (citation-grounded)",
      "NTA / e-Gov data ingestion",
      "Multi-tenant auth",
      "Python",
    ],
    relatedServices: ["ai", "governance"],
  },

  "ceremony-scripts": {
    slug: "ceremony-scripts",
    title: "Bilingual Ceremony Script Generator",
    tagline: "Grounded JP/EN script generation for ceremony planners using NotebookLM",
    client: "Ceremony planning studio",
    problem:
      "Drafting bilingual Japanese/English ceremony scripts required planners to tailor each one to the venue, guest mix, and programme milestones — a multi-hour process per event that produced inconsistent tone and forced planners to start from scratch every time.",
    solution:
      "Used NotebookLM\u2019s grounded generation to anchor outputs to real ceremony source material. Planners input event details — venue, guest demographics, milestones, honorifics — and the system produces a structured bilingual draft aligned to the venue\u2019s style guide and ordering. The generation is grounded: every section traces back to the source corpus rather than being hallucinated.",
    outcome:
      "Script drafting time reduced by 75%. Bilingual output is consistent in tone because it is grounded in real ceremonial source text, not generated from training priors alone. Planners now focus on customization rather than from-scratch composition.",
    techStack: [
      "NotebookLM",
      "Grounded LLM generation",
      "Bilingual templating (JP / EN)",
      "Document corpus ingestion",
    ],
    relatedServices: ["ai"],
  },

  "enterprise-ai-enablement": {
    slug: "enterprise-ai-enablement",
    title: "Enterprise AI Enablement",
    tagline: "Insurance reporting and incident intelligence across Confluence, Jira, SharePoint, and ServiceNow",
    client: "Insurance operator",
    problem:
      "An insurance operations team tracked reporting and incidents across four separate platforms with no unified visibility. Producing a monthly compliance summary meant manually pulling data from Confluence, Jira, SharePoint, and ServiceNow and reconciling them in spreadsheets — a process that took days and was error-prone enough to require a dedicated review cycle.",
    solution:
      "Built Python ETL pipelines that extract and normalize data from all four systems into a shared schema on a refresh schedule. An AI classification layer assigns each incident a severity tier and domain category using LLM inference over the raw ticket text. Power BI dashboards surface aggregated reporting, incident trends, SLA compliance, and cross-system anomaly flags — all auto-refreshed without manual intervention.",
    outcome:
      "Cross-system reporting consolidated into a single Power BI view. Incident mean-time-to-surface reduced by 60%. The compliance team eliminated manual monthly report production entirely.",
    techStack: [
      "Python ETL",
      "Power BI",
      "Confluence API",
      "Jira API",
      "SharePoint API",
      "ServiceNow API",
      "LLM incident classification",
    ],
    relatedServices: ["automation", "pm"],
  },

  "networking-card": {
    slug: "networking-card",
    title: "Dazbeez Networking Card",
    tagline: "NFC lead capture with vCard, OAuth, Discord alerts, and a reusable return path",
    client: "Dazbeez (internal product)",
    problem:
      "Paper business cards from networking events go stale within days: the contact goes unsaved, follow-ups get missed, and there is no way to tell which event or conversation produced a warm lead. Existing digital card tools are either one-way (just a link) or too high-friction for a standing conversation at an event.",
    solution:
      "Built hi.dazbeez.com on Cloudflare Pages + Functions + D1. Every tap routes through a mobile landing page where the visitor downloads David\u2019s vCard, then registers via Google GIS OAuth, LinkedIn, or a manual form. D1 deduplicates contacts while logging each registration event separately. Successful captures trigger a Discord alert and a Resend follow-up email with a return-path link back to dazbeez.com. The admin dashboard shows tap patterns, sign-in method breakdown, and per-event conversion.",
    outcome:
      "Every event tap now produces a timestamped lead record with sign-in method, source token, and follow-up email delivery status. The same physical card is reusable across events without reprinting. Admin dashboard gives full visibility into conversion and tap patterns without manual tracking.",
    techStack: [
      "Cloudflare Pages",
      "Cloudflare Functions",
      "Cloudflare D1 (SQLite edge)",
      "Google GIS OAuth",
      "Resend (transactional email)",
      "Discord webhooks",
      "NFC tags / QR codes",
      "vCard (RFC 6350)",
    ],
    relatedServices: ["automation", "data"],
  },
};

export const caseStudyList: CaseStudy[] = [
  caseStudies["receipt-classification"],
  caseStudies["japanese-tax-expert"],
  caseStudies["ceremony-scripts"],
  caseStudies["enterprise-ai-enablement"],
  caseStudies["networking-card"],
];

export const caseStudySlugs: CaseStudySlug[] = caseStudyList.map((c) => c.slug);

export function isCaseStudySlug(value: string | null | undefined): value is CaseStudySlug {
  return !!value && value in caseStudies;
}

export function caseStudiesByService(service: ServiceSlug): CaseStudy[] {
  return caseStudyList.filter((c) => c.relatedServices.includes(service));
}
