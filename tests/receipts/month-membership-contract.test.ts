// ADR 0014 — receipt month-membership authority, enforced structurally.
// 2026-10-06 incident: the compliance gate's calendar sweep
// (transaction_date LIKE month%) pulled an UNMATCHED AMEX receipt (リカーBOSS,
// extracted 2026-09-08, statement home 2026-10) into 2026-09's finalize gate
// and blocked the close. Same class as izmicworld for 2026-08. The rule —
// AMEX receipts gate by STATEMENT month (bundle membership via matched
// lines), never by transaction date — lived nowhere until the ADR; this test
// is the structural pin (source-reading, same pattern as
// amex-import-contract / capture-contract: a D1-query change is invisible to
// unit tests, only the SQL text can be asserted).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const COMPLIANCE_SRC = readFileSync("lib/receipts/compliance.ts", "utf8");

function stripCommentLines(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");
}

test("month-membership: compliance calendar sweep EXCLUDES AMEX-path receipts (ADR 0014 rule 1)", () => {
  const code = stripCommentLines(COMPLIANCE_SRC);
  const monthSweepMatch = code.match(
    /FROM receipt_compliance_checks[\s\S]{0,400}?AND rr\.deleted_at IS NULL([\s\S]{0,200}?payment_path[^'"]*'AMEX')?`/,
  );
  assert.ok(monthSweepMatch, "month sweep query not found in compliance.ts");
  // The sweep must carry the AMEX exclusion in the same statement.
  assert.match(
    monthSweepMatch[0],
    /payment_path\s*<>\s*'AMEX'/,
    "ADR 0014: the calendar-month compliance sweep must exclude payment_path='AMEX'. " +
      "AMEX receipts gate by statement month (bundle membership / extraReceiptIds), " +
      "never by transaction_date — see docs/adr/0014-receipt-month-membership-authority.md",
  );
});

test("month-membership: ADR 0014 exists and names the authority", () => {
  const adr = readFileSync(
    "docs/adr/0014-receipt-month-membership-authority.md",
    "utf8",
  );
  assert.match(adr, /unmatched AMEX receipt blocks nothing/);
});
