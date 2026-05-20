import test from "node:test";
import assert from "node:assert/strict";
import { isValidPairingCodeShape } from "@/lib/receipts/mobile-pairing";

test("isValidPairingCodeShape: accepts canonical DAZ-XXXX codes", () => {
  assert.equal(isValidPairingCodeShape("DAZ-7K3M"), true);
  assert.equal(isValidPairingCodeShape("DAZ-ABCD"), true);
  assert.equal(isValidPairingCodeShape("DAZ-2345"), true);
});

test("isValidPairingCodeShape: rejects malformed codes", () => {
  assert.equal(isValidPairingCodeShape("daz-7k3m"), false, "lowercase rejected");
  assert.equal(isValidPairingCodeShape("DAZ7K3M"), false, "missing dash rejected");
  assert.equal(isValidPairingCodeShape("DAZ-7K3"), false, "short body rejected");
  assert.equal(isValidPairingCodeShape("DAZ-7K3MX"), false, "long body rejected");
  assert.equal(isValidPairingCodeShape(""), false, "empty rejected");
  assert.equal(isValidPairingCodeShape("FOO-7K3M"), false, "wrong prefix rejected");
});
