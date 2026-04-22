export type ContactSource =
  | "google"
  | "linkedin"
  | "manual"
  | "google_oauth"
  | "linkedin_oauth"
  | "nfc_card"
  | "qr_card"
  | "manual_form"
  | "paper_card_batch_upload"
  | "admin_manual_entry";

export type ContactStatus =
  | "ingested"
  | "needs_review"
  | "approved"
  | "enriched"
  | "draft_ready"
  | "merged"
  | "archived"
  | "error";

export type BatchStatus =
  | "uploaded"
  | "detecting"
  | "processing"
  | "needs_review"
  | "approved"
  | "completed"
  | "error"
  | "archived";

export type BatchCardStatus =
  | "detected"
  | "extracted"
  | "needs_review"
  | "approved"
  | "invalid"
  | "upserted"
  | "error";

export type DraftStatus = "needs_review" | "ready" | "approved" | "archived";
export type ReviewTaskStatus = "open" | "resolved" | "dismissed";
export type ReviewPriority = "low" | "medium" | "high";

export interface DazbeezProfileSettings {
  my_name: string;
  my_title: string;
  my_company: string;
  my_company_summary: string;
  my_personal_summary: string;
  my_services: string[];
  my_target_industries: string[];
  my_value_props: string[];
  my_case_studies: Array<{
    name: string;
    summary: string;
    tags: string[];
  }>;
  my_company_website: string;
  my_personal_website: string;
  my_linkedin: string;
  my_discord_invite: string;
  preferred_email_tone: string;
  default_call_to_action: string;
}

export interface CrmThresholdSettings {
  ocr_review_threshold: number;
  dedupe_review_threshold: number;
  draft_review_threshold: number;
  detection_min_cards: number;
}

export interface CrmIntegrationSettings {
  vision_provider: string;
  text_provider: string;
  search_provider: string;
  discord_notifications_enabled: boolean;
  provider_secret_strategy: string;
}

export interface BatchCardFieldConfidence {
  [field: string]: number | undefined;
}

export interface CardPoint {
  x: number;
  y: number;
}

export interface CardPolygon {
  topLeft: CardPoint;
  topRight: CardPoint;
  bottomRight: CardPoint;
  bottomLeft: CardPoint;
}

export interface CardDetectionCandidate {
  label: string;
  confidence: number;
  polygon: CardPolygon;
  rotationDegrees?: number;
}

export interface ExtractedContactFields {
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name_native: string | null;
  job_title: string | null;
  department: string | null;
  company_name: string | null;
  company_name_native: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  website: string | null;
  linkedin_url: string | null;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  state_prefecture: string | null;
  country: string | null;
  notes_from_card: string | null;
  raw_ocr_text: string;
  pronouns?: string | null;
  furigana?: string | null;
  emails?: string[];
  phone_numbers?: string[];
}

export interface ExtractedCardPayload {
  fields: ExtractedContactFields;
  confidence: BatchCardFieldConfidence;
  languageHint: string | null;
}

export interface DuplicateCandidate {
  contactId: number;
  companyId: number | null;
  confidence: number;
  reasons: string[];
}

export interface EnrichmentFactInput {
  factType: string;
  label: string;
  value: string;
  normalizedValue?: string | null;
  sourceUrl: string;
  sourceTitle?: string | null;
  sourceSnippet?: string | null;
  evidenceStrength: "low" | "medium" | "high";
  retrievedAt: string;
}

export interface SynergyReason {
  title: string;
  detail: string;
  evidenceRefs: string[];
  scoreContribution: number;
}

export interface SynergyAnalysisPayload {
  synergyScore: number;
  synergySummary: string;
  suggestedOutreachAngle: string;
  recommendedCta: string;
  reasons: SynergyReason[];
  evidence: Array<{
    id: string;
    label: string;
    source: string;
  }>;
}

export interface EmailDraftPayload {
  subjectLine: string;
  plainTextBody: string;
  htmlBody: string | null;
  rationaleSummary: string;
  status: DraftStatus;
}

export interface ContactListItem {
  id: number;
  name: string;
  email: string | null;
  company: string | null;
  companyId: number | null;
  source: ContactSource;
  status: ContactStatus;
  synergyScore: number | null;
  draftStatus: DraftStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyListItem {
  id: number;
  name: string;
  website: string | null;
  websiteDomain: string | null;
  industry: string | null;
  status: ContactStatus;
  contactCount: number;
  updatedAt: string;
}
