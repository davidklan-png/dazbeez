import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPENSE_CATEGORIES,
  getCategoryByCode,
  requiresAttendees,
  isBusinessTripEligible,
  isCanonicalCode,
  formatCategoryLabel,
  mapLegacyCategory,
} from "@/lib/receipts/categories";

// ─── Category seed ───────────────────────────────────────────────────────────

test("EXPENSE_CATEGORIES has exactly 16 entries", () => {
  // 14 original + miscellaneous (雑費, 2026-07) + research_development (研究開発費, 2026-07-20).
  assert.equal(EXPENSE_CATEGORIES.length, 16);
});

test("research_development (研究開発費) is canonical, ordered immediately before miscellaneous", () => {
  const rd = getCategoryByCode("research_development");
  assert.ok(rd, "research_development should exist");
  assert.equal(rd!.jaName, "研究開発費");
  assert.equal(rd!.enName, "Research & Development");
  assert.equal(rd!.requiresAttendees, false);
  assert.equal(rd!.defaultBusinessTripEligible, false);
  assert.equal(rd!.displayOrder, 150);

  // Immediately before miscellaneous, which moved to display_order 160.
  const rdIdx = EXPENSE_CATEGORIES.findIndex((c) => c.code === "research_development");
  const miscIdx = EXPENSE_CATEGORIES.findIndex((c) => c.code === "miscellaneous");
  assert.ok(rdIdx >= 0 && miscIdx >= 0);
  assert.equal(miscIdx, rdIdx + 1, "research_development must immediately precede miscellaneous");
  assert.equal(getCategoryByCode("miscellaneous")!.displayOrder, 160);

  assert.equal(isCanonicalCode("research_development"), true);
  assert.equal(formatCategoryLabel("research_development"), "研究開発費 — Research & Development");
});

test("all canonical codes are unique", () => {
  const codes = EXPENSE_CATEGORIES.map((c) => c.code);
  assert.equal(new Set(codes).size, EXPENSE_CATEGORIES.length);
});

test("legacy 'misc' still requires review despite canonical 'miscellaneous' existing", () => {
  // Guard: mapLegacyCategory checks isCanonicalCode first, so the canonical
  // code must never be named 'misc' — old dumping-ground values would be
  // silently legitimized instead of surfacing for review.
  assert.deepEqual(mapLegacyCategory("misc"), { code: null, ambiguous: true });
  assert.deepEqual(mapLegacyCategory("miscellaneous"), {
    code: "miscellaneous",
    ambiguous: false,
  });
});

test("every category has required fields", () => {
  for (const cat of EXPENSE_CATEGORIES) {
    assert.ok(cat.code, "missing code");
    assert.ok(cat.jaName, "missing jaName");
    assert.ok(cat.enName, "missing enName");
    assert.equal(typeof cat.requiresAttendees, "boolean");
    assert.equal(typeof cat.defaultBusinessTripEligible, "boolean");
    assert.equal(typeof cat.displayOrder, "number");
  }
});

// ─── getCategoryByCode ────────────────────────────────────────────────────────

test("getCategoryByCode returns category for valid code", () => {
  const cat = getCategoryByCode("entertainment");
  assert.ok(cat);
  assert.equal(cat!.code, "entertainment");
  assert.equal(cat!.jaName, "交際費");
});

test("getCategoryByCode returns undefined for unknown code", () => {
  assert.equal(getCategoryByCode("nonexistent"), undefined);
});

// ─── formatCategoryLabel ─────────────────────────────────────────────────────

test("formatCategoryLabel returns ja — en format", () => {
  assert.equal(formatCategoryLabel("entertainment"), "交際費 — Entertainment expenses");
  assert.equal(formatCategoryLabel("meeting"), "会議費 — Meeting expenses");
  assert.equal(formatCategoryLabel("insurance"), "保険料 — Insurance premiums");
});

test("formatCategoryLabel returns placeholder for null/undefined", () => {
  assert.equal(formatCategoryLabel(null), "— Select category —");
  assert.equal(formatCategoryLabel(undefined), "— Select category —");
  assert.equal(formatCategoryLabel(""), "— Select category —");
});

test("formatCategoryLabel returns raw code for unknown code", () => {
  assert.equal(formatCategoryLabel("fake_code"), "fake_code");
});

// ─── requiresAttendees ────────────────────────────────────────────────────────

test("requiresAttendees returns true for entertainment and meeting only", () => {
  assert.equal(requiresAttendees("entertainment"), true);
  assert.equal(requiresAttendees("meeting"), true);
});

