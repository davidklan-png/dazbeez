// Tests for the capture-pipeline health surface (lib/receipts/pipeline-health.ts).
//
// Three pure surfaces: summarizePipelineHealth (formatting/ordering),
// buildPipelineClassQuery (the class predicates — needs_render exclusions,
// strict age thresholds, failed-row handling), and buildPipelineDetailQuery
// (per-receipt detail rows). The D1 runner getPipelineHealth is verified live
// (Step 4 + the class-1/4 = 0 confirmation).

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPipelineClassQuery,
  buildPipelineDetailQuery,
  formatAge,
  summarizePipelineHealth,
  type PipelineClassSignal,
} from "@/lib/receipts/pipeline-health";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const sig = (count: number, oldestAgeMs: number | null): PipelineClassSignal => ({
  count,
  oldestAgeMs,
});

const CLEAR = {
  neverEnqueued: sig(0, null),
  consumerStalled: sig(0, null),
  renderStalled: sig(0, null),
  missingManifest: sig(0, null),
  renderFailed: sig(0, null),
  extractionFailed: sig(0, null),
};

// ─── summarizePipelineHealth ────────────────────────────────────────────────

test("summarizePipelineHealth: all clear → ok, nothing lit", () => {
  const h = summarizePipelineHealth(CLEAR);
  assert.equal(h.ok, true);
  assert.deepEqual(h.lit, []);
});

test("summarizePipelineHealth: class 1 (never_enqueued) lit → error + actionable summary with age", () => {
  const h = summarizePipelineHealth({ ...CLEAR, neverEnqueued: sig(3, 6 * DAY) });
  assert.equal(h.ok, false);
  assert.equal(h.lit.length, 1);
  const c = h.lit[0]!;
  assert.equal(c.kind, "never_enqueued");
  assert.equal(c.severity, "error");
  assert.equal(c.count, 3);
  assert.match(c.summary, /3 receipts will never be processed/);
  assert.match(c.summary, /oldest 6d/);
});

test("summarizePipelineHealth: class 2 (consumer_stalled) lit → warn", () => {
  const h = summarizePipelineHealth({ ...CLEAR, consumerStalled: sig(2, 25 * MIN) });
  assert.equal(h.lit[0]!.kind, "consumer_stalled");
  assert.equal(h.lit[0]!.severity, "warn");
  assert.match(h.lit[0]!.summary, /stalled consumer/);
  assert.match(h.lit[0]!.summary, /oldest 25m/);
});

test("summarizePipelineHealth: class 3 (render_stalled) lit → warn", () => {
  const h = summarizePipelineHealth({ ...CLEAR, renderStalled: sig(1, 40 * MIN) });
  assert.equal(h.lit[0]!.kind, "render_stalled");
  assert.equal(h.lit[0]!.severity, "warn");
  assert.match(h.lit[0]!.summary, /stalled render leg/);
});

test("summarizePipelineHealth: class 4 (missing_manifest) lit → error + finalize note", () => {
  const h = summarizePipelineHealth({ ...CLEAR, missingManifest: sig(5, 2 * DAY) });
  assert.equal(h.lit[0]!.kind, "missing_manifest");
  assert.equal(h.lit[0]!.severity, "error");
  assert.match(h.lit[0]!.summary, /missing their manifest row/);
  assert.match(h.lit[0]!.summary, /blocks finalize/);
});

test("summarizePipelineHealth: errors sort before warns", () => {
  const h = summarizePipelineHealth({
    ...CLEAR,
    consumerStalled: sig(2, 25 * MIN), // warn
    renderStalled: sig(1, 40 * MIN), // warn
    missingManifest: sig(1, null), // error, no age
  });
  assert.equal(h.ok, false);
  assert.equal(h.lit.length, 3);
  assert.equal(h.lit[0]!.severity, "error"); // missing_manifest first
  assert.equal(h.lit[0]!.kind, "missing_manifest");
  assert.equal(h.lit[1]!.severity, "warn");
  assert.equal(h.lit[2]!.severity, "warn");
});

