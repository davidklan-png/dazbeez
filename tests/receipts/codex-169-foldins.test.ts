import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { oneShotFinalizeDecision } from "@/lib/receipts/operator-message";

// Regression tests for the two Codex findings folded into #169.

// ─── §1: one-shot finalize must not bypass message_not_reviewed ────────────────
//
// The gate keys on operator_message_updated_at, which is NULL on a fresh draft.
// So the one-shot finalize caller must state the decision explicitly; the route
// writes it (setting the timestamp) THEN validates. oneShotFinalizeDecision is
// the pure require-check the route uses.

test("§1 one-shot: omitted operatorMessage ⇒ no decision (the route blocks, not silently bypasses)", () => {
  const d = oneShotFinalizeDecision(undefined);
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, "no-decision");
});

test("§1 one-shot: explicit text proceeds and is trimmed", () => {
  const d = oneShotFinalizeDecision("  今月は出張費が多めです。  ");
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(d.operatorMessage, "今月は出張費が多めです。");
});

test("§1 one-shot: null ⇒ explicit 'no message' (proceeds with NULL)", () => {
  // The chosen contract: operatorMessage: null means "no message this month" —
  // a real decision, distinct from omitted (undefined). The route writes the
  // timestamp with a NULL message, exactly as the "no message" UI control does.
  const d = oneShotFinalizeDecision(null);
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(d.operatorMessage, null);
});

test("§1 one-shot: empty string ⇒ also 'no message' (proceeds with NULL)", () => {
  const d = oneShotFinalizeDecision("");
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(d.operatorMessage, null);
});

test("§1 one-shot: the two decision forms (text vs none) are distinguishable from no-decision", () => {
  assert.equal(oneShotFinalizeDecision(undefined).ok, false);
  assert.equal(oneShotFinalizeDecision("text").ok, true);
  assert.equal(oneShotFinalizeDecision(null).ok, true);
  assert.equal(oneShotFinalizeDecision("").ok, true);
});

test("§1 route: the one-shot finalize path requires the decision (wired to oneShotFinalizeDecision)", () => {
  // Structural proof the route actually blocks (not just that the helper exists).
  // Fails against the pre-fix route, which validated before createExport with
  // exportBuild=null and let an undecided one-shot through.
  const src = readFileSync("app/api/receipts/export/month/route.ts", "utf8");
  assert.ok(
    /oneShotFinalizeDecision\(body\.operatorMessage\)/.test(src),
    "the finalize path decides from body.operatorMessage via oneShotFinalizeDecision",
  );
  assert.ok(
    /if \(!decision\.ok\)/.test(src),
    "the route returns 400 when no decision was supplied",
  );
  // And the decision is written before validate (sets the timestamp the gate reads).
  const writeIdx = src.indexOf("updateExportOperatorMessage(exportId, operatorMessage)");
  const validateIdx = src.indexOf("validateMonthReadyForExport(", writeIdx);
  assert.ok(writeIdx > -1 && validateIdx > writeIdx, "decision-write precedes validate on the finalize path");
});

// ─── §2: a verified save refreshes the server-rendered gate; a failed save does not ──
//
// PrefaceEditor is a client component; the repo deliberately uses no jsdom, so
// this is a STRUCTURAL source assertion (the capture-contract pattern): persist
// must call router.refresh(), and the call must sit AFTER the !res.ok early
// return so a failed/unverified save never triggers it. (A behavioral component
// test would require adding jsdom, which this codebase has chosen not to do.)

test("§2 preface save: router.refresh() is called, and only reachable on the verified-save (res.ok) path", () => {
  // Strip comment lines first so a comment mentioning router.refresh() can't
  // masquerade as the call (the same hole that let the June bug hide behind a
  // stale doc comment).
  const raw = readFileSync("components/receipts/export/preface-editor.tsx", "utf8");
  const src = raw
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
  const persistStart = src.indexOf("async function persist");
  assert.ok(persistStart >= 0, "persist() exists");
  // persist() runs up to the next const declaration (save / decideNoMessage).
  const persistBody = src.slice(
    persistStart,
    src.indexOf("const save", persistStart),
  );
  assert.ok(
    persistBody.includes("router.refresh()"),
    "a verified save must call router.refresh() so the server-rendered gate (message_not_reviewed → message_stale) updates",
  );
  // The refresh must be gated by the verified save — i.e. reached only AFTER the
  // `if (!res.ok) { … return }` early-return, never on the failure path.
  const notOkReturn = persistBody.indexOf("!res.ok");
  const refreshCall = persistBody.indexOf("router.refresh()");
  assert.ok(
    notOkReturn > -1 && refreshCall > notOkReturn,
    "router.refresh() must come after the !res.ok early-return (failed/unverified save must not refresh)",
  );
});
