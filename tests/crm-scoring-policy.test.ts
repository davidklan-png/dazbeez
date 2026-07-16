import test from "node:test";
import assert from "node:assert/strict";
import {
  CRM_DEDUPE_SCORING_POLICY,
  CRM_SYNERGY_HIGH_FIT_SCORE,
  isHighFitSynergyScore,
} from "@/lib/crm-scoring-policy";

test("CRM_SYNERGY_HIGH_FIT_SCORE is exactly 70", () => {
  assert.equal(CRM_SYNERGY_HIGH_FIT_SCORE, 70);
});

test("isHighFitSynergyScore returns false for 69 and true for 70 and 71", () => {
  assert.equal(isHighFitSynergyScore(69), false);
  assert.equal(isHighFitSynergyScore(70), true);
  assert.equal(isHighFitSynergyScore(71), true);
});

test("CRM_DEDUPE_SCORING_POLICY deep-equals the specified policy object", () => {
  assert.deepEqual(CRM_DEDUPE_SCORING_POLICY, {
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
  });
});

test("CRM_DEDUPE_SCORING_POLICY is frozen — mutation throws and value is unchanged", () => {
  assert.equal(Object.isFrozen(CRM_DEDUPE_SCORING_POLICY), true);
  assert.throws(
    () => {
      (
        CRM_DEDUPE_SCORING_POLICY as { exactEmailConfidence: number }
      ).exactEmailConfidence = 0.01;
    },
    TypeError,
  );
  assert.equal(CRM_DEDUPE_SCORING_POLICY.exactEmailConfidence, 0.99);
});
