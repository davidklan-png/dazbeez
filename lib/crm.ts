import { getCrmDb, getCrmImagesBucket } from "@/lib/cloudflare-runtime";
import { buildDuplicateCandidates, type DedupeComparableContact } from "@/lib/crm-dedupe";
import { enrichFromOfficialWebsite } from "@/lib/crm-enrichment";
import { parseJsonValue, stringifyJson } from "@/lib/crm-json";
import {
  inferDomainFromEmail,
  inferDomainFromUrl,
  normalizeEmail,
  normalizeExtractedFields,
  normalizeLinkedInUrl,
  normalizePhone,
  normalizeUrl,
} from "@/lib/crm-normalization";
import { analyzeSynergy, createEmailDraft } from "@/lib/crm-synergy";
import type {
  BatchCardFieldConfidence,
  BatchCardStatus,
  BatchImageRole,
  CardDetectionCandidate,
  ContactStatus,
  CrmIntegrationSettings,
  CrmThresholdSettings,
  DazbeezProfileSettings,
  DuplicateCandidate,
  EmailDraftPayload,
  EnrichmentFactInput,
  ExtractedCardPayload,
  ExtractedContactFields,
  ReviewPriority,
} from "@/lib/crm-types";
import {
  listBatches,
  getDashboardSummary,
  getBatchDetail,
  listContacts,
  listCompanies,
  listReviewTasks,
  listDrafts,
  getContactDetail,
} from "@/lib/crm-reads";

export {
  listBatches,
  getDashboardSummary,
  getBatchDetail,
  listContacts,
  listCompanies,
  listReviewTasks,
  listDrafts,
  getContactDetail,
};
export type {
  DashboardSummary,
  BatchListItem,
  BatchDetail,
  ContactDetail,
  ReviewTaskItem,
  DraftListItem,
} from "@/lib/crm-reads";

const DEFAULT_THRESHOLDS: CrmThresholdSettings = {
  ocr_review_threshold: 0.72,
  dedupe_review_threshold: 0.75,
  draft_review_threshold: 0.7,
  detection_min_cards: 6,
};

const DEFAULT_INTEGRATIONS: CrmIntegrationSettings = {
  vision_provider: "cloudflare_ai",
  text_provider: "cloudflare_ai",
  search_provider: "website_fetch",
  discord_notifications_enabled: false,
  provider_secret_strategy: "environment_variables",
};

const DEFAULT_PROFILE: DazbeezProfileSettings = {
  my_name: "David Klan",
  my_title: "AI, Automation & Data Consultant / IT PM + AI/ML Engineer",
  my_company: "Dazbeez G.K.",
  my_company_summary:
    "Dazbeez builds AI, automation, and data systems designed to stay correct, auditable, testable, and maintainable over time, especially where Japanese regulatory, bilingual, or operational constraints are real.",
  my_personal_summary:
    "David Klan is a curiosity-driven builder who uses AI to help experts do meaningful work. He brings 15+ years spanning software engineering, consulting, enterprise transformation, document-heavy workflows, and cross-cultural work across Japan and the US.",
  my_services: [
    "AI integration",
    "workflow automation",
    "data management",
    "governance",
    "project management",
    "LLM applications",
    "RAG systems",
    "document OCR workflows",
    "change enablement",
  ],
  my_target_industries: [
    "insurance",
    "finance",
    "professional services",
    "education",
    "logistics",
    "Japan-regulated businesses",
    "document-heavy operations",
    "Hawaii-based businesses",
  ],
  my_value_props: [
    "Builds systems that survive real constraints instead of demo-only prototypes",
    "Creates auditable and explainable AI with source grounding and review paths",
    "Automates repetitive work while preserving human judgment",
    "Designs maintainable hand-offs for small teams",
    "Works well in bilingual and cross-cultural business contexts",
    "Can connect technical delivery, governance, and change enablement",
  ],
  my_case_studies: [],
  my_company_website: "https://dazbeez.com",
  my_personal_website: "https://kinokoholic.com",
  my_linkedin: "https://www.linkedin.com/in/david-klan",
  my_discord_invite: "",
  preferred_email_tone: "warm, intelligent, concise, practical, non-hype, non-spam, specific, human",
  default_call_to_action:
    "Invite a practical follow-up conversation, partnership discussion, or simple ongoing connection depending on fit.",
};