test("requiresAttendees returns false for other categories", () => {
  const attendeeCodes = new Set(["entertainment", "meeting"]);
  for (const cat of EXPENSE_CATEGORIES) {
    if (!attendeeCodes.has(cat.code)) {
      assert.equal(requiresAttendees(cat.code), false, `${cat.code} should not require attendees`);
    }
  }
});

test("requiresAttendees returns false for null/undefined/empty", () => {
  assert.equal(requiresAttendees(null), false);
  assert.equal(requiresAttendees(undefined), false);
  assert.equal(requiresAttendees(""), false);
});

// ─── isBusinessTripEligible ───────────────────────────────────────────────────

test("isBusinessTripEligible returns true for travel_transportation only", () => {
  assert.equal(isBusinessTripEligible("travel_transportation"), true);
});

test("isBusinessTripEligible returns false for all others", () => {
  for (const cat of EXPENSE_CATEGORIES) {
    if (cat.code !== "travel_transportation") {
      assert.equal(isBusinessTripEligible(cat.code), false, `${cat.code} should not be trip-eligible`);
    }
  }
});

test("isBusinessTripEligible returns false for null/undefined", () => {
  assert.equal(isBusinessTripEligible(null), false);
  assert.equal(isBusinessTripEligible(undefined), false);
});

// ─── isCanonicalCode ─────────────────────────────────────────────────────────

test("isCanonicalCode accepts all 16 canonical codes", () => {
  for (const cat of EXPENSE_CATEGORIES) {
    assert.equal(isCanonicalCode(cat.code), true, `${cat.code} should be canonical`);
  }
});

test("isCanonicalCode rejects legacy codes", () => {
  assert.equal(isCanonicalCode("meeting-no-alcohol"), false);
  assert.equal(isCanonicalCode("entertainment-alcohol"), false);
  assert.equal(isCanonicalCode("transportation"), false);
  assert.equal(isCanonicalCode("telecom"), false);
  assert.equal(isCanonicalCode("software"), false);
});

test("isCanonicalCode rejects garbage", () => {
  assert.equal(isCanonicalCode(""), false);
  assert.equal(isCanonicalCode("random"), false);
  assert.equal(isCanonicalCode(42 as unknown as string), false);
  assert.equal(isCanonicalCode(null as unknown as string), false);
});

// ─── mapLegacyCategory ────────────────────────────────────────────────────────

test("mapLegacyCategory passes through canonical codes unmodified", () => {
  const result = mapLegacyCategory("insurance");
  assert.deepEqual(result, { code: "insurance", ambiguous: false });
});

test("mapLegacyCategory maps known legacy values", () => {
  assert.deepEqual(mapLegacyCategory("meeting-no-alcohol"), { code: "meeting", ambiguous: false });
  assert.deepEqual(mapLegacyCategory("entertainment-alcohol"), { code: "entertainment", ambiguous: false });
  assert.deepEqual(mapLegacyCategory("transportation"), { code: "travel_transportation", ambiguous: false });
  assert.deepEqual(mapLegacyCategory("books"), { code: "newspapers_books", ambiguous: false });
  // Legacy 'research' stays newspapers_books — only the canonical research_development code is R&D.
  assert.deepEqual(mapLegacyCategory("research"), { code: "newspapers_books", ambiguous: false });
  assert.deepEqual(mapLegacyCategory("office_supplies"), { code: "supplies", ambiguous: false });
  assert.deepEqual(mapLegacyCategory("telecom"), { code: "communications", ambiguous: false });
});

test("mapLegacyCategory flags ambiguous mappings", () => {
  const software = mapLegacyCategory("software");
  assert.equal(software.code, null);
  assert.equal(software.ambiguous, true);

  const misc = mapLegacyCategory("misc");
  assert.equal(misc.code, null);
  assert.equal(misc.ambiguous, true);
});

test("mapLegacyCategory returns non-ambiguous null for unknown/null", () => {
  assert.deepEqual(mapLegacyCategory(null), { code: null, ambiguous: false });
  assert.deepEqual(mapLegacyCategory(undefined), { code: null, ambiguous: false });
  assert.deepEqual(mapLegacyCategory("unknown"), { code: null, ambiguous: false });
  assert.deepEqual(mapLegacyCategory("UNKNOWN"), { code: null, ambiguous: false });
  assert.deepEqual(mapLegacyCategory("totally-new-value"), { code: null, ambiguous: true });
});
