import test from "node:test";
import assert from "node:assert/strict";
import duplicateFixture from "@/tests/fixtures/duplicate-contacts.json";
import mixedFixture from "@/tests/fixtures/mixed-ja-en-card.json";
import { buildDuplicateCandidates } from "@/lib/crm-dedupe";
import { normalizeExtractedFields } from "@/lib/crm-normalization";

test("buildDuplicateCandidates ranks exact identity matches highest", () => {
  const normalized = normalizeExtractedFields(mixedFixture.fields);
  const candidates = buildDuplicateCandidates(normalized, duplicateFixture.existingContacts);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].contactId, 11);
  assert.ok(candidates[0].confidence >= 0.95);
  assert.ok(candidates[0].reasons.includes("Exact LinkedIn URL match"));
});
