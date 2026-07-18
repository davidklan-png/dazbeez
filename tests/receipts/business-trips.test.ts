import test from "node:test";
import assert from "node:assert/strict";
import {
  detectBusinessTripCandidates,
  DEFAULT_HOMEBASE_SIGNALS,
} from "@/lib/receipts/validation";
import {
  rangesOverlap,
  unionRange,
  findOverlappingTrip,
  decideWiden,
  computeTripStatusLineUpdates,
  validateTripDates,
  validateTripTransition,
  shiftDate,
  candidateWindow,
  isInCandidateWindow,
  filterAttachCandidates,
  dedupeChargeCandidates,
  candidateDisableReason,
  filterTripsByTab,
  tripStatusTone,
  type CandidateRow,
  type ExistingTrip,
} from "@/lib/receipts/business-trips";

const H = DEFAULT_HOMEBASE_SIGNALS;

interface TLine {
  id: string;
  cardholderName: string;
  transactionDate: string;
  merchant: string;
  expenseCategoryCode: string | null;
}
function line(over: Partial<TLine> & { id: string }): TLine {
  return {
    cardholderName: "David",
    transactionDate: "2026-03-10",
    merchant: "",
    expenseCategoryCode: null,
    ...over,
  };
}

// ─── Detection: homebase-config parity + category boost (ADR 0010 D3) ────────

test("detection parity: default signals, no category codes → anchors only (today's behavior)", () => {
  const candidates = detectBusinessTripCandidates(
    [
      line({ id: "a", merchant: "大阪ホテル", transactionDate: "2026-03-10" }),
      line({ id: "b", merchant: "京都レストラン", transactionDate: "2026-03-11" }),
    ],
    H,
  );
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]!.lineIds.sort(), ["a", "b"]);
});

test("detection boost: eligible-category line with no region string joins an anchor within window", () => {
  // Ekinet-style: travel-eligible category, no location signal, within 7d of an anchor.
  const candidates = detectBusinessTripCandidates(
    [
      line({ id: "anchor", merchant: "大阪ホテル", transactionDate: "2026-03-10" }),
      line({ id: "ekinet", merchant: "Ekinet チケット", transactionDate: "2026-03-13", expenseCategoryCode: "travel_transportation" }),
    ],
    H,
  );
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]!.lineIds.sort(), ["anchor", "ekinet"]);
});

test("detection boost: eligible lines with NO anchor form no candidate (boost never alone)", () => {
  const candidates = detectBusinessTripCandidates(
    [
      line({ id: "e1", merchant: "Ekinet", transactionDate: "2026-03-10", expenseCategoryCode: "travel_transportation" }),
      line({ id: "e2", merchant: "JR East", transactionDate: "2026-03-11", expenseCategoryCode: "travel_transportation" }),
    ],
    H,
  );
  assert.equal(candidates.length, 0);
});

test("detection boost: eligible-category line AT homebase is neither anchor nor boost", () => {
  // "東京 Ekinet" carries a homebase signal → not a trip line. Only the anchor
  // remains → 1 line → no candidate.
  const candidates = detectBusinessTripCandidates(
    [
      line({ id: "anchor", merchant: "大阪ホテル", transactionDate: "2026-03-10" }),
      line({ id: "home", merchant: "東京 Ekinet", transactionDate: "2026-03-11", expenseCategoryCode: "travel_transportation" }),
    ],
    H,
  );
  assert.equal(candidates.length, 0);
});

test("detection window edges: boost at 7d joins, at 8d does not", () => {
  const within = detectBusinessTripCandidates(
    [
      line({ id: "a", merchant: "大阪ホテル", transactionDate: "2026-03-10" }),
      line({ id: "b", merchant: "Ekinet", transactionDate: "2026-03-17", expenseCategoryCode: "travel_transportation" }),
    ],
    H,
  );
  assert.equal(within.length, 1);

  const beyond = detectBusinessTripCandidates(
    [
      line({ id: "a", merchant: "大阪ホテル", transactionDate: "2026-03-10" }),
      line({ id: "b", merchant: "Ekinet", transactionDate: "2026-03-18", expenseCategoryCode: "travel_transportation" }),
    ],
    H,
  );
  assert.equal(beyond.length, 0); // anchor alone < 2 lines
});

