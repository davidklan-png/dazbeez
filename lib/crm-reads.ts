import { getCrmDb } from "@/lib/cloudflare-runtime";
import { parseJsonValue } from "@/lib/crm-json";
import type {
  BatchCardFieldConfidence,
  BatchCardStatus,
  BatchImageRole,
  CompanyListItem,
  ContactListItem,
  ContactSource,
  ContactStatus,
  DraftStatus,
  DuplicateCandidate,
  EnrichmentFactInput,
  ExtractedContactFields,
  ReviewPriority,
  ReviewTaskStatus,
  SynergyAnalysisPayload,
} from "@/lib/crm-types";

export interface DashboardSummary {
  totalContacts: number;
  needsReview: number;
  draftReady: number;
  completedBatches: number;
  openReviewTasks: number;
  recentBatches: Array<{
    id: number;
    eventName: string | null;
    status: string;
    detectedCardCount: number | null;
    createdAt: string;
  }>;
}

export interface BatchListItem {
  id: number;
  status: string;
  eventName: string | null;
  eventDate: string | null;
  eventLocation: string | null;
  campaignTag: string | null;
  detectedCardCount: number | null;
  createdContactsCount: number;
  updatedContactsCount: number;
  needsReviewCount: number;
  errorCount: number;
  createdAt: string;
}

export interface BatchDetail {
  batch: {
    id: number;
    status: string;
    eventName: string | null;
    eventDate: string | null;
    eventLocation: string | null;
    notesAboutConversations: string | null;
    campaignTag: string | null;
    expectedCardCount: number | null;
    detectedCardCount: number | null;
    createdContactsCount: number;
    updatedContactsCount: number;
    needsReviewCount: number;
    errorCount: number;
    originalImageId: number | null;
    processingDiagnostics: Record<string, unknown> | null;
    createdAt: string;
    completedAt: string | null;
  };
  cards: Array<{
    id: number;
    sortOrder: number;
    status: BatchCardStatus;
    label: string | null;
    croppedImageId: number | null;
    enhancedImageId: number | null;
    contactId: number | null;
    companyId: number | null;
    sourceContactId: number | null;
    detectionConfidence: number | null;
    detectionBox: Record<string, unknown> | null;
    transform: Record<string, unknown> | null;
    rawOcrText: string | null;
    extracted: ExtractedContactFields;
    normalized: ExtractedContactFields;
    confidence: BatchCardFieldConfidence;
    duplicateCandidates: DuplicateCandidate[];
    needsReview: boolean;
    invalidReason: string | null;
    notes: string | null;
    approvedAt: string | null;
  }>;
}

export interface ContactDetail {
  contact: {
    id: number;
    name: string;
    firstName: string | null;
    lastName: string | null;
    fullNameNative: string | null;
    jobTitle: string | null;
    department: string | null;
    email: string | null;
    phone: string | null;
    mobile: string | null;
    linkedinUrl: string | null;
    website: string | null;
    company: string | null;
    companyId: number | null;
    status: ContactStatus;
    notes: string | null;
    rawOcrText: string | null;
    source: ContactSource;
    createdAt: string;
    updatedAt: string;
  };
  company: {
    id: number;
    name: string;
    website: string | null;
    websiteDomain: string | null;
    industry: string | null;
    description: string | null;
    status: ContactStatus;
  } | null;
  events: Array<{
    id: number;
    source: ContactSource;
    eventType: string;
    summary: string | null;
    createdAt: string;
  }>;
  images: Array<{
    id: number;
    role: BatchImageRole;
    batchId: number | null;
    batchCardId: number | null;
  }>;
  enrichmentFacts: EnrichmentFactInput[];
  synergy: SynergyAnalysisPayload | null;
  drafts: Array<{
    id: number;
    status: DraftStatus;
    subjectLine: string;
    plainTextBody: string;
    rationaleSummary: string;
    createdAt: string;
  }>;
  auditLog: Array<{
    id: number;
    action: string;
    actor: string;
    entityType: string;
    createdAt: string;
  }>;
}

