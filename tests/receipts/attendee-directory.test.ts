import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTENDEE_DIRECTORY_SEED,
  resolveAttendeeNames,
  type ReceiptAttendeeDirectoryEntry,
} from "@/lib/receipts/attendee-directory";
import { buildAttendeesExportCsv } from "@/lib/receipts/export";

const DIR: ReceiptAttendeeDirectoryEntry[] = [
  { id: 5, company: "Acme", title: "Director", name: "Alice Nakamura" },
  { id: 3, company: "Beta", title: "CFO", name: "Bob Smith" },
];

// ─── resolveAttendeeNames ────────────────────────────────────────────────────

test("resolveAttendeeNames: exact match (case/whitespace sensitive after trim)", () => {
  const { entries, unresolved } = resolveAttendeeNames(["Alice Nakamura", "Bob Smith"], DIR);
  assert.equal(entries[0]?.id, 5);
  assert.equal(entries[1]?.id, 3);
  assert.deepEqual(unresolved, []);
});

test("resolveAttendeeNames: trims surrounding whitespace before matching", () => {
  const { entries, unresolved } = resolveAttendeeNames(["  Alice Nakamura  "], DIR);
  assert.equal(entries[0]?.id, 5, "trimmed name resolves");
  assert.deepEqual(unresolved, []);
});

test("resolveAttendeeNames: unresolved name → null entry + listed in unresolved", () => {
  const { entries, unresolved } = resolveAttendeeNames(
    ["Alice Nakamura", "Nobody Here"],
    DIR,
  );
  assert.equal(entries[0]?.id, 5);
  assert.equal(entries[1], null, "unresolved position is null");
  assert.deepEqual(unresolved, ["Nobody Here"]);
});

test("resolveAttendeeNames: positional alignment — entries[i] ↔ names[i]", () => {
  // The CSV builder relies on this 1:1 alignment to keep the Attendees and
  // AttendeeIds columns parallel (emitting "?" at unresolved positions).
  const names = ["Nobody", "Bob Smith", "Also Missing", "Alice Nakamura"];
  const { entries } = resolveAttendeeNames(names, DIR);
  assert.deepEqual(
    entries.map((e) => (e ? e.id : null)),
    [null, 3, null, 5],
  );
});

test("resolveAttendeeNames: empty/whitespace-only name → null, not flagged unresolved", () => {
  const { entries, unresolved } = resolveAttendeeNames(["", "   "], DIR);
  assert.equal(entries[0], null);
  assert.equal(entries[1], null);
  assert.deepEqual(unresolved, [], "blank names are not 'unresolved', just empty");
});

test("resolveAttendeeNames: dedupes unresolved names", () => {
  const { unresolved } = resolveAttendeeNames(["Ghost", "Ghost", "Ghost"], DIR);
  assert.deepEqual(unresolved, ["Ghost"]);
});

// ─── Seed integrity (the 66 ids are the sealed-export join key) ───────────────

test("ATTENDEE_DIRECTORY_SEED: 66 entries, ids 1–66 contiguous, unique names", () => {
  assert.equal(ATTENDEE_DIRECTORY_SEED.length, 66);
  const ids = ATTENDEE_DIRECTORY_SEED.map((e) => e.id);
  assert.deepEqual(ids, Array.from({ length: 66 }, (_, i) => i + 1));
  const names = ATTENDEE_DIRECTORY_SEED.map((e) => e.name);
  assert.equal(new Set(names).size, 66, "names must be unique (UNIQUE constraint)");
  // company/title never empty (NOT NULL at the DB layer).
  for (const e of ATTENDEE_DIRECTORY_SEED) {
    assert.ok(e.company.trim().length > 0, `id ${e.id} company empty`);
    assert.ok(e.title.trim().length > 0, `id ${e.id} title empty`);
  }
});

// ─── buildAttendeesExportCsv ─────────────────────────────────────────────────

test("buildAttendeesExportCsv: referenced-only, sorted by id, deduped, escapes commas", () => {
  const dir: ReceiptAttendeeDirectoryEntry[] = [
    { id: 5, company: "Acme, Inc.", title: "Director", name: "Alice Nakamura" },
    { id: 3, company: "Beta", title: "CFO", name: "Bob Smith" },
  ];
  const csv = buildAttendeesExportCsv(
    ["Bob Smith", "Alice Nakamura", "Bob Smith", "Unresolved Name"],
    dir,
  );
  const lines = csv.split("\n");
  assert.equal(lines[0], "AttendeeId,Name,Company,Title");
  // Referenced-only + unresolved dropped + deduped + sorted by id (3 before 5).
  assert.equal(lines[1], "3,Bob Smith,Beta,CFO");
  assert.equal(lines[2], '5,Alice Nakamura,"Acme, Inc.",Director', "comma in company is quoted");
  assert.equal(lines.length, 3, "header + 2 rows (deduped, unresolved dropped)");
});

test("buildAttendeesExportCsv: no referenced names → header only", () => {
  assert.equal(buildAttendeesExportCsv([], DIR), "AttendeeId,Name,Company,Title");
});

test("buildAttendeesExportCsv: trims attendee names before resolving", () => {
  const csv = buildAttendeesExportCsv(["  Alice Nakamura  "], DIR);
  assert.equal(csv.split("\n")[1], "5,Alice Nakamura,Acme,Director");
});