test("summarizePipelineHealth: count 0 with a stale age is still NOT lit", () => {
  // Defensive: a signal of count 0 must never light, even if oldestAgeMs is set.
  const h = summarizePipelineHealth({ ...CLEAR, consumerStalled: sig(0, 99 * DAY) });
  assert.equal(h.ok, true);
});

// ─── terminal failure classes (backlog #22) ─────────────────────────────────

test("summarizePipelineHealth: render_failed lit → error + terminal summary with age", () => {
  const h = summarizePipelineHealth({ ...CLEAR, renderFailed: sig(2, 3 * DAY) });
  assert.equal(h.ok, false);
  const c = h.lit[0]!;
  assert.equal(c.kind, "render_failed");
  assert.equal(c.severity, "error");
  assert.match(c.summary, /2 email-body receipts failed rendering permanently/);
  assert.match(c.summary, /terminal/);
  assert.match(c.summary, /oldest 3d/);
});

test("summarizePipelineHealth: extraction_failed lit → error + terminal summary", () => {
  const h = summarizePipelineHealth({ ...CLEAR, extractionFailed: sig(1, 40 * MIN) });
  assert.equal(h.lit[0]!.kind, "extraction_failed");
  assert.equal(h.lit[0]!.severity, "error");
  assert.match(h.lit[0]!.summary, /failed extraction permanently/);
});

test("summarizePipelineHealth: terminal failures are errors and sort before stall warns", () => {
  const h = summarizePipelineHealth({
    ...CLEAR,
    consumerStalled: sig(1, 30 * MIN),
    renderFailed: sig(1, null),
  });
  assert.equal(h.lit[0]!.severity, "error");
  assert.equal(h.lit[0]!.kind, "render_failed");
  assert.equal(h.lit[1]!.kind, "consumer_stalled");
});

// ─── buildPipelineClassQuery (the predicates) ───────────────────────────────

test("class 1 (never_enqueued): excludes needs_render rows (awaiting render)", () => {
  const q = buildPipelineClassQuery("never_enqueued", "STALE");
  assert.deepEqual(q.bindings, []);
  assert.match(q.sql, /extraction_state = 'captured'/);
  assert.match(q.sql, /extraction_enqueued_at IS NULL/);
  // The whole point: a needs_render=1 row must NOT count as class 1.
  assert.match(q.sql, /needs_render = 0/);
  assert.doesNotMatch(q.sql, /needs_render = 1/);
});

test("class 2 (consumer_stalled): requires enqueued_at + strict < threshold (boundary)", () => {
  const q = buildPipelineClassQuery("consumer_stalled", "STALE_ISO");
  assert.deepEqual(q.bindings, ["STALE_ISO"]);
  // Disjoint from class 1: this requires enqueued_at NOT NULL.
  assert.match(q.sql, /extraction_enqueued_at IS NOT NULL/);
  // Strict <: a receipt exactly AT the threshold is NOT stalled.
  assert.match(q.sql, /extraction_enqueued_at < \?/);
  assert.doesNotMatch(q.sql, /<=/);
  // And it never keys on needs_render (class 2 is about the consumer, not render).
  assert.doesNotMatch(q.sql, /needs_render/);
});

test("class 3 (render_stalled): needs_render=1 + strict < threshold", () => {
  const q = buildPipelineClassQuery("render_stalled", "STALE_ISO");
  assert.deepEqual(q.bindings, ["STALE_ISO"]);
  assert.match(q.sql, /needs_render = 1/);
  assert.match(q.sql, /captured_at < \?/);
  assert.doesNotMatch(q.sql, /<=/);
});

test("class 3 (render_stalled): excludes terminal render failures (not stalled)", () => {
  const q = buildPipelineClassQuery("render_stalled", "STALE_ISO");
  // A render_failed row (needs_render=1 AND extraction_state='failed') is
  // TERMINAL, not stalled — it has its own class and its own recovery.
  assert.match(q.sql, /extraction_state IS NULL OR extraction_state != 'failed'/);
});

test("class 5 (render_failed): failed state + needs_render=1 discriminator", () => {
  const q = buildPipelineClassQuery("render_failed", "STALE");
  assert.deepEqual(q.bindings, []);
  assert.match(q.sql, /extraction_state = 'failed'/);
  assert.match(q.sql, /needs_render = 1/);
  // Ages from when it went terminal, not captured_at.
  assert.match(q.sql, /MIN\(extraction_processed_at\)/);
});

