import type {
  DazbeezProfileSettings,
  EmailDraftPayload,
  EnrichmentFactInput,
  ExtractedContactFields,
  SynergyAnalysisPayload,
  SynergyReason,
} from "@/lib/crm-types";

export interface SynergyInput {
  contactName: string | null;
  companyName: string | null;
  jobTitle: string | null;
  department: string | null;
  website: string | null;
  batchContext: {
    eventName: string | null;
    eventDate: string | null;
    eventLocation: string | null;
    notesAboutConversations: string | null;
  };
  extracted: ExtractedContactFields;
  enrichmentFacts: EnrichmentFactInput[];
  profile: DazbeezProfileSettings;
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term.toLowerCase()));
}

function uniqueReasons(reasons: SynergyReason[]): SynergyReason[] {
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    if (seen.has(reason.title)) {
      return false;
    }

    seen.add(reason.title);
    return true;
  });
}

export function analyzeSynergy(input: SynergyInput): SynergyAnalysisPayload {
  const factsText = input.enrichmentFacts
    .map((fact) => `${fact.label}: ${fact.value}`)
    .join(" | ")
    .toLowerCase();
  const searchable = [
    input.companyName,
    input.jobTitle,
    input.department,
    input.extracted.raw_ocr_text,
    factsText,
    input.batchContext.notesAboutConversations,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const reasons: SynergyReason[] = [];
  const evidence = input.enrichmentFacts.map((fact, index) => ({
    id: `fact_${index + 1}`,
    label: `${fact.label}: ${fact.value}`,
    source: fact.sourceUrl,
  }));

  const addReason = (title: string, detail: string, scoreContribution: number, evidenceRefs: string[]) => {
    reasons.push({ title, detail, scoreContribution, evidenceRefs });
  };

  if (containsAny(searchable, ["insurance", "finance", "bank", "broker", "claims", "audit", "保険", "金融", "銀行", "証券", "監査", "経理", "ブローカー"])) {
    addReason(
      "Industry overlap",
      "The company appears to operate in a sector where Dazbeez already emphasizes document-heavy, regulated, and operationally sensitive delivery.",
      22,
      evidence.slice(0, 2).map((item) => item.id),
    );
  }

  if (containsAny(searchable, ["operations", "project", "transformation", "program", "pm", "analyst", "director", "manager", "head", "業務", "プロジェクト", "変革", "変換", "マネージャー", "部長", "課長", "取締役", "分析", "ディレクター"])) {
    addReason(
      "Role is close to implementation ownership",
      "The contact's role looks close to operations, transformation, or delivery leadership, which increases the chance of a practical follow-up being relevant.",
      18,
      evidence.slice(0, 2).map((item) => item.id),
    );
  }

  if (containsAny(searchable, ["ai", "automation", "workflow", "document", "data", "governance", "knowledge", "AI", "自動化", "ワークフロー", "文書", "データ", "ガバナンス", "ナレッジ", "人工知能"])) {
    addReason(
      "Service-line relevance",
      "The extracted and enriched material points toward workflows that align directly with Dazbeez's AI, automation, data, or governance services.",
      24,
      evidence.slice(0, 3).map((item) => item.id),
    );
  }

  if (containsAny(searchable, ["japan", "japanese", "bilingual", "global", "cross-border", "regulatory", "compliance", "日本", "バイリンガル", "グローバル", "コンプライアンス", "規制", "国際"])) {
    addReason(
      "Cross-cultural or governance fit",
      "There are signs of bilingual, Japan-related, or compliance-sensitive work where Dazbeez's public positioning is unusually specific.",
      18,
      evidence.slice(0, 3).map((item) => item.id),
    );
  }

  if (containsAny(searchable, ["manual", "repetitive", "intake", "reporting", "approval", "spreadsheet", "paper", "手動", "繰り返し", "申請", "報告", "承認", "スプレッドシート", "紙"])) {
    addReason(
      "Workflow improvement opportunity",
      "The available evidence suggests repetitive or document-driven work that could benefit from auditable automation rather than a generic AI pitch.",
      20,
      evidence.slice(0, 3).map((item) => item.id),
    );
  }

  const resolvedReasons = uniqueReasons(reasons).slice(0, 5);
  const totalScore = Math.max(
    20,
    Math.min(
      100,
      resolvedReasons.reduce((sum, reason) => sum + reason.scoreContribution, 8),
    ),
  );

  const companyOrRole = input.companyName || input.jobTitle || "their current work";
  const synergySummary =
    resolvedReasons.length > 0
      ? `${companyOrRole} appears to have a credible overlap with Dazbeez around practical AI, automation, and reliable operational delivery.`
      : `The fit is still plausible, but the available evidence is thin enough that the outreach should stay light and relationship-oriented.`;

  const suggestedOutreachAngle =
    resolvedReasons.length > 0
      ? "Lead with a concrete observation about their workflow or operating context, then offer a short practical follow-up rather than a broad capability pitch."
      : "Keep the note warm and specific to the event context, and position the connection as a useful ongoing relationship rather than an immediate project ask.";

  const recommendedCta =
    totalScore >= 70
      ? "Suggest a short follow-up conversation to compare notes on a practical workflow or transformation problem."
      : "Suggest staying in touch and invite a low-pressure follow-up if a relevant need comes up.";

  return {
    synergyScore: totalScore,
    synergySummary,
    suggestedOutreachAngle,
    recommendedCta,
    reasons: resolvedReasons,
    evidence,
  };
}

export function createEmailDraft(args: {
  contactName: string | null;
  companyName: string | null;
  profile: DazbeezProfileSettings;
  synergy: SynergyAnalysisPayload;
  batchContext: SynergyInput["batchContext"];
}): EmailDraftPayload {
  const firstName = args.contactName?.split(/\s+/).filter(Boolean)[0] ?? "there";
  const company = args.companyName ? ` at ${args.companyName}` : "";
  const companyWebsite = args.profile.my_company_website?.trim() || "";
  const personalWebsite = args.profile.my_personal_website?.trim() || "";
  const linkedIn = args.profile.my_linkedin?.trim() || "";
  const discordInvite = args.profile.my_discord_invite?.trim() || "";
  const hasAllRequiredLinks = [companyWebsite, personalWebsite, linkedIn, discordInvite].every(Boolean);
  const eventLine =
    args.batchContext.eventName || args.batchContext.eventLocation
      ? `It was good meeting you${company}${args.batchContext.eventName ? ` at ${args.batchContext.eventName}` : ""}${args.batchContext.eventLocation ? ` in ${args.batchContext.eventLocation}` : ""}.`
      : `It was good connecting${company}.`;

  const fitReason = args.synergy.reasons[0]?.detail ??
    "The overlap seems to be in practical, maintainable AI and workflow improvement rather than hype-heavy experimentation.";

  const softCta =
    args.synergy.synergyScore >= 70
      ? "If useful, I'd be glad to compare notes on where a small, grounded automation or AI step could create leverage."
      : "If it ever helps, I'd be happy to stay in touch and compare notes on practical AI or workflow improvement.";

  const linkLines = [
    companyWebsite ? `Dazbeez: ${companyWebsite}` : null,
    // Links are omitted rather than rendered as placeholders.
    personalWebsite ? `Personal site: ${personalWebsite}` : null,
    linkedIn ? `LinkedIn: ${linkedIn}` : null,
    discordInvite ? `Discord: ${discordInvite}` : null,
  ].filter((line): line is string => Boolean(line));

  const body = [
    `Hi ${firstName},`,
    "",
    eventLine,
    "",
    fitReason,
    "",
    `I run ${args.profile.my_company}, where I focus on AI, automation, and data systems that stay auditable, testable, and maintainable in real operating conditions.`,
    softCta,
    "",
    ...linkLines,
    "",
    "Best,",
    args.profile.my_name,
  ].join("\n");

  return {
    subjectLine: args.companyName
      ? `Good meeting you${company}`
      : "Good meeting you",
    plainTextBody: body,
    htmlBody: null,
    rationaleSummary: `${args.synergy.synergyScore >= 70 ? "High-fit" : "Low-pressure"} follow-up grounded in event context and the strongest documented fit signal.`,
    status:
      hasAllRequiredLinks && args.contactName && args.synergy.reasons.length > 0
        ? "ready"
        : "needs_review",
  };
}
