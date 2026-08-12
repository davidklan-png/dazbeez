import test from "node:test";
import assert from "node:assert/strict";
import {
  isSettled,
  groupLinesByStatus,
  type LineWithBand,
} from "@/lib/receipts/reconcile-grouping";
import type { AmexStatementLine, AmexMatchStatus } from "@/lib/receipts/types";
import type { ConfidenceBand } from "@/lib/receipts/confidence";

// groupLinesByStatus reads only line.match_status (via isSettled), the line's
// receipt_missing_reason (via isSettled), and the wrapper's band — so a minimal
// stub is sufficient and stays readable.
function line(
  id: string,
  match_status: AmexMatchStatus,
  receipt_missing_reason: string | null = null,
): AmexStatementLine {
  return { id, match_status, receipt_missing_reason } as AmexStatementLine;
}
function banded(
  id: string,
  match_status: AmexMatchStatus,
  band: ConfidenceBand,
  receipt_missing_reason: string | null = null,
): LineWithBand {
  return { line: line(id, match_status, receipt_missing_reason), band, match: undefined };
}

// ─── §1: isSettled — no_receipt is settled ONLY with a reason ────────────────

test("isSettled: confirmed is settled; matched/unmatched are not", () => {
  assert.equal(isSettled(line("c", "confirmed")), true);
  assert.equal(isSettled(line("m", "matched")), false);
  assert.equal(isSettled(line("u", "unmatched")), false);
});

test("isSettled: no_receipt is settled ONLY with a non-empty trimmed reason", () => {
  assert.equal(isSettled(line("nr-reason", "no_receipt", "annual fee")), true);
  // null / empty / whitespace ⇒ NOT settled (incomplete — needs a reason).
  assert.equal(isSettled(line("nr-null", "no_receipt", null)), false);
  assert.equal(isSettled(line("nr-empty", "no_receipt", "")), false);
  assert.equal(isSettled(line("nr-ws", "no_receipt", "   ")), false);
});

// ─── grouping + count follow from isSettled alone (single source) ────────────

test("groupLinesByStatus: a no_receipt WITH a reason settles (confirmed); WITHOUT it lands in Needs attention", () => {
  const groups = groupLinesByStatus([
    banded("confirmed-1", "confirmed", "obvious"),
    banded("nr-with-reason", "no_receipt", "none", "card annual fee"),
    banded("nr-no-reason-1", "no_receipt", "none"), // reasonless → needs attention
    banded("nr-no-reason-2", "no_receipt", "none"),
    banded("unmatched-1", "unmatched", "none"),
  ]);

  // Confirmed section = confirmed + the reasoned no_receipt only.
  assert.deepEqual(
    groups.confirmed.map((g) => g.line.id),
    ["confirmed-1", "nr-with-reason"],
  );
  // Needs attention = unmatched + the two reasonless no_receipt lines. The
  // header count (confirmed.length) excludes them automatically.
  assert.deepEqual(
    groups.review.map((g) => g.line.id).sort(),
    ["nr-no-reason-1", "nr-no-reason-2", "unmatched-1"],
  );
  assert.equal(groups.likely.length, 0);
  assert.equal(groups.obvious.length, 0);
});

test("groupLinesByStatus: a no_receipt line WITH a reason overrides an obvious/likely suggestion and settles", () => {
  const groups = groupLinesByStatus([
    banded("nr-obvious", "no_receipt", "obvious", "settled reason"),
    banded("nr-likely", "no_receipt", "likely", "settled reason"),
  ]);
  assert.equal(groups.obvious.length, 0);
  assert.equal(groups.likely.length, 0);
  assert.equal(groups.confirmed.length, 2);
});
