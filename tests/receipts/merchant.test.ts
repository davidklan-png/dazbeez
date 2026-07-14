import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeMerchant,
  detectMerchantChain,
  normalizeMerchantKey,
  CHAIN_CANONICAL,
} from "@/lib/receipts/merchant";

// ─── detectMerchantChain ───────────────────────────────────────────────────

test("merchant: セブン-イレブン variants all detect as seven_eleven", () => {
  // The prod garble "セブンーエレブン" (long-vowel ー + エ) is the case that
  // matters — it defeated both the duplicate grouping and the IC venue list.
  for (const m of [
    "セブン-イレブン",
    "セブンーエレブン", // prod garble (540a5714)
    "セブンイレブン",
    "セブン-イレブン 東中野末広橋店", // chain + branch (0802caae)
    "7-Eleven",
    "7-Eleven 渋谷本町3丁目店",
    "SEVEN ELEVEN",
  ]) {
    assert.equal(
      detectMerchantChain(m),
      "seven_eleven",
      `expected seven_eleven for «${m}»`,
    );
  }
});

test("merchant: other chains detect", () => {
  assert.equal(detectMerchantChain("ローソン"), "lawson");
  assert.equal(detectMerchantChain("LAWSON 新宿三丁目店"), "lawson");
  assert.equal(detectMerchantChain("ファミリーマート"), "familymart");
  assert.equal(detectMerchantChain("ファミマ"), "familymart");
  assert.equal(detectMerchantChain("FamilyMart"), "familymart");
  assert.equal(detectMerchantChain("NewDays"), "newdays");
  assert.equal(detectMerchantChain("New Days"), "newdays");
});

test("merchant: non-chain merchants detect as null", () => {
  assert.equal(detectMerchantChain("PC Depot"), null);
  assert.equal(detectMerchantChain("EMot"), null);
  assert.equal(detectMerchantChain("日本交通タクシー"), null);
  assert.equal(detectMerchantChain("HOLIDAY SKY LOUNGE 新宿"), null);
  // A station is NOT a chain (stations vary by name) — handled separately in
  // isTopUpVenueMerchant, not here.
  assert.equal(detectMerchantChain("新宿駅"), null);
  assert.equal(detectMerchantChain(null), null);
  assert.equal(detectMerchantChain(""), null);
});

// ─── canonicalizeMerchant ──────────────────────────────────────────────────

test("merchant: canonicalize collapses chain variants to the canonical token", () => {
  // The two prod strings that never clustered — both canonicalize to the same
  // token, so a duplicate-grouping key built on canonicalizeMerchant unifies
  // them.
  assert.equal(
    canonicalizeMerchant("セブンーエレブン"),
    CHAIN_CANONICAL.seven_eleven,
  );
  assert.equal(
    canonicalizeMerchant("セブン-イレブン 東中野末広橋店"),
    CHAIN_CANONICAL.seven_eleven,
  );
  assert.equal(canonicalizeMerchant("7-Eleven"), CHAIN_CANONICAL.seven_eleven);
  assert.equal(canonicalizeMerchant("ローソン"), CHAIN_CANONICAL.lawson);
  assert.equal(
    canonicalizeMerchant("ファミマ"),
    CHAIN_CANONICAL.familymart,
  );
  assert.equal(canonicalizeMerchant("NewDays"), CHAIN_CANONICAL.newdays);
});

test("merchant: canonicalize returns the merchant unchanged when not a chain", () => {
  // Non-chain merchants pass through verbatim so existing exact-key clusters
  // (HOLIDAY SKY LOUNGE, 岡芳商店, …) keep their grouping semantics.
  assert.equal(canonicalizeMerchant("PC Depot"), "PC Depot");
  assert.equal(canonicalizeMerchant("HOLIDAY SKY LOUNGE 新宿"), "HOLIDAY SKY LOUNGE 新宿");
  assert.equal(canonicalizeMerchant(""), "");
  assert.equal(canonicalizeMerchant(null), "");
});

// ─── normalizeMerchantKey ──────────────────────────────────────────────────

test("merchant: normalize strips separators, folds width/case", () => {
  assert.equal(normalizeMerchantKey("セブン-イレブン 東中野末広橋店"), "セブンイレブン東中野末広橋店");
  assert.equal(normalizeMerchantKey("7-Eleven"), "7eleven");
  assert.equal(normalizeMerchantKey("Family Mart"), "familymart");
  // long-vowel ー stripped (so ローソン → ロソン); needles are normalized the
  // same way so the match still holds.
  assert.equal(normalizeMerchantKey("ローソン"), "ロソン");
});
