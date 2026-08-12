import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPackNotice,
  packNoticeMachineLine,
  isPackNoticeMachineLine,
} from "@/lib/receipts/proofs";
import {
  extractOperatorMessageFromNotice,
  stripOperatorMessageSection,
} from "@/lib/receipts/pack-preflight";
import type { PackNoticeInput } from "@/lib/receipts/proofs";
import type { PackNames } from "@/lib/receipts/pack-naming";

// Backlog #25: the preflight extractor must handle BOTH notice layouts, because
// preflight runs at SEND time and 2026-06 / 2026-07 are sealed with the OLD
// layout permanently. The discriminator is the machine line's position relative
// to 【今月のご連絡】 (the `の領収証憑一式を` marker occurs exactly once):
//   new layout — machine line AFTER the heading → preface = lines before heading
//   old layout — machine line BEFORE the heading → message = lines between headings

const NAMES: PackNames = {
  amexReconciliationCsv: "2026年6月-AMEX照合.csv",
  cashReconciliationCsv: "2026年6月-CASH照合.csv",
  digitalReconciliationCsv: "2026年6月-DIGITAL照合.csv",
} as PackNames;

const BASE: PackNoticeInput = {
  monthLabel: "2026年6月",
  rowCount: 5,
  receiptCount: 5,
  missingReceiptLines: [],
};
const MSG = "今月はリモートワーク関連経費が増加しています。";

// A pre-#25 (old-layout) notice, reproduced from buildPackNotice's pre-change
// structure: machine line FIRST, then 【今月のご連絡】 + message, then
// 【この資料について】. (The sealed 2026-06 / 2026-07 packs carry this layout.)
function oldLayoutNotice(msg: string | null): string {
  const lines: string[] = [];
  lines.push("2026年6月 の領収証憑一式をお送りします。");
  lines.push("");
  if (msg !== null) {
    lines.push("【今月のご連絡】");
    lines.push(msg);
    lines.push("");
  }
  lines.push("【この資料について】");
  lines.push("・カード明細の照合表（2026年6月-AMEX照合.csv）は、カード会社の明細CSVを基にしたものです。");
  lines.push("");
  lines.push("ご不明な点があればお知らせください。");
  return lines.join("\r\n");
}

// ─── extract: both layouts return the operator message ───────────────────────

test("extract: NEW layout — preface (lines before the heading) is the message", () => {
  const notice = buildPackNotice({ ...BASE, operatorMessage: MSG }, NAMES);
  assert.equal(extractOperatorMessageFromNotice(notice), MSG);
});

test("extract: NEW layout, empty message — heading present, preface is \"\"", () => {
  const notice = buildPackNotice(BASE, NAMES);
  assert.equal(extractOperatorMessageFromNotice(notice), "");
});

test("extract: OLD layout — message between the two headings", () => {
  const notice = oldLayoutNotice(MSG);
  assert.equal(extractOperatorMessageFromNotice(notice), MSG);
});

test("extract: OLD layout, empty message (no heading) — \"\"", () => {
  const notice = oldLayoutNotice(null);
  assert.equal(extractOperatorMessageFromNotice(notice), "");
});

// ─── strip: both layouts remove the operator free text ───────────────────────

test("strip: NEW layout — preface removed, generated heading + machine line kept", () => {
  const notice = buildPackNotice({ ...BASE, operatorMessage: MSG }, NAMES);
  const stripped = stripOperatorMessageSection(notice);
  assert.ok(!stripped.includes(MSG), "preface stripped");
  assert.ok(stripped.startsWith("【今月のご連絡】"), "generated heading kept (now first)");
  assert.ok(stripped.includes("の領収証憑一式を"), "machine line kept");
  assert.ok(stripped.includes("【この資料について】"), "generated structure kept");
});

test("strip: OLD layout — message between headings removed", () => {
  const notice = oldLayoutNotice(MSG);
  const stripped = stripOperatorMessageSection(notice);
  assert.ok(!stripped.includes(MSG), "operator message stripped");
  assert.ok(!stripped.includes("【今月のご連絡】"), "old operator-section heading stripped");
  assert.ok(stripped.includes("の領収証憑一式を"), "machine line kept");
  assert.ok(stripped.includes("【この資料について】"), "generated structure kept");
});

// ─── check #19 (O7) passes on BOTH layouts ───────────────────────────────────

test("check #19 (O7): extract(notice) === stored message on BOTH layouts", () => {
  // The O7 invariant compares extractOperatorMessageFromNotice(notice) to the
  // stored operator_message. It must hold for a new-layout pack AND a re-sent
  // old-layout sealed pack.
  assert.equal(extractOperatorMessageFromNotice(buildPackNotice({ ...BASE, operatorMessage: MSG }, NAMES)), MSG);
  assert.equal(extractOperatorMessageFromNotice(oldLayoutNotice(MSG)), MSG);
  assert.equal(extractOperatorMessageFromNotice(buildPackNotice(BASE, NAMES)), "");
  assert.equal(extractOperatorMessageFromNotice(oldLayoutNotice(null)), "");
});

// ─── regression: a representative pre-change (2026-06-style) notice ──────────