// ─── Dedupe overlap helper ───────────────────────────────────────────────────

test("rangesOverlap: inclusive, shared boundary counts as overlap", () => {
  assert.equal(rangesOverlap({ start: "2026-03-01", end: "2026-03-10" }, { start: "2026-03-05", end: "2026-03-15" }), true);
  assert.equal(rangesOverlap({ start: "2026-03-01", end: "2026-03-10" }, { start: "2026-03-11", end: "2026-03-20" }), false);
  assert.equal(rangesOverlap({ start: "2026-03-01", end: "2026-03-10" }, { start: "2026-03-10", end: "2026-03-20" }), true);
});

test("unionRange: min start, max end", () => {
  assert.deepEqual(
    unionRange({ start: "2026-03-05", end: "2026-03-12" }, { start: "2026-03-01", end: "2026-03-10" }),
    { start: "2026-03-01", end: "2026-03-12" },
  );
});

test("findOverlappingTrip: same cardholder + overlap + candidate|confirmed; ignores others", () => {
  const existing: ExistingTrip[] = [
    { id: "t1", cardholder_name: "David", start_date: "2026-03-01", end_date: "2026-03-10", status: "candidate" },
    { id: "t3", cardholder_name: "Alice", start_date: "2026-03-05", end_date: "2026-03-09", status: "candidate" }, // other cardholder
    { id: "t4", cardholder_name: "David", start_date: "2026-03-05", end_date: "2026-03-09", status: "rejected" }, // rejected
    { id: "t5", cardholder_name: "David", start_date: "2026-03-05", end_date: "2026-03-09", status: "exported" }, // exported
  ];
  const m = findOverlappingTrip({ cardholderName: "David", startDate: "2026-03-05", endDate: "2026-03-07" }, existing);
  assert.equal(m?.id, "t1");
  assert.equal(
    findOverlappingTrip({ cardholderName: "David", startDate: "2026-05-01", endDate: "2026-05-02" }, existing),
    null,
  );
});

test("decideWiden: widen candidate only; skip confirmed; none when contained", () => {
  const cand = { startDate: "2026-03-05", endDate: "2026-03-12" };
  assert.deepEqual(
    decideWiden({ id: "t", cardholder_name: "D", start_date: "2026-03-01", end_date: "2026-03-10", status: "candidate" }, cand),
    { kind: "widen", range: { start: "2026-03-01", end: "2026-03-12" } },
  );
  assert.deepEqual(
    decideWiden({ id: "t", cardholder_name: "D", start_date: "2026-03-01", end_date: "2026-03-10", status: "confirmed" }, cand),
    { kind: "skip" },
  );
  assert.deepEqual(
    decideWiden({ id: "t", cardholder_name: "D", start_date: "2026-03-01", end_date: "2026-03-20", status: "candidate" }, cand),
    { kind: "none" },
  );
});

// ─── Status sync (ADR 0010 D4) ───────────────────────────────────────────────

test("computeTripStatusLineUpdates: confirm keeps tripId; reject nulls + excluded", () => {
  assert.deepEqual(
    computeTripStatusLineUpdates("trip-1", ["l1", "l2"], "confirmed"),
    [
      { lineId: "l1", businessTripId: "trip-1", businessTripStatus: "confirmed" },
      { lineId: "l2", businessTripId: "trip-1", businessTripStatus: "confirmed" },
    ],
  );
  assert.deepEqual(
    computeTripStatusLineUpdates("trip-1", ["l1", "l2"], "rejected"),
    [
      { lineId: "l1", businessTripId: null, businessTripStatus: "excluded" },
      { lineId: "l2", businessTripId: null, businessTripStatus: "excluded" },
    ],
  );
});

