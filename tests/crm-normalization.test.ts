import test from "node:test";
import assert from "node:assert/strict";
import ambiguousFixture from "@/tests/fixtures/ambiguous-linkedin-website.json";
import mixedFixture from "@/tests/fixtures/mixed-ja-en-card.json";
import missingEmailFixture from "@/tests/fixtures/missing-email-card.json";
import { inferDomainFromUrl, normalizeExtractedFields, normalizeLinkedInUrl, normalizePhone } from "@/lib/crm-normalization";

test("normalizeExtractedFields keeps bilingual values and normalizes identity fields", () => {
  const normalized = normalizeExtractedFields(mixedFixture.fields);

  assert.equal(normalized.email, "aiko.tanaka@mori-fg.co.jp");
  assert.equal(normalized.website, "https://mori-fg.co.jp");
  assert.equal(normalized.linkedin_url, "https://www.linkedin.com/in/aiko-tanaka");
  assert.equal(normalized.phone, "0355551200");
  assert.equal(normalized.mobile, "+819055551200");
  assert.equal(normalized.full_name_native, "田中 愛子");
});

test("normalization handles ambiguous website and linkedin URLs", () => {
  const normalized = normalizeExtractedFields(ambiguousFixture.fields);

  assert.equal(normalizeLinkedInUrl(ambiguousFixture.fields.linkedin_url), "https://linkedin.com/in/mina-sato-12345");
  assert.equal(inferDomainFromUrl(ambiguousFixture.fields.website), "pacific-advisory.co.jp");
  assert.equal(normalized.website, "https://pacific-advisory.co.jp/?ref=card");
});

test("missing email cards still normalize phone and preserve the rest of the card", () => {
  const normalized = normalizeExtractedFields(missingEmailFixture.fields);

  assert.equal(normalized.email, null);
  assert.equal(normalized.phone, "8085550181");
  assert.equal(normalized.website, "https://harbor.example.com");
  assert.equal(normalizePhone(missingEmailFixture.fields.phone), "8085550181");
});
