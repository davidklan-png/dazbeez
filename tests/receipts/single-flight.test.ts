import test from "node:test";
import assert from "node:assert/strict";
import { SingleFlight } from "@/lib/receipts/single-flight";

test("SingleFlight: first start wins, second is rejected while busy", () => {
  const sf = new SingleFlight();
  assert.equal(sf.busy, false);
  assert.equal(sf.start(), true);
  assert.equal(sf.busy, true);
  // A second invocation while one is in flight must NOT win — this is the
  // guarantee that a rapid double-tap cannot overwrite the active phase.
  assert.equal(sf.start(), false);
  assert.equal(sf.start(), false);
  assert.equal(sf.busy, true);
});

test("SingleFlight: finish re-enables start", () => {
  const sf = new SingleFlight();
  sf.start();
  assert.equal(sf.busy, true);
  sf.finish();
  assert.equal(sf.busy, false);
  assert.equal(sf.start(), true); // re-enabled
  sf.finish();
});

test("SingleFlight: finish without start is harmless (returns to idle)", () => {
  const sf = new SingleFlight();
  sf.finish(); // no-op, not busy
  assert.equal(sf.busy, false);
  assert.equal(sf.start(), true);
});