// ─── Trip input / transition validation ──────────────────────────────────────

test("validateTripDates: format + start<=end ordering", () => {
  assert.equal(validateTripDates("2026-03-01", "2026-03-10").ok, true);
  assert.equal(validateTripDates("2026-03-10", "2026-03-01").ok, false); // start > end
  assert.equal(validateTripDates("2026-3-1", "2026-03-10").ok, false); // bad format
  assert.equal(validateTripDates("", "").ok, false);
});

test("validateTripTransition: exported rejected; candidate/confirmed transitions allowed; bad value rejected", () => {
  assert.equal(validateTripTransition("exported", "confirmed").ok, false); // 409 case
  assert.equal(validateTripTransition("candidate", "confirmed").ok, true);
  assert.equal(validateTripTransition("confirmed", "rejected").ok, true);
  assert.equal(validateTripTransition("candidate", "exported").ok, false); // only confirmed/rejected
});

// ─── Picker window/date arithmetic (ADR 0010 D2) ─────────────────────────────

test("shiftDate: adds/subtracts days, crosses month/year boundaries", () => {
  assert.equal(shiftDate("2026-03-10", 5), "2026-03-15");
  assert.equal(shiftDate("2026-03-31", 1), "2026-04-01"); // month boundary
  assert.equal(shiftDate("2026-01-01", -1), "2025-12-31"); // year boundary
  assert.equal(shiftDate("2026-03-10", -45), "2026-01-24");
});

test("candidateWindow: [start − windowDays, end + windowDays]", () => {
  assert.deepEqual(
    candidateWindow({ startDate: "2026-06-10", endDate: "2026-06-15" }, 45),
    { start: "2026-04-26", end: "2026-07-30" }, // spans Apr–Jul (cross-month)
  );
});

test("isInCandidateWindow: inclusive boundaries", () => {
  const w = { start: "2026-04-26", end: "2026-07-30" };
  assert.equal(isInCandidateWindow("2026-04-26", w), true); // start edge
  assert.equal(isInCandidateWindow("2026-07-30", w), true); // end edge
  assert.equal(isInCandidateWindow("2026-06-10", w), true);
  assert.equal(isInCandidateWindow("2026-04-25", w), false); // just before
  assert.equal(isInCandidateWindow("2026-07-31", w), false); // just after
});

// ─── filterAttachCandidates: member exclusion + window + q + all ─────────────

function cand(over: Partial<CandidateRow> & { kind: "line" | "receipt"; id: string }): CandidateRow {
  return {
    transactionDate: "2026-06-10",
    merchant: "OpenAI",
    amountMinor: 1000,
    currency: "JPY",
    month: "2026-06",
    status: "confirmed",
    ownedByTripId: null,
    matchedReceiptId: null,
    paymentPath: null,
    ...over,
  };
}

test("filterAttachCandidates: excludes current members of this trip", () => {
  const rows = [
    cand({ kind: "line", id: "l-mem", merchant: "Member Line" }),
    cand({ kind: "receipt", id: "r-mem", merchant: "Member Receipt" }),
    cand({ kind: "line", id: "l-new", merchant: "New Line" }),
  ];
  const out = filterAttachCandidates(rows, {
    memberLineIds: new Set(["l-mem"]),
    memberReceiptIds: new Set(["r-mem"]),
    window: null,
    q: "",
  });
  assert.deepEqual(
    out.map((r) => r.id),
    ["l-new"],
  );
});

test("filterAttachCandidates: applies window (all=true passes null window)", () => {
  const rows = [
    cand({ kind: "line", id: "in", transactionDate: "2026-06-10" }),
    cand({ kind: "receipt", id: "out", transactionDate: "2025-01-01" }),
  ];
  const windowed = filterAttachCandidates(rows, {
    memberLineIds: new Set(),
    memberReceiptIds: new Set(),
    window: { start: "2026-04-26", end: "2026-07-30" },
    q: "",
  });
  assert.deepEqual(windowed.map((r) => r.id), ["in"]);

  const all = filterAttachCandidates(rows, {
    memberLineIds: new Set(),
    memberReceiptIds: new Set(),
    window: null, // "show all"
    q: "",
  });
  assert.equal(all.length, 2);
});