test("class 6 (extraction_failed): failed state + needs_render=0/NULL discriminator", () => {
  const q = buildPipelineClassQuery("extraction_failed", "STALE");
  assert.deepEqual(q.bindings, []);
  assert.match(q.sql, /extraction_state = 'failed'/);
  assert.match(q.sql, /needs_render = 0 OR needs_render IS NULL/);
});

test("class 5 and class 6 are disjoint on needs_render (no row counts as both)", () => {
  const c5 = buildPipelineClassQuery("render_failed", "x").sql;
  const c6 = buildPipelineClassQuery("extraction_failed", "x").sql;
  assert.match(c5, /needs_render = 1/);
  assert.match(c6, /needs_render = 0/);
  // And neither overlaps class 3 (which excludes failed rows entirely).
  const c3 = buildPipelineClassQuery("render_stalled", "x").sql;
  assert.match(c3, /!= 'failed'/);
});

// ─── buildPipelineDetailQuery (per-receipt rows) ─────────────────────────────

test("detail queries: every detail kind filters deleted rows and is bounded", () => {
  const kinds = [
    "never_enqueued",
    "consumer_stalled",
    "render_stalled",
    "render_failed",
    "extraction_failed",
  ] as const;
  for (const kind of kinds) {
    const q = buildPipelineDetailQuery(kind, "STALE_ISO");
    assert.match(q.sql, /deleted_at IS NULL/);
    assert.match(q.sql, /LIMIT 50/);
    assert.match(q.sql, /ORDER BY/);
  }
});

test("detail queries: the terminal classes key on the failed-state predicate", () => {
  const rf = buildPipelineDetailQuery("render_failed", "S").sql;
  assert.match(rf, /extraction_state = 'failed'/);
  assert.match(rf, /needs_render = 1/);
  const ef = buildPipelineDetailQuery("extraction_failed", "S").sql;
  assert.match(ef, /extraction_state = 'failed'/);
  assert.match(ef, /needs_render = 0 OR needs_render IS NULL/);
  // Stalled render detail rows exclude terminal failures (same as class 3).
  const rs = buildPipelineDetailQuery("render_stalled", "S").sql;
  assert.match(rs, /!= 'failed'/);
});

test("detail query: render_failed ages from extraction_processed_at, consumer_stalled from enqueued_at", () => {
  const renderFailed = buildPipelineDetailQuery("render_failed", "S").sql;
  assert.match(renderFailed, /ORDER BY extraction_processed_at ASC/);
  const stalled = buildPipelineDetailQuery("consumer_stalled", "S");
  assert.match(stalled.sql, /extraction_enqueued_at < \?/);
  assert.deepEqual(stalled.bindings, ["S"]);
  assert.match(stalled.sql, /ORDER BY extraction_enqueued_at ASC/);
});

test("class 1 and class 3 are disjoint on needs_render (no row counts as both)", () => {
  const c1 = buildPipelineClassQuery("never_enqueued", "x").sql;
  const c3 = buildPipelineClassQuery("render_stalled", "x").sql;
  assert.match(c1, /needs_render = 0/);
  assert.match(c3, /needs_render = 1/);
});

test("class 4 (missing_manifest): original_r2_key set + NOT EXISTS receipt_files", () => {
  const q = buildPipelineClassQuery("missing_manifest", "STALE");
  assert.deepEqual(q.bindings, []);
  assert.match(q.sql, /original_r2_key IS NOT NULL/);
  assert.match(q.sql, /NOT EXISTS/);
  assert.match(q.sql, /receipt_files/);
});

// ─── formatAge ───────────────────────────────────────────────────────────────

test("formatAge: minute / hour / day boundaries", () => {
  assert.equal(formatAge(0), "0m");
  assert.equal(formatAge(12 * MIN), "12m");
  assert.equal(formatAge(59 * MIN), "59m");
  assert.equal(formatAge(3 * HOUR), "3h");
  assert.equal(formatAge(23 * HOUR), "23h");
  assert.equal(formatAge(6 * DAY), "6d");
});
