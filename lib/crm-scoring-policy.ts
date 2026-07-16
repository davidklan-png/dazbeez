// Deterministic CRM scoring policy. Dependency-free and safe to import from any
// CRM code (no server-only, runtime-binding, React, or Next.js imports).
//
// These constants name the previously inline magic numbers used to construct
// duplicate candidates and to choose synergy CTA/rationale language. They are
// NOT operator-configurable: no environment configuration, setters, classes, or
// mutable state.

/**
 * The synergy score boundary where the recommended CTA and the draft's
 * rationale label switch from low-pressure to high-fit. Scores at or above this
 * value are treated as high-fit.
 */
export const CRM_SYNERGY_HIGH_FIT_SCORE = 70;

/** True when a synergy score is at or above the high-fit boundary. */
export function isHighFitSynergyScore(score: number): boolean {
  return score >= CRM_SYNERGY_HIGH_FIT_SCORE;
}

/**
 * Deterministic duplicate-candidate construction policy: the confidences
 * assigned to each kind of match, the similarity thresholds that qualify a
 * "strong" name/company match, the minimum confidence to emit a candidate, and
 * the maximum number of candidates returned.
 *
 * This controls deterministic duplicate-candidate CONSTRUCTION only. It is not
 * `CrmThresholdSettings` and does not control whether a candidate is routed for
 * human review — `dedupe_review_threshold` remains persisted/operator-
 * configurable elsewhere (lib/crm.ts DEFAULT_THRESHOLDS + admin settings).
 */
export const CRM_DEDUPE_SCORING_POLICY = Object.freeze({
  exactEmailConfidence: 0.99,
  exactPhoneConfidence: 0.93,
  exactLinkedInConfidence: 0.96,
  strongNameSimilarityThreshold: 0.9,
  strongCompanySimilarityThreshold: 0.85,
  strongNameCompanyConfidence: 0.87,
  strongNameOnlyConfidence: 0.73,
  matchingDomainConfidence: 0.72,
  minimumCandidateConfidence: 0.55,
  maxCandidates: 5,
} as const);