export interface ReviewTaskItem {
  id: number;
  entityType: string;
  entityId: number;
  batchId: number | null;
  contactId: number | null;
  companyId: number | null;
  taskType: string;
  priority: ReviewPriority;
  status: ReviewTaskStatus;
  title: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface DraftListItem {
  id: number;
  contactId: number;
  contactName: string;
  companyName: string | null;
  status: DraftStatus;
  subjectLine: string;
  rationaleSummary: string;
  createdAt: string;
}

export async function listBatches(): Promise<BatchListItem[]> {
  const db = getCrmDb();
  const result = await db
    .prepare(
      `SELECT id,
              status,
              event_name,
              event_date,
              event_location,
              campaign_tag,
              detected_card_count,
              created_contacts_count,
              updated_contacts_count,
              needs_review_count,
              error_count,
              created_at
       FROM contact_batches
       ORDER BY created_at DESC, id DESC`,
    )
    .all<{
      id: number;
      status: string;
      event_name: string | null;
      event_date: string | null;
      event_location: string | null;
      campaign_tag: string | null;
      detected_card_count: number | null;
      created_contacts_count: number;
      updated_contacts_count: number;
      needs_review_count: number;
      error_count: number;
      created_at: string;
    }>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    status: row.status,
    eventName: row.event_name,
    eventDate: row.event_date,
    eventLocation: row.event_location,
    campaignTag: row.campaign_tag,
    detectedCardCount: row.detected_card_count,
    createdContactsCount: row.created_contacts_count,
    updatedContactsCount: row.updated_contacts_count,
    needsReviewCount: row.needs_review_count,
    errorCount: row.error_count,
    createdAt: row.created_at,
  }));
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const db = getCrmDb();
  const totals = await Promise.all([
    db.prepare("SELECT COUNT(*) as count FROM contacts WHERE status != 'archived'").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) as count FROM contacts WHERE needs_review = 1 OR status = 'needs_review'").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) as count FROM email_drafts WHERE status IN ('ready', 'approved')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) as count FROM contact_batches WHERE status = 'completed'").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) as count FROM review_tasks WHERE status = 'open'").first<{ count: number }>(),
  ]);

  const recentBatches = await db
    .prepare(
      `SELECT id, event_name, status, detected_card_count, created_at
       FROM contact_batches
       ORDER BY created_at DESC, id DESC
       LIMIT 5`,
    )
    .all<{
      id: number;
      event_name: string | null;
      status: string;
      detected_card_count: number | null;
      created_at: string;
    }>();

  return {
    totalContacts: totals[0]?.count ?? 0,
    needsReview: totals[1]?.count ?? 0,
    draftReady: totals[2]?.count ?? 0,
    completedBatches: totals[3]?.count ?? 0,
    openReviewTasks: totals[4]?.count ?? 0,
    recentBatches: (recentBatches.results ?? []).map((row) => ({
      id: row.id,
      eventName: row.event_name,
      status: row.status,
      detectedCardCount: row.detected_card_count,
      createdAt: row.created_at,
    })),
  };
}

