import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAttendeeRequirement } from "@/lib/receipts/attendee-requirement";
import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";

// Backlog #6 (one-shot Part D): evaluateAttendeeRequirement is the single source
// for the attendees gate rule, called by both the finalize gate (CASH/DIGITAL
// receipts) and evaluateAmexLineSignoff (AMEX-matched receipts). These pin its
// contract directly — the four outcomes both callers map to their own blocker
// shapes.

function dirEntry(name: string): ReceiptAttendeeDirectoryEntry {
  return { name } as unknown as ReceiptAttendeeDirectoryEntry;
}

test("evaluateAttendeeRequirement: a category that does not require attendees ⇒ not required (no attendee checks)", () => {
  const r = evaluateAttendeeRequirement("supplies", ["Alice"], [dirEntry("Alice")]);
  assert.equal(r.required, false);
  assert.equal(r.attendeesPresent, false);
  assert.deepEqual(r.unresolved, []);
});

test("evaluateAttendeeRequirement: null/unknown category ⇒ not required", () => {
  assert.equal(evaluateAttendeeRequirement(null, [], []).required, false);
  assert.equal(evaluateAttendeeRequirement(undefined, [], []).required, false);
  assert.equal(evaluateAttendeeRequirement("not_a_code", [], []).required, false);
});

test("evaluateAttendeeRequirement: requires attendees but none provided ⇒ required, attendeesPresent false (the 'attendees_required' signal)", () => {
  const r = evaluateAttendeeRequirement("entertainment", [], [dirEntry("Alice")]);
  assert.equal(r.required, true);
  assert.equal(r.attendeesPresent, false);
  assert.deepEqual(r.unresolved, []);
});

test("evaluateAttendeeRequirement: requires attendees, all resolve ⇒ required, present, no unresolved (clean)", () => {
  const r = evaluateAttendeeRequirement(
    "meeting",
    ["Alice", "Bob"],
    [dirEntry("Alice"), dirEntry("Bob")],
  );
  assert.equal(r.required, true);
  assert.equal(r.attendeesPresent, true);
  assert.deepEqual(r.unresolved, []);
});

test("evaluateAttendeeRequirement: requires attendees, some unresolved ⇒ required, present, unresolved names (the 'attendee_unresolved' signal)", () => {
  const r = evaluateAttendeeRequirement(
    "entertainment",
    ["Alice", "  Carol  ", "Bob"], // trimmed on both sides
    [dirEntry("Alice")], // Bob + Carol absent
  );
  assert.equal(r.required, true);
  assert.equal(r.attendeesPresent, true);
  assert.deepEqual(r.unresolved.sort(), ["Bob", "Carol"]);
});