test("filterAttachCandidates: q filters merchant (case-insensitive)", () => {
  const rows = [
    cand({ kind: "line", id: "a", merchant: "Ekinet" }),
    cand({ kind: "receipt", id: "b", merchant: "Hotel Odawara" }),
  ];
  const out = filterAttachCandidates(rows, {
    memberLineIds: new Set(),
    memberReceiptIds: new Set(),
    window: null,
    q: "ekinet",
  });
  assert.deepEqual(out.map((r) => r.id), ["a"]);
});

// ─── dedupeChargeCandidates: fold a matched receipt into its line ────────────

test("dedupeChargeCandidates: a receipt matched to a line is dropped (same expense, one row)", () => {
  const rows = [
    cand({ kind: "line", id: "line-1", merchant: "Ekinet", matchedReceiptId: "rec-1" }),
    cand({ kind: "receipt", id: "rec-1", merchant: "Ekinet" }), // duplicate of line-1
    cand({ kind: "receipt", id: "rec-2", merchant: "駅弁", paymentPath: "CASH" }), // standalone cash
  ];
  const out = dedupeChargeCandidates(rows);
  assert.deepEqual(
    out.map((r) => r.id).sort(),
    ["line-1", "rec-2"],
  );
  // the surviving line row still carries the matched-receipt hint
  assert.equal(out.find((r) => r.id === "line-1")?.matchedReceiptId, "rec-1");
});

test("dedupeChargeCandidates: receipts with no matching line survive", () => {
  const rows = [
    cand({ kind: "line", id: "line-1", matchedReceiptId: "rec-1" }),
    cand({ kind: "receipt", id: "rec-2", paymentPath: "DIGITAL" }),
    cand({ kind: "receipt", id: "rec-3", paymentPath: "CASH" }),
  ];
  const out = dedupeChargeCandidates(rows);
  assert.deepEqual(
    out.map((r) => r.id).sort(),
    ["line-1", "rec-2", "rec-3"],
  );
});

// ─── candidateDisableReason (ownedByTripId flag) ─────────────────────────────

test("candidateDisableReason: different-trip owner → reason; same trip / receipt → null", () => {
  assert.equal(
    candidateDisableReason(cand({ kind: "line", id: "l1", ownedByTripId: "other-trip" }), "this-trip"),
    `Owned by another trip — detach it there first.`,
  );
  assert.equal(
    candidateDisableReason(cand({ kind: "line", id: "l1", ownedByTripId: "this-trip" }), "this-trip"),
    null,
  );
  assert.equal(
    candidateDisableReason(cand({ kind: "receipt", id: "r1", ownedByTripId: "other" }), "this-trip"),
    null, // receipts are never "owned" — attach is always allowed
  );
});

// ─── Pure UI helpers (trips screen) ──────────────────────────────────────────

test("filterTripsByTab: candidate/confirmed filtered; rejected only under all", () => {
  const trips = [
    { status: "candidate" },
    { status: "confirmed" },
    { status: "rejected" },
  ];
  assert.equal(filterTripsByTab(trips, "candidate").length, 1);
  assert.equal(filterTripsByTab(trips, "confirmed").length, 1);
  assert.equal(filterTripsByTab(trips, "all").length, 3);
});

test("tripStatusTone: candidate=amber, confirmed=green, rejected=gray, exported=blue", () => {
  assert.equal(tripStatusTone("candidate"), "amber");
  assert.equal(tripStatusTone("confirmed"), "green");
  assert.equal(tripStatusTone("rejected"), "gray");
  assert.equal(tripStatusTone("exported"), "blue");
});
