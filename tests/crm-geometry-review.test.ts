import test from "node:test";
import assert from "node:assert/strict";
import cleanFixture from "@/tests/fixtures/clean-9-card.json";
import glareFixture from "@/tests/fixtures/glare-noisy-cards.json";
import { polygonArea, polygonToBounds, needsReviewForDetection } from "@/lib/crm-card-geometry";
import { assessBatchCardReviewState } from "@/lib/crm";
import { normalizeExtractedFields } from "@/lib/crm-normalization";

test("clean 9-card fixture yields stable normalized bounds", () => {
  const first = cleanFixture.detections[0];
  const bounds = polygonToBounds(first.polygon);

  assert.equal(cleanFixture.detections.length, 9);
  assert.equal(bounds.x, 0.04);
  assert.equal(bounds.width, 0.27);
  assert.ok(polygonArea(first.polygon) > 0.05);
  assert.equal(needsReviewForDetection(9, cleanFixture.detections.length), false);
});

test("low-confidence glare fixture gets routed into review", () => {
  const normalized = normalizeExtractedFields(glareFixture.fields);
  const assessment = assessBatchCardReviewState({
    normalized,
    confidence: glareFixture.confidence,
    duplicateCandidates: [],
    thresholds: {
      ocr_review_threshold: 0.72,
      dedupe_review_threshold: 0.75,
      draft_review_threshold: 0.7,
      detection_min_cards: 6
    }
  });

  assert.equal(assessment.needsReview, true);
  assert.ok(assessment.reasons.some((reason) => reason.includes("Low OCR confidence")));
});

test("empty confidence object always triggers review", () => {
  const normalized = normalizeExtractedFields({
    full_name: "Casey Operator",
    first_name: "Casey",
    last_name: "Operator",
    full_name_native: null,
    job_title: "Operations Manager",
    department: null,
    company_name: "Harbor Services",
    company_name_native: null,
    email: null,
    phone: "808-555-0181",
    mobile: null,
    website: "harbor.example.com",
    linkedin_url: null,
    address: null,
    postal_code: null,
    city: null,
    state_prefecture: null,
    country: "USA",
    notes_from_card: null,
    raw_ocr_text: "Casey Operator Harbor Services",
    pronouns: null,
    furigana: null,
    emails: [],
    phone_numbers: [],
  });
  const assessment = assessBatchCardReviewState({
    normalized,
    confidence: {},
    duplicateCandidates: [],
    thresholds: {
      ocr_review_threshold: 0.72,
      dedupe_review_threshold: 0.75,
      draft_review_threshold: 0.7,
      detection_min_cards: 6
    }
  });

  assert.equal(assessment.needsReview, true);
  assert.ok(assessment.reasons.some((reason) => reason.includes("No field confidence")));
});