test("regression: a pre-#25 sealed notice (old layout) still parses", () => {
  // 2026-06 / 2026-07 sealed with the old layout. A correction revision re-sends
  // them; check #19 must still pass. This pins that the dual-layout extractor
  // handles the real old-layout shape (machine line first, heading + message).
  const sealed2026_06 = oldLayoutNotice("2026年6月分の領収証をお送りします。よろしくお願いします。");
  assert.equal(
    extractOperatorMessageFromNotice(sealed2026_06),
    "2026年6月分の領収証をお送りします。よろしくお願いします。",
  );
});

// ─── fail-then-pass: a new-only extractor would fail the old layout ──────────

test("fail-then-pass: a new-only extractor FAILS the old layout (the dual-layout is necessary)", () => {
  // An extractor that understands ONLY the new layout (preface = lines before
  // the heading) returns "" for an old-layout pack whose message sits BETWEEN
  // the headings — silently dropping the message and breaking check #19. The
  // real extractor must not.
  function newOnlyExtract(noticeText: string): string {
    const lines = noticeText.split(/\r?\n/);
    const headingIdx = lines.findIndex((l) => l.startsWith("【今月のご連絡】"));
    if (headingIdx === -1) return "";
    return lines.slice(0, headingIdx).join("\n").trim();
  }
  const oldNotice = oldLayoutNotice(MSG);
  // The new-only extractor gets the old layout WRONG (the machine line is before
  // the heading, so "lines before the heading" is the machine line, not the msg;
  // trimmed it isn't the message)…
  assert.notEqual(newOnlyExtract(oldNotice), MSG);
  // …while the real extractor gets it right.
  assert.equal(extractOperatorMessageFromNotice(oldNotice), MSG);
});

// ─── adversarial: operator text containing the marker phrase ─────────────────
// The operator's real 2026-06 message used the same register as the generated
// machine line. A discriminator that scans the whole document for the marker
// would land on their text. The fix anchors on the line AFTER the heading +
// matches the generated verb form (お送りします。), which the operator's prose
// does not replicate.

const ADVERSARIAL = "前回の領収証憑一式をお送りした際に不足がございました。追加いたします。";

test("adversarial: NEW layout with marker in the PREFACE ⇒ classified new, preface extracted, check #19 passes", () => {
  const notice = buildPackNotice({ ...BASE, operatorMessage: ADVERSARIAL }, NAMES);
  // The discriminator must NOT be fooled by the marker in the preface — it
  // checks the line AFTER the heading (the generated machine line ending in
  // お送りします。), not the preface.
  assert.equal(extractOperatorMessageFromNotice(notice), ADVERSARIAL);
});

test("adversarial: OLD layout with marker in the MESSAGE ⇒ classified old, message extracted, check #19 passes", () => {
  const notice = oldLayoutNotice(ADVERSARIAL);
  assert.equal(extractOperatorMessageFromNotice(notice), ADVERSARIAL);
});

test("fail-then-pass: the OLD document-wide findIndex discriminator FAILS the adversarial new-layout case", () => {
  // The previous discriminator scanned ALL lines for the marker. In the new
  // layout the preface (lines[0]) contains the marker ⇒ machineIdx=0 <
  // headingIdx=2 ⇒ misclassified as "old" ⇒ extractor returns the machine line,
  // not the preface ⇒ check #19 BLOCKS THE SEND.
  function oldDiscriminator(lines: string[]): "new" | "old" | "none" {
    const headingIdx = lines.findIndex((l) => l.startsWith("【今月のご連絡】"));
    if (headingIdx === -1) return "none";
    const machineIdx = lines.findIndex((l) => l.includes("の領収証憑一式を"));
    return machineIdx > headingIdx ? "new" : "old";
  }
  const notice = buildPackNotice({ ...BASE, operatorMessage: ADVERSARIAL }, NAMES);
  const lines = notice.split(/\r?\n/);
  // The old discriminator misclassifies (the preface's marker trips it)…
  assert.equal(oldDiscriminator(lines), "old");
  // …while the real extractor gets the preface right (proving "new" classification).
  assert.equal(extractOperatorMessageFromNotice(notice), ADVERSARIAL);
});

// ─── builder/predicate single-source agreement ──────────────────────────────

test("single-source: isPackNoticeMachineLine accepts exactly what packNoticeMachineLine emits", () => {
  // The builder and the predicate share one constant (MACHINE_LINE_SUFFIX). This
  // test makes drift IMPOSSIBLE: if someone edits the wording in the constant,
  // both update together; if someone introduces a parallel pattern, this fails.
  for (const label of ["2026年6月", "2026年8月", "2026年12月"]) {
    const line = packNoticeMachineLine(label);
    assert.ok(
      isPackNoticeMachineLine(line),
      `predicate must accept the builder's output for ${label}`,
    );
  }
  // The predicate must NOT accept arbitrary operator prose that merely contains
  // the marker phrase (different verb form).
  assert.ok(
    !isPackNoticeMachineLine("前回の領収証憑一式をお送りした際に不足がございました。"),
    "operator prose with the marker but a different verb form must NOT match",
  );
});