export async function getBatchDetail(batchId: number): Promise<BatchDetail | null> {
  const db = getCrmDb();
  const batch = await db
    .prepare(
      `SELECT id,
              status,
              event_name,
              event_date,
              event_location,
              notes_about_conversations,
              campaign_tag,
              expected_card_count,
              detected_card_count,
              created_contacts_count,
              updated_contacts_count,
              needs_review_count,
              error_count,
              (
                SELECT id
                FROM business_card_images_v2
                WHERE batch_id = contact_batches.id
                  AND image_role = 'batch_original'
                ORDER BY id DESC
                LIMIT 1
              ) AS original_image_id,
              processing_diagnostics_json,
              created_at,
              completed_at
       FROM contact_batches
       WHERE id = ?`,
    )
    .bind(batchId)
    .first<{
      id: number;
      status: string;
      event_name: string | null;
      event_date: string | null;
      event_location: string | null;
      notes_about_conversations: string | null;
      campaign_tag: string | null;
      expected_card_count: number | null;
      detected_card_count: number | null;
      created_contacts_count: number;
      updated_contacts_count: number;
      needs_review_count: number;
      error_count: number;
      original_image_id: number | null;
      processing_diagnostics_json: string | null;
      created_at: string;
      completed_at: string | null;
    }>();

  if (!batch) {
    return null;
  }

  const cards = await db
    .prepare(
      `SELECT id,
              sort_order,
              status,
              contact_id,
              company_id,
              source_contact_id,
              (
                SELECT id
                FROM business_card_images_v2
                WHERE batch_card_id = batch_cards.id
                  AND image_role = 'cropped_card'
                ORDER BY id DESC
                LIMIT 1
              ) AS cropped_image_id,
              (
                SELECT id
                FROM business_card_images_v2
                WHERE batch_card_id = batch_cards.id
                  AND image_role = 'enhanced_card'
                ORDER BY id DESC
                LIMIT 1
              ) AS enhanced_image_id,
              detection_label,
              detection_confidence,
              detection_box_json,
              transform_json,
              raw_ocr_text,
              extracted_json,
              normalized_json,
              confidence_json,
              duplicate_candidates_json,
              notes,
              needs_review,
              invalid_reason,
              approved_at
       FROM batch_cards
       WHERE batch_id = ?
       ORDER BY sort_order ASC, id ASC`,
    )
    .bind(batchId)
    .all<{
      id: number;
      sort_order: number;
      status: BatchCardStatus;
      contact_id: number | null;
      company_id: number | null;
      source_contact_id: number | null;
      cropped_image_id: number | null;
      enhanced_image_id: number | null;
      detection_label: string | null;
      detection_confidence: number | null;
      detection_box_json: string | null;
      transform_json: string | null;
      raw_ocr_text: string | null;
      extracted_json: string | null;
      normalized_json: string | null;
      confidence_json: string | null;
      duplicate_candidates_json: string | null;
      notes: string | null;
      needs_review: number;
      invalid_reason: string | null;
      approved_at: string | null;
    }>();

  return {
    batch: {
      id: batch.id,
      status: batch.status,
      eventName: batch.event_name,
      eventDate: batch.event_date,
      eventLocation: batch.event_location,
      notesAboutConversations: batch.notes_about_conversations,
      campaignTag: batch.campaign_tag,
      expectedCardCount: batch.expected_card_count,
      detectedCardCount: batch.detected_card_count,
      createdContactsCount: batch.created_contacts_count,
      updatedContactsCount: batch.updated_contacts_count,
      needsReviewCount: batch.needs_review_count,
      errorCount: batch.error_count,
      originalImageId: batch.original_image_id,
      processingDiagnostics: parseJsonValue(batch.processing_diagnostics_json, null),
      createdAt: batch.created_at,
      completedAt: batch.completed_at,
    },
    cards: (cards.results ?? []).map((row) => ({
      id: row.id,
      sortOrder: row.sort_order,
      status: row.status,
      label: row.detection_label,
      croppedImageId: row.cropped_image_id,
      enhancedImageId: row.enhanced_image_id,
      contactId: row.contact_id,
      companyId: row.company_id,
      sourceContactId: row.source_contact_id,
      detectionConfidence: row.detection_confidence,
      detectionBox: parseJsonValue(row.detection_box_json, null),
      transform: parseJsonValue(row.transform_json, null),
      rawOcrText: row.raw_ocr_text,
      extracted: parseJsonValue(row.extracted_json, {
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
      }),
      normalized: parseJsonValue(row.normalized_json, {
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
      }),
      confidence: parseJsonValue(row.confidence_json, {}),
      duplicateCandidates: parseJsonValue(row.duplicate_candidates_json, []),
      needsReview: Boolean(row.needs_review),
      invalidReason: row.invalid_reason,
      notes: row.notes,
      approvedAt: row.approved_at,
    })),
  };
}

