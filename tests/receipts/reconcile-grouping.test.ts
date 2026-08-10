import test from "node:test";
import assert from "node:assert/strict";
import {
  isSettled,
  groupLinesByStatus,
  type LineWithBand,
} from "@/lib/receipts/reconcile-grouping";
import type { AmexStatementLine, AmexMatchStatus } from "@/lib/receipts/types";
import type { ConfidenceBand } from "@/lib/receipts/confidence";

// groupLinesByStatus reads only line.match_status (via isSettled) and the
// wrapper's band, so a minimal stub is sufficient and stays readable.
function banded(
  id: string,
  match_status: AmexMatchStatus,
  band: ConfidenceBand,
): LineWithBand {
  return { line: { id, match_status } as AmexStatementLine, band, match: undefined };
}

test("isSettled: confirmed and no_receipt are terminal; matched/unmatched are not", () => {
  assert.equal(isSettled({ match_status: "confirmed" } as AmexStatementLine), true);
  assert.equal(isSettled({ match_status: "no_receipt" } as AmexStatementLine), true);
  assert.equal(isSettled({ match_status: "matched" } as AmexStatementLine), false);
  assert.equal(isSettled({ match_status: "unmatched" } as AmexStatementLine), false);
});

test("groupLinesByStatus: a no_receipt line is settled, not 'needs attention'", () => {
  // June-2026 shape: a no_receipt line carries no auto-match, so bandForLine
  // gives it band "none" — exactly what the old groupReview filter caught,
  // producing the phantom "Needs attention · 3" next to "32 of 32 confirmed".
  const lines: LineWithBand[] = [
    banded("confirmed-1", "confirmed", "obvious"),
    banded("no-receipt-1", "no_receipt", "none"),
    banded("no-receipt-2", "no_receipt", "none"),
    banded("no-receipt-3", "no_receipt", "none"),
    banded("unmatched-1", "unmatched", "none"),
  ];
  const groups = groupLinesByStatus(lines);

  // The three settled no_receipt lines must NOT appear under "Needs attention".
  assert.equal(groups.review.length, 1);
  assert.deepEqual(
    groups.review.map((g) => g.line.id),
    ["unmatched-1"],
  );

  // They ARE counted as confirmed (settled) — the rail shows "5 of 5", not
  // "2 of 5" alongside a phantom "Needs attention · 3".
  assert.equal(groups.confirmed.length, 4);
  assert.deepEqual(
    groups.confirmed.map((g) => g.line.id),
    ["confirmed-1", "no-receipt-1", "no-receipt-2", "no-receipt-3"],
  );
  assert.equal(groups.likely.length, 0);
  assert.equal(groups.obvious.length, 0);
});

test("groupLinesByStatus: a no_receipt line with an obvious/likely suggestion still settles", () => {
  // Operator overrode a suggested match with "no receipt expected". It is
  // settled regardless of the suggestion band — and excluded from the
  // bulk-confirm-obvious candidates (which now key on !isSettled).
  const groups = groupLinesByStatus([
    banded("nr-obvious", "no_receipt", "obvious"),
    banded("nr-likely", "no_receipt", "likely"),
  ]);
  assert.equal(groups.obvious.length, 0);
  assert.equal(groups.likely.length, 0);
  assert.equal(groups.confirmed.length, 2);
});