export interface StoredFileInput {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  width?: number | null;
  height?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface BatchUploadInput {
  actor: string;
  compositeImage: StoredFileInput;
  detections: CardDetectionCandidate[];
  crops: Array<{
    label: string;
    detection: CardDetectionCandidate;
    image: StoredFileInput;
    extracted: ExtractedCardPayload;
  }>;
  eventName?: string | null;
  eventDate?: string | null;
  eventLocation?: string | null;
  notesAboutConversations?: string | null;
  campaignTag?: string | null;
  expectedCardCount?: number | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function getSettingValue<T>(key: string, fallback: T): Promise<T> {
  const db = getCrmDb();
  const row = await db
    .prepare("SELECT value_json FROM admin_settings WHERE key = ?")
    .bind(key)
    .first<{ value_json: string }>();

  return parseJsonValue(row?.value_json, fallback);
}

export async function getDazbeezProfile(): Promise<DazbeezProfileSettings> {
  return getSettingValue("dazbeez_profile", DEFAULT_PROFILE);
}

export async function getCrmThresholds(): Promise<CrmThresholdSettings> {
  return getSettingValue("crm_thresholds", DEFAULT_THRESHOLDS);
}

export async function getCrmIntegrations(): Promise<CrmIntegrationSettings> {
  return getSettingValue("crm_integrations", DEFAULT_INTEGRATIONS);
}

export async function updateSetting(args: {
  actor: string;
  key: string;
  value: unknown;
}): Promise<void> {
  const db = getCrmDb();
  const before = await db
    .prepare("SELECT value_json FROM admin_settings WHERE key = ?")
    .bind(args.key)
    .first<{ value_json: string }>();

  await db
    .prepare(
      `INSERT INTO admin_settings (key, value_json, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .bind(args.key, stringifyJson(args.value), args.actor, nowIso())
    .run();

  await logAudit({
    actor: args.actor,
    action: "settings.updated",
    entityType: "admin_settings",
    beforeJson: before?.value_json ?? null,
    afterJson: stringifyJson(args.value),
  });
}

export async function logAudit(args: {
  actor: string;
  action: string;
  entityType: string;
  entityId?: number | null;
  batchId?: number | null;
  beforeJson?: string | null;
  afterJson?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  const db = getCrmDb();
  await db
    .prepare(
      `INSERT INTO audit_logs (actor, action, entity_type, entity_id, batch_id, before_json, after_json, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.actor,
      args.action,
      args.entityType,
      args.entityId ?? null,
      args.batchId ?? null,
      args.beforeJson ?? null,
      args.afterJson ?? null,
      args.metadata ? stringifyJson(args.metadata) : null,
    )
    .run();
}

async function insertImage(args: {
  batchId?: number | null;
  batchCardId?: number | null;
  role: BatchImageRole;
  file: StoredFileInput;
  storageKey: string;
}): Promise<number> {
  const db = getCrmDb();
  const bucket = getCrmImagesBucket();
  const metadataJson = args.file.metadata ? stringifyJson(args.file.metadata) : null;
  let blobData: Uint8Array = args.file.bytes;

  if (bucket) {
    await bucket.put(args.storageKey, args.file.bytes, {
      httpMetadata: {
        contentType: args.file.mimeType,
      },
    });
    blobData = new Uint8Array();
  }

  const result = await db
    .prepare(
      `INSERT INTO business_card_images_v2
        (batch_id, batch_card_id, image_role, storage_key, mime_type, width, height, byte_size, blob_data, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.batchId ?? null,
      args.batchCardId ?? null,
      args.role,
      args.storageKey,
      args.file.mimeType,
      args.file.width ?? null,
      args.file.height ?? null,
      args.file.bytes.byteLength,
      blobData,
      metadataJson,
    )
    .run();

  const imageId = Number(result.meta.last_row_id ?? 0);

  if (bucket) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO business_card_image_objects_v2 (image_id, r2_object_key, created_at)
         VALUES (?, ?, ?)`,
      )
      .bind(imageId, args.storageKey, nowIso())
      .run();
  }

  return imageId;
}

function mapDedupeContactRow(row: {
  id: number;
  company_id: number | null;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  linkedin_url: string | null;
  website: string | null;
}): DedupeComparableContact {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    company: row.company,
    email: row.email,
    phone: row.phone,
    mobile: row.mobile,
    linkedinUrl: row.linkedin_url,
    website: row.website,
  };
}

async function queryDedupeContactsByKeys(
  fields: ExtractedContactFields,
): Promise<DedupeComparableContact[]> {
  const db = getCrmDb();
  const normalizedEmail = normalizeEmail(fields.email);
  const normalizedLinkedIn = normalizeLinkedInUrl(fields.linkedin_url);
  const normalizedName = fields.full_name?.trim().toLowerCase() ?? null;
  const normalizedCompany = fields.company_name?.trim().toLowerCase() ?? null;
  const normalizedPhone = normalizePhone(fields.phone);
  const normalizedMobile = normalizePhone(fields.mobile);
  const results: DedupeComparableContact[] = [];
  const seen = new Set<number>();

  const runQuery = async (statement: D1PreparedStatement) => {
    const queryResult = await statement.all<{
      id: number;
      company_id: number | null;
      name: string | null;
      company: string | null;
      email: string | null;
      phone: string | null;
      mobile: string | null;
      linkedin_url: string | null;
      website: string | null;
    }>();

    for (const row of queryResult.results ?? []) {
      if (seen.has(row.id)) {
        continue;
      }

      seen.add(row.id);
      results.push(mapDedupeContactRow(row));
    }
  };

  if (normalizedEmail) {
    await runQuery(
      db
        .prepare(
          `SELECT id, company_id, name, company, email, phone, mobile, linkedin_url, website
           FROM contacts
           WHERE status != 'merged'
             AND email_lower = ?
           ORDER BY updated_at DESC, id DESC
           LIMIT 5`,
        )
        .bind(normalizedEmail),
    );
  }

  if (normalizedLinkedIn) {
    await runQuery(
      db
        .prepare(
          `SELECT id, company_id, name, company, email, phone, mobile, linkedin_url, website
           FROM contacts
           WHERE status != 'merged'
             AND linkedin_url = ?
           ORDER BY updated_at DESC, id DESC
           LIMIT 5`,
        )
        .bind(normalizedLinkedIn),
    );
  }

  if (normalizedName && normalizedCompany) {
    await runQuery(
      db
        .prepare(
          `SELECT id, company_id, name, company, email, phone, mobile, linkedin_url, website
           FROM contacts
           WHERE status != 'merged'
             AND lower(name) = ?
             AND lower(company) = ?
           ORDER BY updated_at DESC, id DESC
           LIMIT 5`,
        )
        .bind(normalizedName, normalizedCompany),
    );
  }

  if (normalizedPhone || normalizedMobile) {
    const phoneCandidate = normalizedPhone ?? normalizedMobile;
    const mobileCandidate = normalizedMobile ?? normalizedPhone;
    await runQuery(
      db
        .prepare(
          `SELECT id, company_id, name, company, email, phone, mobile, linkedin_url, website
           FROM contacts
           WHERE status != 'merged'
             AND email_lower IS NULL
             AND (
               phone = ?
               OR mobile = ?
               OR phone = ?
               OR mobile = ?
             )
           ORDER BY updated_at DESC, id DESC
           LIMIT 5`,
        )
        .bind(phoneCandidate, phoneCandidate, mobileCandidate, mobileCandidate),
    );
  }

  return results.slice(0, 20);
}

function getLastConfidenceScore(confidence: BatchCardFieldConfidence): number {
  const fieldValues = Object.values(confidence).filter((value): value is number => typeof value === "number");
  if (fieldValues.length === 0) {
    return 0;
  }

  return fieldValues.reduce((min, value) => Math.min(min, value), 1);
}

export function assessBatchCardReviewState(args: {
  normalized: ExtractedContactFields;
  confidence: BatchCardFieldConfidence;
  duplicateCandidates: DuplicateCandidate[];
  thresholds: CrmThresholdSettings;
}): { needsReview: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const fieldValues = Object.values(args.confidence).filter((value): value is number => typeof value === "number");
  if (fieldValues.length === 0) {
    reasons.push("No field confidence values available");
  }

  if (fieldValues.some((value) => value < args.thresholds.ocr_review_threshold)) {
    reasons.push("Low OCR confidence on one or more fields");
  }

  if (!args.normalized.email && !args.normalized.linkedin_url && !args.normalized.phone && !args.normalized.mobile) {
    reasons.push("No strong identity field detected");
  }

  if (
    args.duplicateCandidates.length > 0 &&
    args.duplicateCandidates[0].confidence >= args.thresholds.dedupe_review_threshold
  ) {
    reasons.push("Duplicate candidate requires explicit resolution");
  }

  return { needsReview: reasons.length > 0, reasons };
}

async function createReviewTask(args: {
  entityType: string;
  entityId: number;
  batchId?: number | null;
  contactId?: number | null;
  companyId?: number | null;
  taskType: string;
  priority: ReviewPriority;
  title: string;
  detail: Record<string, unknown>;
}): Promise<void> {
  const db = getCrmDb();
  await db
    .prepare(
      `INSERT INTO review_tasks
        (entity_type, entity_id, batch_id, contact_id, company_id, task_type, priority, title, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.entityType,
      args.entityId,
      args.batchId ?? null,
      args.contactId ?? null,
      args.companyId ?? null,
      args.taskType,
      args.priority,
      args.title,
      stringifyJson(args.detail),
    )
    .run();
}

async function refreshBatchReviewCounts(batchId: number): Promise<void> {
  const db = getCrmDb();
  const counts = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN needs_review = 1 OR status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review_count,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count
       FROM batch_cards
       WHERE batch_id = ?`,
    )
    .bind(batchId)
    .first<{
      needs_review_count: number | null;
      error_count: number | null;
    }>();

  const needsReviewCount = Number(counts?.needs_review_count ?? 0);
  const errorCount = Number(counts?.error_count ?? 0);
  const status = needsReviewCount > 0 ? "needs_review" : "approved";

  await db
    .prepare(
      `UPDATE contact_batches
       SET needs_review_count = ?, error_count = ?, status = CASE WHEN status = 'completed' THEN status ELSE ? END, updated_at = ?
       WHERE id = ?`,
    )
    .bind(needsReviewCount, errorCount, status, nowIso(), batchId)
    .run();
}

export interface InsertBatchCardInput {
  batchId: number;
  sortOrder: number;
  actor: string;
  label: string;
  detection: CardDetectionCandidate;
  image: StoredFileInput;
  extracted: ExtractedCardPayload;
  croppedStorageKey: string;
  createdAt: string;
}

export interface InsertBatchCardResult {
  batchCardId: number;
  needsReview: boolean;
  duplicateCandidates: DuplicateCandidate[];
}

// Per-card insertion shared by the admin composite path and the mobile
// event/batch capture path. Extracts the body of the for loop in
// createBusinessCardBatch so audit / review-task / dedupe logic does not
// diverge between the two callers.
export async function insertBatchCard(
  input: InsertBatchCardInput,
  thresholds: CrmThresholdSettings,
): Promise<InsertBatchCardResult> {
  const db = getCrmDb();
  const normalized = normalizeExtractedFields(input.extracted.fields);
  const duplicateCandidates = buildDuplicateCandidates(
    normalized,
    await queryDedupeContactsByKeys(normalized),
  );
  const review = assessBatchCardReviewState({
    normalized,
    confidence: input.extracted.confidence,
    duplicateCandidates,
    thresholds,
  });

  const batchCardResult = await db
    .prepare(
      `INSERT INTO batch_cards
        (batch_id, sort_order, status, detection_label, detection_confidence, detection_box_json, transform_json, extraction_provider, raw_ocr_text, extracted_json, normalized_json, confidence_json, duplicate_candidates_json, needs_review, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.batchId,
      input.sortOrder,
      review.needsReview ? "needs_review" : "extracted",
      input.label,
      input.detection.confidence,
      stringifyJson(input.detection.polygon),
      stringifyJson({ rotationDegrees: input.detection.rotationDegrees ?? 0 }),
      "cloudflare_ai",
      normalized.raw_ocr_text,
      stringifyJson(input.extracted.fields),
      stringifyJson(normalized),
      stringifyJson(input.extracted.confidence),
      stringifyJson(duplicateCandidates),
      review.needsReview ? 1 : 0,
      review.reasons.join("; ") || null,
      input.createdAt,
      input.createdAt,
    )
    .run();

  const batchCardId = Number(batchCardResult.meta.last_row_id ?? 0);

  await insertImage({
    batchId: input.batchId,
    batchCardId,
    role: "cropped_card",
    storageKey: input.croppedStorageKey,
    file: input.image,
  });

  if (review.needsReview) {
    await createReviewTask({
      entityType: "batch_card",
      entityId: batchCardId,
      batchId: input.batchId,
      taskType: duplicateCandidates.length > 0 ? "dedupe_review" : "ocr_review",
      priority: duplicateCandidates.length > 0 ? "high" : "medium",
      title:
        duplicateCandidates.length > 0
          ? `Resolve duplicate candidate for ${normalized.full_name ?? `card ${input.sortOrder + 1}`}`
          : `Review low-confidence extraction for card ${input.sortOrder + 1}`,
      detail: {
        duplicateCandidates,
        confidence: input.extracted.confidence,
        normalized,
        reasons: review.reasons,
      },
    });
  }

  await logAudit({
    actor: input.actor,
    action: "batch_card.created",
    entityType: "batch_card",
    entityId: batchCardId,
    batchId: input.batchId,
    afterJson: stringifyJson({
      normalized,
      confidence: input.extracted.confidence,
      duplicateCandidates,
    }),
  });

  return {
    batchCardId,
    needsReview: review.needsReview,
    duplicateCandidates,
  };
}

export async function createBusinessCardBatch(input: BatchUploadInput): Promise<number> {
  const db = getCrmDb();
  const thresholds = await getCrmThresholds();
  const createdAt = nowIso();

  const batchResult = await db
    .prepare(
      `INSERT INTO contact_batches
        (status, event_name, event_date, event_location, notes_about_conversations, campaign_tag, source_filename, source_mime_type, expected_card_count, detected_card_count, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "processing",
      input.eventName ?? null,
      input.eventDate ?? null,
      input.eventLocation ?? null,
      input.notesAboutConversations ?? null,
      input.campaignTag ?? null,
      input.compositeImage.fileName,
      input.compositeImage.mimeType,
      input.expectedCardCount ?? null,
      input.detections.length,
      input.actor,
      input.actor,
      createdAt,
      createdAt,
    )
    .run();

  const batchId = Number(batchResult.meta.last_row_id ?? 0);
  await insertImage({
    batchId,
    role: "batch_original",
    storageKey: `batch/${batchId}/original/${input.compositeImage.fileName}`,
    file: input.compositeImage,
  });

  let needsReviewCount = 0;
  let errorCount = 0;

  for (let index = 0; index < input.crops.length; index += 1) {
    const crop = input.crops[index];
    const result = await insertBatchCard(
      {
        batchId,
        sortOrder: index,
        actor: input.actor,
        label: crop.label,
        detection: crop.detection,
        image: crop.image,
        extracted: crop.extracted,
        croppedStorageKey: `batch/${batchId}/card/${String(index + 1).padStart(2, "0")}.png`,
        createdAt,
      },
      thresholds,
    );
    if (result.needsReview) needsReviewCount += 1;
  }

  if (input.crops.length === 0) {
    errorCount += 1;
    await createReviewTask({
      entityType: "contact_batch",
      entityId: batchId,
      batchId,
      taskType: "detection_failure",
      priority: "high",
      title: "No business cards were detected from the upload",
      detail: {
        expectedCardCount: input.expectedCardCount ?? 9,
        detectedCardCount: 0,
      },
    });
  }

  const batchStatus = needsReviewCount > 0 || input.detections.length < thresholds.detection_min_cards
    ? "needs_review"
    : "approved";

  await db
    .prepare(
      `UPDATE contact_batches
       SET status = ?, needs_review_count = ?, error_count = ?, processing_diagnostics_json = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      batchStatus,
      needsReviewCount,
      errorCount,
      stringifyJson({
        detectionCount: input.detections.length,
        cropCount: input.crops.length,
        expectedCardCount: input.expectedCardCount ?? null,
      }),
      nowIso(),
      batchId,
    )
    .run();

  await logAudit({
    actor: input.actor,
    action: "contact_batch.created",
    entityType: "contact_batch",
    entityId: batchId,
    batchId,
    afterJson: stringifyJson({
      eventName: input.eventName ?? null,
      detectedCardCount: input.detections.length,
      cropCount: input.crops.length,
    }),
  });

  return batchId;
}

// ─── Mobile capture ──────────────────────────────────────────────────────────

export interface MobileBusinessCardCaptureInput {
  actor: string;
  deviceId: string;
  clientCaptureId: string;
  capturedAtClient: string | null;
  appVersion: string | null;
  note: string | null;
  // When provided, append to an existing batch. Otherwise create a new batch
  // using `eventName`.
  batchId: number | null;
  eventName: string | null;
  image: StoredFileInput;
  extracted: ExtractedCardPayload;
}

export interface MobileBusinessCardCaptureResult {
  batchId: number;
  batchCardId: number;
  businessCardImageId: number;
  duplicate: boolean;
}

// Idempotency: every mobile-captured card image carries (device_id,
// client_capture_id). A unique index in 0012_mobile_capture.sql enforces
// at-most-once insertion. On retry we return the existing card.
async function findMobileBusinessCardImage(
  deviceId: string,
  clientCaptureId: string,
): Promise<{ id: number; batch_card_id: number | null; batch_id: number | null } | null> {
  const db = getCrmDb();
  return db
    .prepare(
      `SELECT id, batch_card_id, batch_id
       FROM business_card_images_v2
       WHERE device_id = ? AND client_capture_id = ?
       LIMIT 1`,
    )
    .bind(deviceId, clientCaptureId)
    .first<{ id: number; batch_card_id: number | null; batch_id: number | null }>();
}

async function findOrCreateMobileBatch(
  input: MobileBusinessCardCaptureInput,
): Promise<number> {
  const db = getCrmDb();
  if (input.batchId) {
    const row = await db
      .prepare(`SELECT id FROM contact_batches WHERE id = ? LIMIT 1`)
      .bind(input.batchId)
      .first<{ id: number }>();
    if (!row) {
      throw new Error(`Batch ${input.batchId} not found.`);
    }
    return row.id;
  }

  const createdAt = nowIso();
  const insert = await db
    .prepare(
      `INSERT INTO contact_batches
        (status, event_name, source_filename, source_mime_type,
         detected_card_count, created_by, updated_by, created_at, updated_at)
       VALUES ('processing', ?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .bind(
      input.eventName,
      `mobile-capture/${input.deviceId.slice(0, 8)}`,
      input.image.mimeType,
      input.actor,
      input.actor,
      createdAt,
      createdAt,
    )
    .run();
  return Number(insert.meta.last_row_id ?? 0);
}

async function nextBatchSortOrder(batchId: number): Promise<number> {
  const db = getCrmDb();
  const row = await db
    .prepare(`SELECT MAX(sort_order) AS max_sort FROM batch_cards WHERE batch_id = ?`)
    .bind(batchId)
    .first<{ max_sort: number | null }>();
  return Number(row?.max_sort ?? -1) + 1;
}

export async function createMobileBusinessCardCapture(
  input: MobileBusinessCardCaptureInput,
): Promise<MobileBusinessCardCaptureResult> {
  const db = getCrmDb();

  const existing = await findMobileBusinessCardImage(
    input.deviceId,
    input.clientCaptureId,
  );
  if (existing) {
    return {
      batchId: existing.batch_id ?? 0,
      batchCardId: existing.batch_card_id ?? 0,
      businessCardImageId: existing.id,
      duplicate: true,
    };
  }

  if (!input.batchId && !input.eventName) {
    throw new Error("event_name is required when no batch_id is provided.");
  }

  const thresholds = await getCrmThresholds();
  const createdAt = nowIso();
  const batchId = await findOrCreateMobileBatch(input);
  const sortOrder = await nextBatchSortOrder(batchId);

  const detection: CardDetectionCandidate = {
    label: `mobile-${sortOrder + 1}`,
    confidence: 1,
    polygon: {
      topLeft: { x: 0, y: 0 },
      topRight: { x: input.image.width ?? 0, y: 0 },
      bottomRight: { x: input.image.width ?? 0, y: input.image.height ?? 0 },
      bottomLeft: { x: 0, y: input.image.height ?? 0 },
    },
    rotationDegrees: 0,
  };

  // Insert the card. The idempotency unique index is on
  // business_card_images_v2(device_id, client_capture_id), so we tag the
  // image row with those identifiers after insertBatchCard creates it.
  const result = await insertBatchCard(
    {
      batchId,
      sortOrder,
      actor: input.actor,
      label: detection.label,
      detection,
      image: {
        ...input.image,
        metadata: {
          ...(input.image.metadata ?? {}),
          uploadedVia: "mobile",
          deviceId: input.deviceId,
          clientCaptureId: input.clientCaptureId,
          capturedAtClient: input.capturedAtClient,
          appVersion: input.appVersion,
          note: input.note,
        },
      },
      extracted: input.extracted,
      croppedStorageKey: `batch/${batchId}/mobile/${input.clientCaptureId}.jpg`,
      createdAt,
    },
    thresholds,
  );

  // Tag the image row with mobile metadata so the unique index protects
  // future retries. If a concurrent retry already tagged a row with this
  // (device_id, client_capture_id), the UPDATE hits the unique index and
  // throws; surface that as a duplicate of the prior successful insert.
  try {
    const tagResult = await db
      .prepare(
        `UPDATE business_card_images_v2
           SET device_id = ?, client_capture_id = ?, captured_at_client = ?,
               upload_origin = 'mobile', source_app_version = ?
         WHERE batch_card_id = ? AND image_role = 'cropped_card'`,
      )
      .bind(
        input.deviceId,
        input.clientCaptureId,
        input.capturedAtClient,
        input.appVersion,
        result.batchCardId,
      )
      .run();
    const tagChanges = Number(tagResult.meta?.changes ?? 0);
    if (tagChanges === 0) {
      throw new Error("Mobile metadata tag failed: no image row updated.");
    }
  } catch (err) {
    const existingAfter = await findMobileBusinessCardImage(
      input.deviceId,
      input.clientCaptureId,
    );
    if (existingAfter) {
      return {
        batchId: existingAfter.batch_id ?? batchId,
        batchCardId: existingAfter.batch_card_id ?? result.batchCardId,
        businessCardImageId: existingAfter.id,
        duplicate: true,
      };
    }
    throw err;
  }

  const imageRow = await db
    .prepare(
      `SELECT id FROM business_card_images_v2
       WHERE batch_card_id = ? AND image_role = 'cropped_card' LIMIT 1`,
    )
    .bind(result.batchCardId)
    .first<{ id: number }>();

  await db
    .prepare(
      `UPDATE contact_batches
         SET detected_card_count = (
               SELECT COUNT(*) FROM batch_cards WHERE batch_id = ?
             ),
             updated_at = ?
       WHERE id = ?`,
    )
    .bind(batchId, nowIso(), batchId)
    .run();

  await refreshBatchReviewCounts(batchId);

  await logAudit({
    actor: input.actor,
    action: "contact_batch.created",
    entityType: "contact_batch",
    entityId: batchId,
    batchId,
    afterJson: stringifyJson({
      uploadedVia: "mobile",
      deviceId: input.deviceId,
      clientCaptureId: input.clientCaptureId,
      eventName: input.eventName,
      appVersion: input.appVersion,
    }),
  });

  return {
    batchId,
    batchCardId: result.batchCardId,
    businessCardImageId: Number(imageRow?.id ?? 0),
    duplicate: false,
  };
}

async function findCompanyCandidate(args: {
  companyName: string | null;
  website: string | null;
}): Promise<{ id: number; name: string } | null> {
  const db = getCrmDb();
  const domain = inferDomainFromUrl(args.website);

  if (domain) {
    const byDomain = await db
      .prepare("SELECT id, name FROM companies WHERE website_domain = ? LIMIT 1")
      .bind(domain)
      .first<{ id: number; name: string }>();
    if (byDomain) {
      return byDomain;
    }
  }

  if (args.companyName?.trim()) {
    return db
      .prepare("SELECT id, name FROM companies WHERE lower(name) = lower(?) LIMIT 1")
      .bind(args.companyName.trim())
      .first<{ id: number; name: string }>();
  }

  return null;
}

async function upsertCompany(args: {
  actor: string;
  companyName: string | null;
  companyNameNative: string | null;
  website: string | null;
  industry: string | null;
  description: string | null;
  contactStatus: ContactStatus;
}): Promise<number | null> {
  if (!args.companyName && !args.website) {
    return null;
  }

  const db = getCrmDb();
  const candidate = await findCompanyCandidate({
    companyName: args.companyName,
    website: args.website,
  });
  const domain = inferDomainFromUrl(args.website);
  const timestamp = nowIso();

  if (candidate) {
    await db
      .prepare(
        `UPDATE companies
         SET name = COALESCE(?, name),
             name_native = COALESCE(?, name_native),
             website = COALESCE(?, website),
             website_domain = COALESCE(?, website_domain),
             industry = COALESCE(?, industry),
             description = COALESCE(?, description),
             status = CASE
               WHEN status = 'archived' THEN status
               ELSE ?
             END,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        args.companyName ?? null,
        args.companyNameNative ?? null,
        normalizeUrl(args.website) ?? null,
        domain,
        args.industry ?? null,
        args.description ?? null,
        args.contactStatus,
        timestamp,
        candidate.id,
      )
      .run();
    return candidate.id;
  }

  const result = await db
    .prepare(
      `INSERT INTO companies
        (name, name_native, website, website_domain, industry, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.companyName ?? domain ?? "Unknown company",
      args.companyNameNative ?? null,
      normalizeUrl(args.website) ?? null,
      domain,
      args.industry ?? null,
      args.description ?? null,
      args.contactStatus,
      timestamp,
      timestamp,
    )
    .run();

  const companyId = Number(result.meta.last_row_id ?? 0);
  await logAudit({
    actor: args.actor,
    action: "company.created",
    entityType: "company",
    entityId: companyId,
    afterJson: stringifyJson({
      name: args.companyName,
      website: args.website,
    }),
  });
  return companyId;
}

async function findExistingContactForUpsert(args: {
  email: string | null;
  linkedinUrl: string | null;
  sourceContactId: number | null;
  fullName: string | null;
  companyName: string | null;
}): Promise<number | null> {
  const db = getCrmDb();
  if (args.sourceContactId) {
    return args.sourceContactId;
  }

  const normalizedEmail = normalizeEmail(args.email);
  if (normalizedEmail) {
    const byEmail = await db
      .prepare("SELECT id FROM contacts WHERE email_lower = ? LIMIT 1")
      .bind(normalizedEmail)
      .first<{ id: number }>();
    if (byEmail) {
      return byEmail.id;
    }
  }

  const normalizedLinkedIn = normalizeLinkedInUrl(args.linkedinUrl);
  if (normalizedLinkedIn) {
    const byLinkedIn = await db
      .prepare("SELECT id FROM contacts WHERE linkedin_url = ? LIMIT 1")
      .bind(normalizedLinkedIn)
      .first<{ id: number }>();
    if (byLinkedIn) {
      return byLinkedIn.id;
    }
  }

  if (args.fullName?.trim() && args.companyName?.trim()) {
    const byNameCompany = await db
      .prepare("SELECT id FROM contacts WHERE lower(name) = lower(?) AND lower(company) = lower(?) LIMIT 1")
      .bind(args.fullName.trim(), args.companyName.trim())
      .first<{ id: number }>();
    if (byNameCompany) {
      return byNameCompany.id;
    }
  }

  return null;
}

async function persistEnrichmentFacts(args: {
  runId: number;
  contactId: number;
  companyId: number | null;
  facts: EnrichmentFactInput[];
}): Promise<void> {
  const db = getCrmDb();
  for (const fact of args.facts) {
    await db
      .prepare(
        `INSERT INTO enrichment_facts
          (run_id, contact_id, company_id, fact_type, label, value, normalized_value, source_url, source_title, source_snippet, evidence_strength, retrieved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        args.runId,
        args.contactId,
        args.companyId ?? null,
        fact.factType,
        fact.label,
        fact.value,
        fact.normalizedValue ?? null,
        fact.sourceUrl,
        fact.sourceTitle ?? null,
        fact.sourceSnippet ?? null,
        fact.evidenceStrength,
        fact.retrievedAt,
      )
      .run();
  }
}

async function createDraftRecord(args: {
  contactId: number;
  companyId: number | null;
  batchId: number;
  batchCardId: number;
  draft: EmailDraftPayload;
}): Promise<number> {
  const db = getCrmDb();
  const result = await db
    .prepare(
      `INSERT INTO email_drafts
        (contact_id, company_id, batch_id, batch_card_id, status, subject_line, plain_text_body, html_body, rationale_summary, generation_provider, generation_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.contactId,
      args.companyId ?? null,
      args.batchId,
      args.batchCardId,
      args.draft.status,
      args.draft.subjectLine,
      args.draft.plainTextBody,
      args.draft.htmlBody,
      args.draft.rationaleSummary,
      "template_engine",
      "v1",
      nowIso(),
      nowIso(),
    )
    .run();

  return Number(result.meta.last_row_id ?? 0);
}

async function upsertContactFromCard(args: {
  actor: string;
  batchId: number;
  batchCardId: number;
  sourceContactId: number | null;
  fields: ExtractedContactFields;
  confidence: BatchCardFieldConfidence;
  batchContext: {
    eventName: string | null;
    eventDate: string | null;
    eventLocation: string | null;
    notesAboutConversations: string | null;
  };
}): Promise<{ contactId: number; companyId: number | null; isNew: boolean }> {
  const db = getCrmDb();
  const normalized = normalizeExtractedFields(args.fields);
  const timestamp = nowIso();

  const companyId = await upsertCompany({
    actor: args.actor,
    companyName: normalized.company_name,
    companyNameNative: normalized.company_name_native ?? null,
    website: normalized.website,
    industry: null,
    description: null,
    contactStatus: "approved",
  });

  const existingId = await findExistingContactForUpsert({
    email: normalized.email,
    linkedinUrl: normalized.linkedin_url,
    sourceContactId: args.sourceContactId,
    fullName: normalized.full_name,
    companyName: normalized.company_name,
  });

  if (existingId) {
    await db
      .prepare(
        `UPDATE contacts
         SET token = COALESCE(token, ?),
             company_id = COALESCE(?, company_id),
             name = COALESCE(?, name),
             first_name = COALESCE(?, first_name),
             last_name = COALESCE(?, last_name),
             full_name_native = COALESCE(?, full_name_native),
             furigana = COALESCE(?, furigana),
             email = COALESCE(?, email),
             email_lower = COALESCE(?, email_lower),
             phone = COALESCE(?, phone),
             mobile = COALESCE(?, mobile),
             linkedin_url = COALESCE(?, linkedin_url),
             website = COALESCE(?, website),
             website_domain = COALESCE(?, website_domain),
             company = COALESCE(?, company),
             company_name_native = COALESCE(?, company_name_native),
             job_title = COALESCE(?, job_title),
             department = COALESCE(?, department),
             address = COALESCE(?, address),
             postal_code = COALESCE(?, postal_code),
             city = COALESCE(?, city),
             state_prefecture = COALESCE(?, state_prefecture),
             country = COALESCE(?, country),
             notes = COALESCE(?, notes),
             raw_ocr_text = COALESCE(?, raw_ocr_text),
             source = 'paper_card_batch_upload',
             status = 'approved',
             source_language = COALESCE(?, source_language),
             primary_batch_id = COALESCE(primary_batch_id, ?),
             last_confidence = ?,
             needs_review = 0,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        null,
        companyId,
        normalized.full_name ?? null,
        normalized.first_name ?? null,
        normalized.last_name ?? null,
        normalized.full_name_native ?? null,
        normalized.furigana ?? null,
        normalized.email ?? null,
        normalizeEmail(normalized.email),
        normalizePhone(normalized.phone),
        normalizePhone(normalized.mobile),
        normalizeLinkedInUrl(normalized.linkedin_url),
        normalizeUrl(normalized.website),
        inferDomainFromUrl(normalized.website) ?? inferDomainFromEmail(normalized.email),
        normalized.company_name ?? null,
        normalized.company_name_native ?? null,
        normalized.job_title ?? null,
        normalized.department ?? null,
        normalized.address ?? null,
        normalized.postal_code ?? null,
        normalized.city ?? null,
        normalized.state_prefecture ?? null,
        normalized.country ?? null,
        normalized.notes_from_card ?? null,
        normalized.raw_ocr_text || null,
        args.fields.raw_ocr_text ? "mixed" : null,
        args.batchId,
        getLastConfidenceScore(args.confidence),
        timestamp,
        existingId,
      )
      .run();

    await db
      .prepare(
        `INSERT OR IGNORE INTO contact_methods (contact_id, method, created_at)
         VALUES (?, 'paper_card_batch_upload', ?)`,
      )
      .bind(existingId, timestamp)
      .run();

    await db
      .prepare(
      `INSERT INTO contact_events_v2
          (contact_id, batch_id, batch_card_id, company_id, source, event_type, name, email, summary, payload_json, created_at)
         VALUES (?, ?, ?, ?, 'paper_card_batch_upload', 'contact_captured', ?, ?, ?, ?, ?)`,
      )
      .bind(
        existingId,
        args.batchId,
        null,
        companyId,
        normalized.full_name ?? normalized.company_name ?? "Imported contact",
        normalized.email ?? null,
        "Paper card batch import",
        stringifyJson(normalized),
        timestamp,
      )
      .run();

    return { contactId: existingId, companyId, isNew: false };
  }

  const result = await db
    .prepare(
      `INSERT INTO contacts
        (company_id, name, first_name, last_name, full_name_native, furigana, email, email_lower, phone, mobile, linkedin_url, website, website_domain, company, company_name_native, job_title, department, address, postal_code, city, state_prefecture, country, notes, raw_ocr_text, source, status, source_language, primary_batch_id, last_confidence, needs_review, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paper_card_batch_upload', 'approved', ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      companyId,
      normalized.full_name ?? normalized.company_name ?? "Imported contact",
      normalized.first_name ?? null,
      normalized.last_name ?? null,
      normalized.full_name_native ?? null,
      normalized.furigana ?? null,
      normalized.email ?? null,
      normalizeEmail(normalized.email),
      normalizePhone(normalized.phone),
      normalizePhone(normalized.mobile),
      normalizeLinkedInUrl(normalized.linkedin_url),
      normalizeUrl(normalized.website),
      inferDomainFromUrl(normalized.website) ?? inferDomainFromEmail(normalized.email),
      normalized.company_name ?? null,
      normalized.company_name_native ?? null,
      normalized.job_title ?? null,
      normalized.department ?? null,
      normalized.address ?? null,
      normalized.postal_code ?? null,
      normalized.city ?? null,
      normalized.state_prefecture ?? null,
      normalized.country ?? null,
      normalized.notes_from_card ?? null,
      normalized.raw_ocr_text || null,
      args.fields.raw_ocr_text ? "mixed" : null,
      args.batchId,
      getLastConfidenceScore(args.confidence),
      timestamp,
      timestamp,
    )
    .run();

  const contactId = Number(result.meta.last_row_id ?? 0);

  await db
    .prepare(
      `INSERT INTO contact_methods (contact_id, method, created_at)
       VALUES (?, 'paper_card_batch_upload', ?)`,
    )
    .bind(contactId, timestamp)
    .run();

  await db
    .prepare(
      `INSERT INTO contact_events_v2
        (contact_id, batch_id, batch_card_id, company_id, source, event_type, name, email, summary, payload_json, created_at)
       VALUES (?, ?, ?, ?, 'paper_card_batch_upload', 'contact_captured', ?, ?, ?, ?, ?)`,
    )
    .bind(
      contactId,
      args.batchId,
      null,
      companyId,
      normalized.full_name ?? normalized.company_name ?? "Imported contact",
      normalized.email ?? null,
      "Paper card batch import",
      stringifyJson(normalized),
      timestamp,
    )
    .run();

  return { contactId, companyId, isNew: true };
}

export async function updateBatchCardReview(args: {
  actor: string;
  batchCardId: number;
  normalized: ExtractedContactFields;
  confidence: BatchCardFieldConfidence;
  sourceContactId?: number | null;
  invalidReason?: string | null;
  notes?: string | null;
  markApproved?: boolean;
}): Promise<void> {
  const db = getCrmDb();
  const before = await db
    .prepare("SELECT normalized_json, confidence_json, status, needs_review, invalid_reason, source_contact_id, notes, approved_by, approved_at FROM batch_cards WHERE id = ?")
    .bind(args.batchCardId)
    .first<{
      normalized_json: string | null;
      confidence_json: string | null;
      status: BatchCardStatus;
      needs_review: number;
      invalid_reason: string | null;
      source_contact_id: number | null;
      notes: string | null;
      approved_by: string | null;
      approved_at: string | null;
    }>();

  const normalized = normalizeExtractedFields(args.normalized);
  const status: BatchCardStatus = args.invalidReason
    ? "invalid"
    : args.markApproved
      ? "approved"
      : (before?.status ?? "needs_review");
  const approvedBy = args.markApproved
    ? args.actor
    : args.invalidReason
      ? null
      : (before?.approved_by ?? null);
  const approvedAt = args.markApproved
    ? nowIso()
    : args.invalidReason
      ? null
      : (before?.approved_at ?? null);

  await db
    .prepare(
      `UPDATE batch_cards
       SET normalized_json = ?,
           confidence_json = ?,
           source_contact_id = ?,
           invalid_reason = ?,
           notes = ?,
           status = ?,
           needs_review = ?,
           approved_by = ?,
           approved_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      stringifyJson(normalized),
      stringifyJson(args.confidence),
      args.sourceContactId ?? null,
      args.invalidReason ?? null,
      args.notes ?? null,
      status,
      status === "needs_review" ? 1 : 0,
      approvedBy,
      approvedAt,
      nowIso(),
      args.batchCardId,
    )
    .run();

  if (status !== "needs_review") {
    await db
      .prepare("UPDATE review_tasks SET status = 'resolved', resolved_at = ? WHERE entity_type = 'batch_card' AND entity_id = ? AND status = 'open'")
      .bind(nowIso(), args.batchCardId)
      .run();
  }

  const batchRow = await db
    .prepare("SELECT batch_id FROM batch_cards WHERE id = ?")
    .bind(args.batchCardId)
    .first<{ batch_id: number }>();
  if (batchRow?.batch_id) {
    await refreshBatchReviewCounts(batchRow.batch_id);
  }

  await logAudit({
    actor: args.actor,
    action: "batch_card.review_updated",
    entityType: "batch_card",
    entityId: args.batchCardId,
    beforeJson: before ? stringifyJson(before) : null,
    afterJson: stringifyJson({
      normalized,
      confidence: args.confidence,
      status,
      sourceContactId: args.sourceContactId ?? null,
      invalidReason: args.invalidReason ?? null,
      notes: args.notes ?? null,
    }),
  });
}

export async function processApprovedBatch(args: {
  actor: string;
  batchId: number;
}): Promise<void> {
  const db = getCrmDb();
  const profile = await getDazbeezProfile();

  const batch = await getBatchDetail(args.batchId);
  if (!batch) {
    throw new Error(`Batch ${args.batchId} was not found.`);
  }

  let createdContactsCount = 0;
  let updatedContactsCount = 0;
  let needsReviewCount = 0;

  for (const card of batch.cards) {
    if (card.status === "invalid") {
      continue;
    }

    const normalized = card.normalized;
    const canProcess = card.status === "approved" || card.status === "extracted";
    if (!canProcess) {
      needsReviewCount += 1;
      continue;
    }

    const upserted = await upsertContactFromCard({
      actor: args.actor,
      batchId: args.batchId,
      batchCardId: card.id,
      sourceContactId: card.sourceContactId,
      fields: normalized,
      confidence: card.confidence,
      batchContext: {
        eventName: batch.batch.eventName,
        eventDate: batch.batch.eventDate,
        eventLocation: batch.batch.eventLocation,
        notesAboutConversations: batch.batch.notesAboutConversations,
      },
    });

    if (upserted.isNew) {
      createdContactsCount += 1;
    } else {
      updatedContactsCount += 1;
    }

    const enrichmentRunResult = await db
      .prepare(
        `INSERT INTO enrichment_runs (contact_id, company_id, batch_card_id, provider, status, started_at, created_at)
         VALUES (?, ?, ?, 'website_fetch', 'running', ?, ?)`,
      )
      .bind(upserted.contactId, upserted.companyId ?? null, card.id, nowIso(), nowIso())
      .run();
    const enrichmentRunId = Number(enrichmentRunResult.meta.last_row_id ?? 0);

    const enrichmentFacts = await enrichFromOfficialWebsite({
      website: normalized.website,
      companyName: normalized.company_name,
      contactName: normalized.full_name,
      roleSummary: [normalized.job_title, normalized.department].filter(Boolean).join(" / ") || null,
    });

    await persistEnrichmentFacts({
      runId: enrichmentRunId,
      contactId: upserted.contactId,
      companyId: upserted.companyId,
      facts: enrichmentFacts,
    });

    await db
      .prepare(
        `UPDATE enrichment_runs
         SET status = ?, completed_at = ?, response_payload_json = ?
         WHERE id = ?`,
      )
      .bind(enrichmentFacts.length > 0 ? "completed" : "partial", nowIso(), stringifyJson(enrichmentFacts), enrichmentRunId)
      .run();

    const synergy = analyzeSynergy({
      contactName: normalized.full_name,
      companyName: normalized.company_name,
      jobTitle: normalized.job_title,
      department: normalized.department,
      website: normalized.website,
      batchContext: {
        eventName: batch.batch.eventName,
        eventDate: batch.batch.eventDate,
        eventLocation: batch.batch.eventLocation,
        notesAboutConversations: batch.batch.notesAboutConversations,
      },
      extracted: normalized,
      enrichmentFacts,
      profile,
    });

    await db
      .prepare(
        `INSERT INTO synergy_analyses
          (contact_id, company_id, batch_card_id, profile_version, synergy_score, synergy_summary, suggested_outreach_angle, recommended_cta, reasons_json, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        upserted.contactId,
        upserted.companyId ?? null,
        card.id,
        "dazbeez_profile",
        synergy.synergyScore,
        synergy.synergySummary,
        synergy.suggestedOutreachAngle,
        synergy.recommendedCta,
        stringifyJson(synergy.reasons),
        stringifyJson(synergy.evidence),
        nowIso(),
      )
      .run();

    const draft = createEmailDraft({
      contactName: normalized.full_name,
      companyName: normalized.company_name,
      profile,
      synergy,
      batchContext: {
        eventName: batch.batch.eventName,
        eventDate: batch.batch.eventDate,
        eventLocation: batch.batch.eventLocation,
        notesAboutConversations: batch.batch.notesAboutConversations,
      },
    });

    await createDraftRecord({
      contactId: upserted.contactId,
      companyId: upserted.companyId,
      batchId: args.batchId,
      batchCardId: card.id,
      draft,
    });

    await db
      .prepare(
        `UPDATE batch_cards
         SET contact_id = ?, company_id = ?, status = 'upserted', needs_review = 0, updated_at = ?
         WHERE id = ?`,
      )
      .bind(upserted.contactId, upserted.companyId ?? null, nowIso(), card.id)
      .run();

    await logAudit({
      actor: args.actor,
      action: upserted.isNew ? "contact.created_from_batch_card" : "contact.updated_from_batch_card",
      entityType: "contact",
      entityId: upserted.contactId,
      batchId: args.batchId,
      metadata: { batchCardId: card.id, companyId: upserted.companyId },
    });
  }

  await db
    .prepare(
      `UPDATE contact_batches
       SET status = ?, created_contacts_count = ?, updated_contacts_count = ?, needs_review_count = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
    )
    .bind(needsReviewCount > 0 ? "needs_review" : "completed", createdContactsCount, updatedContactsCount, needsReviewCount, nowIso(), nowIso(), args.batchId)
    .run();
}

export async function savePublicContactSubmissionToCrm(args: {
  actor: string;
  firstName: string;
  lastName: string;
  email: string;
  company?: string;
  phoneNumber?: string;
  service?: string;
  message: string;
  source?: string;
}): Promise<number> {
  const db = getCrmDb();
  const fullName = `${args.firstName} ${args.lastName}`.trim();
  const existingId = await findExistingContactForUpsert({
    email: args.email,
    linkedinUrl: null,
    sourceContactId: null,
    fullName,
    companyName: args.company ?? null,
  });

  const companyId = await upsertCompany({
    actor: args.actor,
    companyName: args.company ?? null,
    companyNameNative: null,
    website: null,
    industry: null,
    description: null,
    contactStatus: "approved",
  });

  const timestamp = nowIso();
  let contactId = existingId;
  if (contactId) {
    await db
      .prepare(
        `UPDATE contacts
         SET company_id = COALESCE(?, company_id),
             name = COALESCE(?, name),
             first_name = COALESCE(?, first_name),
             last_name = COALESCE(?, last_name),
             email = COALESCE(?, email),
             email_lower = COALESCE(?, email_lower),
             phone = COALESCE(?, phone),
             company = COALESCE(?, company),
             source = 'manual_form',
             status = 'approved',
             notes = COALESCE(?, notes),
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        companyId,
        fullName,
        args.firstName,
        args.lastName,
        args.email,
        normalizeEmail(args.email),
        normalizePhone(args.phoneNumber),
        args.company ?? null,
        args.message,
        timestamp,
        contactId,
      )
      .run();
  } else {
    const result = await db
      .prepare(
        `INSERT INTO contacts
          (company_id, name, first_name, last_name, email, email_lower, phone, company, notes, source, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual_form', 'approved', ?, ?)`,
      )
      .bind(
        companyId,
        fullName,
        args.firstName,
        args.lastName,
        args.email,
        normalizeEmail(args.email),
        normalizePhone(args.phoneNumber),
        args.company ?? null,
        args.message,
        timestamp,
        timestamp,
      )
      .run();
    contactId = Number(result.meta.last_row_id ?? 0);
  }

  await db
    .prepare(
      `INSERT OR IGNORE INTO contact_methods (contact_id, method, created_at)
       VALUES (?, 'manual_form', ?)`,
    )
    .bind(contactId, timestamp)
    .run();

  await db
    .prepare(
      `INSERT INTO contact_events_v2
        (contact_id, company_id, source, event_type, name, email, summary, payload_json, created_at)
       VALUES (?, ?, 'manual_form', 'contact_form_submission', ?, ?, ?, ?, ?)`,
    )
    .bind(
      contactId,
      companyId ?? null,
      fullName || "Website inquiry",
      args.email,
      args.message.slice(0, 240),
      stringifyJson({
        service: args.service ?? null,
        source: args.source ?? null,
        message: args.message,
      }),
      timestamp,
    )
    .run();

  return contactId;
}

export async function getImageBlob(imageId: number): Promise<{
  mimeType: string;
  blob: Uint8Array;
} | null> {
  const db = getCrmDb();
  const row = await db
    .prepare(
      `SELECT business_card_images_v2.mime_type,
              business_card_images_v2.blob_data,
              business_card_image_objects_v2.r2_object_key
       FROM business_card_images_v2
       LEFT JOIN business_card_image_objects_v2
         ON business_card_image_objects_v2.image_id = business_card_images_v2.id
       WHERE business_card_images_v2.id = ?`,
    )
    .bind(imageId)
    .first<{
      mime_type: string;
      blob_data: ArrayBuffer | Uint8Array | null;
      r2_object_key: string | null;
    }>();

  if (!row) {
    return null;
  }

  if (row.r2_object_key) {
    const bucket = getCrmImagesBucket();
    if (!bucket) {
      throw new Error("CRM image bucket binding is not configured.");
    }

    const object = await bucket.get(row.r2_object_key);
    if (object) {
      return {
        mimeType: row.mime_type,
        blob: new Uint8Array(await object.arrayBuffer()),
      };
    }
  }

  if (!row.blob_data) {
    return null;
  }

  const bytes = row.blob_data instanceof Uint8Array ? row.blob_data : new Uint8Array(row.blob_data);
  return {
    mimeType: row.mime_type,
    blob: bytes,
  };
}
