import test from "node:test";
import assert from "node:assert/strict";
import { AbortRegistry } from "@/lib/receipts/abort-registry";

test("AbortRegistry: register tracks size; abortAll aborts every controller and clears", () => {
  const reg = new AbortRegistry();
  const a = new AbortController();
  const b = new AbortController();
  assert.equal(reg.size, 0);

  reg.register(a);
  reg.register(b);
  assert.equal(reg.size, 2);

  reg.abortAll();
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, true);
  assert.equal(reg.size, 0); // cleared
});

test("AbortRegistry: unregister before abort removes only that controller", () => {
  const reg = new AbortRegistry();
  const a = new AbortController();
  const b = new AbortController();
  reg.register(a);
  reg.register(b);

  reg.unregister(a);
  assert.equal(reg.size, 1);

  reg.abortAll();
  assert.equal(b.signal.aborted, true);
  assert.equal(a.signal.aborted, false); // a was unregistered, so not aborted
});

test("AbortRegistry: unregister after abortAll is harmless", () => {
  const reg = new AbortRegistry();
  const a = new AbortController();
  reg.register(a);
  reg.abortAll();
  assert.equal(reg.size, 0);

  // No throw, no state change.
  reg.unregister(a);
  assert.equal(reg.size, 0);

  // Unregistering something never registered is also harmless.
  reg.unregister(new AbortController());
  assert.equal(reg.size, 0);
});
