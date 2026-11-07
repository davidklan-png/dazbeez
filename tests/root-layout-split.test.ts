import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Root-layout split contract (TASK-042). The app has TWO root layouts via
// route groups: app/(site)/layout.tsx (marketing chrome: SiteNavigation +
// Footer) and app/(receipt-system)/layout.tsx (document scaffolding only —
// the ReceiptShell row is the module's own chrome). Source-structure tests,
// same style as admin-owner-contract: a behavioral test would need a DOM
// harness this project's tsx + node:test suite doesn't have.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("root layout split: no top-level app/layout.tsx", () => {
  // If app/layout.tsx existed, both group layouts would nest UNDER it and
  // every receipts page would silently regain the marketing header/footer.
  assert.equal(
    existsSync(join(root, "app/layout.tsx")),
    false,
    "app/layout.tsx must not exist — receipts pages must not nest under the marketing root layout",
  );
});

test("root layout split: the receipts tree never imports SiteNavigation", () => {
  let out = "";
  try {
    out = execFileSync(
      "git",
      ["grep", "-l", "-e", "site-navigation", "--", "app/(receipt-system)/", "components/receipts/"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (e) {
    // git grep exits 1 on zero matches — the healthy case for this test.
    if ((e as { status?: number }).status !== 1) throw e;
  }
  const offenders = out.trim().split("\n").filter(Boolean);
  assert.deepEqual(
    offenders,
    [],
    `receipts module must not render the marketing navigation; found imports in: ${offenders.join(", ")}`,
  );
});
