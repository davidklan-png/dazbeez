import test from "node:test";
import assert from "node:assert/strict";
import { buildDeliveryEmail } from "@/lib/receipts/delivery-send";

// delivery-composer §2: the email-only signature is appended AFTER the sealed
// notice's closing line, separated by a blank line, in BOTH text and html. The
// null/absent case MUST be byte-identical to pre-signature output — a hard
// requirement (existing callers/tests omit the param).

const MONTH = "2026-06";
const BASE_OPTS = {
  month: MONTH,
  operatorMessage: null,
  summary: null,
} as const;

test("buildDeliveryEmail: omitting signature (today's callers) is byte-identical to signature:null/''/whitespace", () => {
  const omitted = buildDeliveryEmail(BASE_OPTS);
  const nullSig = buildDeliveryEmail({ ...BASE_OPTS, signature: null });
  const emptySig = buildDeliveryEmail({ ...BASE_OPTS, signature: "" });
  const wsSig = buildDeliveryEmail({ ...BASE_OPTS, signature: "   \n  " });

  assert.deepEqual(nullSig, omitted, "signature:null ≡ omitted");
  assert.deepEqual(emptySig, omitted, "signature:'' ≡ omitted");
  assert.deepEqual(wsSig, omitted, "whitespace-only signature ≡ omitted (trimmed → nothing)");
});

test("buildDeliveryEmail: the null-case output is pinned (catches accidental drift of the sealed body)", () => {
  const { subject, text, html } = buildDeliveryEmail(BASE_OPTS);
  assert.equal(subject, "【領収証憑】2026年6月分");
  // The sealed body ends at the closing line — no signature, no trailing blank.
  // Backlog #25: opens at 【今月のご連絡】 + the machine line (the preface is
  // omitted when the message is empty — the inverse of the old layout).
  assert.equal(
    text,
    "【今月のご連絡】\r\n2026年6月 の領収証憑一式を添付にてお送りします。\r\n\r\nご不明な点があればお知らせください。",
  );
  // HTML is the pre-wrap div over the escaped text; unchanged by the signature
  // feature when no signature is supplied.
  assert.ok(html.includes("white-space:pre-wrap"));
  assert.ok(html.includes("ご不明な点があればお知らせください。"));
  assert.ok(!html.includes("山田"), "no signature markup leaks when null");
});

test("buildDeliveryEmail: a signature is appended after the closing line, blank-line separated, in text AND html", () => {
  const sig = "山田 太郎\nDazbeez合同会社";
  const { subject, text, html } = buildDeliveryEmail({ ...BASE_OPTS, signature: sig });

  // Subject is unaffected by the signature.
  assert.equal(subject, "【領収証憑】2026年6月分");

  // The signature follows the closing line, separated by a blank line. Trimmed.
  assert.equal(
    text,
    "【今月のご連絡】\r\n2026年6月 の領収証憑一式を添付にてお送りします。\r\n\r\n" +
      "ご不明な点があればお知らせください。\r\n\r\n" +
      "山田 太郎\nDazbeez合同会社",
  );

  // The HTML branch picks the signature up through escapeHtml(text) — the same
  // pre-wrap div, no hand-built signature markup. Both lines render.
  assert.ok(html.includes("山田 太郎"));
  assert.ok(html.includes("Dazbeez合同会社"));
  assert.ok(html.includes("white-space:pre-wrap"), "still the single pre-wrap div assembly");
  // Only ONE div/body — no second builder was added for the signature.
  assert.equal(html.match(/<div/g)?.length, 1, "single div — no hand-built signature markup");
});

test("buildDeliveryEmail: a signature with an operator message + summary still lands after the closing line", () => {
  const { text } = buildDeliveryEmail({
    month: MONTH,
    operatorMessage: "今月は海外出張の領収書が含まれています。",
    summary: {
      monthLabel: "2026年6月",
      categoryTotals: [{ ja: "交通費", count: 2, totalMinor: 15000 }],
    },
    signature: "-- DB",
  });
  // The signature MUST be the last thing, after ご不明な点… — never spliced into
  // the operator message or the summary block.
  const closingIdx = text.indexOf("ご不明な点があればお知らせください。");
  const sigIdx = text.indexOf("-- DB");
  assert.ok(closingIdx > -1 && sigIdx > closingIdx, "signature after the closing line");
  assert.ok(text.endsWith("-- DB"), "signature is the final content");
});
