import test from "node:test";
import assert from "node:assert/strict";
import {
  parseComplianceSettings,
  COMPLIANCE_DEFAULTS,
} from "@/lib/receipts/settings";

test("settings: empty rows produce all defaults", () => {
  const settings = parseComplianceSettings([]);
  assert.deepEqual(settings, COMPLIANCE_DEFAULTS);
});

test("settings: explicit values override defaults", () => {
  const settings = parseComplianceSettings([
    { key: "retention_years", value: "10" },
    { key: "require_attendees_for_meeting", value: "false" },
    { key: "invoice_number_requirement_mode", value: "blocker" },
  ]);
  assert.equal(settings.retention_years, 10);
  assert.equal(settings.require_attendees_for_meeting, false);
  assert.equal(settings.invoice_number_requirement_mode, "blocker");
  // Untouched keys keep their defaults.
  assert.equal(
    settings.paper_original_discard_policy,
    COMPLIANCE_DEFAULTS.paper_original_discard_policy,
  );
});

test("settings: invalid enum value falls back to default", () => {
  const settings = parseComplianceSettings([
    { key: "invoice_number_requirement_mode", value: "yolo" },
    { key: "paper_original_discard_policy", value: "burn_it" },
  ]);
  assert.equal(
    settings.invoice_number_requirement_mode,
    COMPLIANCE_DEFAULTS.invoice_number_requirement_mode,
  );
  assert.equal(
    settings.paper_original_discard_policy,
    COMPLIANCE_DEFAULTS.paper_original_discard_policy,
  );
});

test("settings: malformed integer falls back to default", () => {
  const settings = parseComplianceSettings([
    { key: "retention_years", value: "not-a-number" },
    { key: "statement_expected_day", value: "" },
  ]);
  assert.equal(
    settings.retention_years,
    COMPLIANCE_DEFAULTS.retention_years,
  );
  assert.equal(
    settings.statement_expected_day,
    COMPLIANCE_DEFAULTS.statement_expected_day,
  );
});

test("settings: bool parsing accepts true/false/1/0", () => {
  const settings = parseComplianceSettings([
    { key: "require_attendees_for_meeting", value: "1" },
    { key: "require_attendees_for_entertainment", value: "0" },
    { key: "export_block_on_warnings", value: "true" },
  ]);
  assert.equal(settings.require_attendees_for_meeting, true);
  assert.equal(settings.require_attendees_for_entertainment, false);
  assert.equal(settings.export_block_on_warnings, true);
});
