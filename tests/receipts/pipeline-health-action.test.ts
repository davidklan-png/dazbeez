// Action-failure classification for the health-row buttons (review R4).
// classifyActionFailure / isActionDisabledByFailure are the exact functions
// the component's useActionButton calls — this matrix is the classification
// the UI renders, without a DOM. Network-level failures (fetch threw, no
// status) are mapped by the hook itself to "temporary".

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyActionFailure,
  isActionDisabledByFailure,
} from "@/lib/receipts/pipeline-health";

test("R4 classifyActionFailure matrix", () => {
  assert.equal(classifyActionFailure(409), "refused");
  assert.equal(classifyActionFailure(404), "removed");
  assert.equal(classifyActionFailure(401), "auth");
  assert.equal(classifyActionFailure(403), "auth");
  // Transport/server — retry stays sensible.
  assert.equal(classifyActionFailure(500), "temporary");
  assert.equal(classifyActionFailure(503), "temporary");
  assert.equal(classifyActionFailure(502), "temporary");
  assert.equal(classifyActionFailure(429), "temporary");
});

test("R4 only temporary failures leave the action enabled", () => {
  // Refused: prohibited in this state — re-clicking cannot succeed.
  assert.equal(isActionDisabledByFailure("refused"), true);
  // Removed: the receipt no longer exists — stale dashboard row.
  assert.equal(isActionDisabledByFailure("removed"), true);
  // Auth: unauthenticated clicks cannot succeed.
  assert.equal(isActionDisabledByFailure("auth"), true);
  // Temporary transport/server failure — retry may work.
  assert.equal(isActionDisabledByFailure("temporary"), false);
  // No failure yet / reset.
  assert.equal(isActionDisabledByFailure(null), false);
});