export async function listContacts(): Promise<ContactListItem[]> {
  const db = getCrmDb();
  const result = await db
    .prepare(
      `SELECT contacts.id,
              contacts.name,
              contacts.email,
              contacts.company,
              contacts.company_id,
              contacts.source,
              contacts.status,
              contacts.created_at,
              contacts.updated_at,
              (
                SELECT synergy_score
                FROM synergy_analyses
                WHERE synergy_analyses.contact_id = contacts.id
                ORDER BY created_at DESC, id DESC
                LIMIT 1
              ) AS synergy_score,
              (
                SELECT status
                FROM email_drafts
                WHERE email_drafts.contact_id = contacts.id
                ORDER BY created_at DESC, id DESC
                LIMIT 1
              ) AS draft_status
       FROM contacts
       WHERE contacts.status != 'archived'
       ORDER BY contacts.updated_at DESC, contacts.id DESC`,
    )
    .all<{
      id: number;
      name: string;
      email: string | null;
      company: string | null;
      company_id: number | null;
      source: ContactSource;
      status: ContactStatus;
      created_at: string;
      updated_at: string;
      synergy_score: number | null;
      draft_status: DraftStatus | null;
    }>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    companyId: row.company_id,
    source: row.source,
    status: row.status,
    synergyScore: row.synergy_score,
    draftStatus: row.draft_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function listCompanies(): Promise<CompanyListItem[]> {
  const db = getCrmDb();
  const result = await db
    .prepare(
      `SELECT companies.id,
              companies.name,
              companies.website,
              companies.website_domain,
              companies.industry,
              companies.status,
              companies.updated_at,
              (SELECT COUNT(*) FROM contacts WHERE contacts.company_id = companies.id) AS contact_count
       FROM companies
       ORDER BY companies.updated_at DESC, companies.id DESC`,
    )
    .all<{
      id: number;
      name: string;
      website: string | null;
      website_domain: string | null;
      industry: string | null;
      status: ContactStatus;
      updated_at: string;
      contact_count: number;
    }>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    website: row.website,
    websiteDomain: row.website_domain,
    industry: row.industry,
    status: row.status,
    contactCount: row.contact_count,
    updatedAt: row.updated_at,
  }));
}

export async function listReviewTasks(): Promise<ReviewTaskItem[]> {
  const db = getCrmDb();
  const result = await db
    .prepare(
      `SELECT id,
              entity_type,
              entity_id,
              batch_id,
              contact_id,
              company_id,
              task_type,
              priority,
              status,
              title,
              detail_json,
              created_at
       FROM review_tasks
       WHERE status = 'open'
       ORDER BY created_at DESC, id DESC`,
    )
    .all<{
      id: number;
      entity_type: string;
      entity_id: number;
      batch_id: number | null;
      contact_id: number | null;
      company_id: number | null;
      task_type: string;
      priority: ReviewPriority;
      status: ReviewTaskStatus;
      title: string;
      detail_json: string | null;
      created_at: string;
    }>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    batchId: row.batch_id,
    contactId: row.contact_id,
    companyId: row.company_id,
    taskType: row.task_type,
    priority: row.priority,
    status: row.status,
    title: row.title,
    detail: parseJsonValue(row.detail_json, null),
    createdAt: row.created_at,
  }));
}

