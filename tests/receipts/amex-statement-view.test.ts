import test from "node:test";
import assert from "node:assert/strict";
import type { PillTone } from "@/components/ui/pill";
import { amexMatchStatusPill } from "@/app/(receipt-system)/receipts/amex/statement/[id]/page";

// ─── amexMatchStatusPill (statement-lines view, TASK-044) ───────────────────
// The /receipts/amex/statement/[id] table renders one Pill per statement line.
// "Confirmed" and "No receipt expected" must stay byte-identical to the
// Reconcile screen's labels (reconcile-screen.tsx:1541-1543) — the two
// surfaces are compared side by side when reviewing a month.

const VALID_TONES: PillTone[] = [
  "gray",
  "amber",
  "green",
  "red",
  "blue",
  "purple",
  "outline",
];

test("amexMatchStatusPill: maps every AmexMatchStatus to a label + valid tone", () => {
  assert.deepEqual(amexMatchStatusPill("unmatched"), {
    tone: "amber",
    label: "No match",
  });
  assert.deepEqual(amexMatchStatusPill("matched"), {
    tone: "blue",
    label: "Matched",
  });
  assert.deepEqual(amexMatchStatusPill("confirmed"), {
    tone: "green",
    label: "Confirmed",
  });
  assert.deepEqual(amexMatchStatusPill("no_receipt"), {
    tone: "gray",
    label: "No receipt expected",
  });
});

test("amexMatchStatusPill: every tone is a real PillTone (typo guard)", () => {
  const statuses = ["unmatched", "matched", "confirmed", "no_receipt"] as const;
  for (const s of statuses) {
    const { tone, label } = amexMatchStatusPill(s);
    assert.ok(VALID_TONES.includes(tone), `${s}: tone "${tone}" is a PillTone`);
    assert.ok(label.length > 0, `${s}: label is non-empty`);
  }
});