export async function listDrafts(): Promise<DraftListItem[]> {
  const db = getCrmDb();
  const result = await db
    .prepare(
      `SELECT email_drafts.id,
              email_drafts.contact_id,
              contacts.name AS contact_name,
              companies.name AS company_name,
              email_drafts.status,
              email_drafts.subject_line,
              email_drafts.rationale_summary,
              email_drafts.created_at
       FROM email_drafts
       INNER JOIN contacts ON contacts.id = email_drafts.contact_id
       LEFT JOIN companies ON companies.id = email_drafts.company_id
       ORDER BY email_drafts.created_at DESC, email_drafts.id DESC`,
    )
    .all<{
      id: number;
      contact_id: number;
      contact_name: string;
      company_name: string | null;
      status: DraftStatus;
      subject_line: string;
      rationale_summary: string;
      created_at: string;
    }>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    contactId: row.contact_id,
    contactName: row.contact_name,
    companyName: row.company_name,
    status: row.status,
    subjectLine: row.subject_line,
    rationaleSummary: row.rationale_summary,
    createdAt: row.created_at,
  }));
}

export async function getContactDetail(contactId: number): Promise<ContactDetail | null> {
  const db = getCrmDb();
  const contact = await db
    .prepare(
      `SELECT id,
              name,
              first_name,
              last_name,
              full_name_native,
              job_title,
              department,
              email,
              phone,
              mobile,
              linkedin_url,
              website,
              company,
              company_id,
              status,
              notes,
              raw_ocr_text,
              source,
              created_at,
              updated_at
       FROM contacts
       WHERE id = ?`,
    )
    .bind(contactId)
    .first<{
      id: number;
      name: string;
      first_name: string | null;
      last_name: string | null;
      full_name_native: string | null;
      job_title: string | null;
      department: string | null;
      email: string | null;
      phone: string | null;
      mobile: string | null;
      linkedin_url: string | null;
      website: string | null;
      company: string | null;
      company_id: number | null;
      status: ContactStatus;
      notes: string | null;
      raw_ocr_text: string | null;
      source: ContactSource;
      created_at: string;
      updated_at: string;
    }>();

  if (!contact) {
    return null;
  }

  const [company, events, images, enrichmentFacts, synergyRow, drafts, auditLog] = await Promise.all([
    contact.company_id
      ? db
          .prepare(
            `SELECT id, name, website, website_domain, industry, description, status
             FROM companies
             WHERE id = ?`,
          )
          .bind(contact.company_id)
          .first<{
            id: number;
            name: string;
            website: string | null;
            website_domain: string | null;
            industry: string | null;
            description: string | null;
            status: ContactStatus;
          }>()
      : Promise.resolve(null),
    db
      .prepare(
        `SELECT id, source, event_type, summary, created_at
         FROM contact_events_v2
         WHERE contact_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .bind(contactId)
      .all<{
        id: number;
        source: ContactSource;
        event_type: string;
        summary: string | null;
        created_at: string;
      }>(),
    db
      .prepare(
        `SELECT DISTINCT business_card_images_v2.id,
                business_card_images_v2.image_role,
                business_card_images_v2.batch_id,
                business_card_images_v2.batch_card_id
         FROM business_card_images_v2
         WHERE business_card_images_v2.batch_card_id IN (
           SELECT id
           FROM batch_cards
           WHERE contact_id = ?
         )
         ORDER BY business_card_images_v2.created_at DESC, business_card_images_v2.id DESC`,
      )
      .bind(contactId)
      .all<{
        id: number;
        image_role: BatchImageRole;
        batch_id: number | null;
        batch_card_id: number | null;
      }>(),
    db
      .prepare(
        `SELECT fact_type, label, value, normalized_value, source_url, source_title, source_snippet, evidence_strength, retrieved_at
         FROM enrichment_facts
         WHERE contact_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .bind(contactId)
      .all<{
        fact_type: string;
        label: string;
        value: string;
        normalized_value: string | null;
        source_url: string;
        source_title: string | null;
        source_snippet: string | null;
        evidence_strength: "low" | "medium" | "high";
        retrieved_at: string;
      }>(),
    db
      .prepare(
        `SELECT synergy_score, synergy_summary, suggested_outreach_angle, recommended_cta, reasons_json, evidence_json
         FROM synergy_analyses
         WHERE contact_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .bind(contactId)
      .first<{
        synergy_score: number;
        synergy_summary: string;
        suggested_outreach_angle: string | null;
        recommended_cta: string | null;
        reasons_json: string;
        evidence_json: string;
      }>(),
    db
      .prepare(
        `SELECT id, status, subject_line, plain_text_body, rationale_summary, created_at
         FROM email_drafts
         WHERE contact_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .bind(contactId)
      .all<{
        id: number;
        status: DraftStatus;
        subject_line: string;
        plain_text_body: string;
        rationale_summary: string;
        created_at: string;
      }>(),
    db
      .prepare(
        `SELECT id, action, actor, entity_type, created_at
         FROM audit_logs
         WHERE entity_type IN ('contact', 'batch_card', 'contact_batch')
           AND (entity_id = ? OR metadata_json LIKE ?)
         ORDER BY created_at DESC, id DESC
         LIMIT 20`,
      )
      .bind(contactId, `%\"companyId\":${contact.company_id ?? 0}%`)
      .all<{
        id: number;
        action: string;
        actor: string;
        entity_type: string;
        created_at: string;
      }>(),
  ]);

  return {
    contact: {
      id: contact.id,
      name: contact.name,
      firstName: contact.first_name,
      lastName: contact.last_name,
      fullNameNative: contact.full_name_native,
      jobTitle: contact.job_title,
      department: contact.department,
      email: contact.email,
      phone: contact.phone,
      mobile: contact.mobile,
      linkedinUrl: contact.linkedin_url,
      website: contact.website,
      company: contact.company,
      companyId: contact.company_id,
      status: contact.status,
      notes: contact.notes,
      rawOcrText: contact.raw_ocr_text,
      source: contact.source,
      createdAt: contact.created_at,
      updatedAt: contact.updated_at,
    },
    company: company
      ? {
          id: company.id,
          name: company.name,
          website: company.website,
          websiteDomain: company.website_domain,
          industry: company.industry,
          description: company.description,
          status: company.status,
        }
      : null,
    events: (events.results ?? []).map((row) => ({
      id: row.id,
      source: row.source,
      eventType: row.event_type,
      summary: row.summary,
      createdAt: row.created_at,
    })),
    images: (images.results ?? []).map((row) => ({
      id: row.id,
      role: row.image_role,
      batchId: row.batch_id,
      batchCardId: row.batch_card_id,
    })),
    enrichmentFacts: (enrichmentFacts.results ?? []).map((row) => ({
      factType: row.fact_type,
      label: row.label,
      value: row.value,
      normalizedValue: row.normalized_value,
      sourceUrl: row.source_url,
      sourceTitle: row.source_title,
      sourceSnippet: row.source_snippet,
      evidenceStrength: row.evidence_strength,
      retrievedAt: row.retrieved_at,
    })),
    synergy: synergyRow
      ? {
          synergyScore: synergyRow.synergy_score,
          synergySummary: synergyRow.synergy_summary,
          suggestedOutreachAngle: synergyRow.suggested_outreach_angle ?? "",
          recommendedCta: synergyRow.recommended_cta ?? "",
          reasons: parseJsonValue(synergyRow.reasons_json, []),
          evidence: parseJsonValue(synergyRow.evidence_json, []),
        }
      : null,
    drafts: (drafts.results ?? []).map((row) => ({
      id: row.id,
      status: row.status,
      subjectLine: row.subject_line,
      plainTextBody: row.plain_text_body,
      rationaleSummary: row.rationale_summary,
      createdAt: row.created_at,
    })),
    auditLog: (auditLog.results ?? []).map((row) => ({
      id: row.id,
      action: row.action,
      actor: row.actor,
      entityType: row.entity_type,
      createdAt: row.created_at,
    })),
  };
}
