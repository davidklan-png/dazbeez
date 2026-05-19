import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { nowIso } from "@/lib/receipts/db-utils";
import type {
  ComplianceSettings,
  InvoiceNumberRequirementMode,
  PaperOriginalDiscardPolicy,
} from "@/lib/receipts/types";

export const COMPLIANCE_DEFAULTS: ComplianceSettings = {
  business_name: "",
  taxpayer_type: "kojin",
  retention_years: 7,
  require_attendees_for_meeting: true,
  require_attendees_for_entertainment: true,
  invoice_number_requirement_mode: "warning",
  export_block_on_warnings: false,
  paper_original_discard_policy: "retain_until_accountant_confirms",
  statement_expected_day: 18,
};

const INVOICE_MODES: ReadonlySet<InvoiceNumberRequirementMode> = new Set([
  "disabled",
  "warning",
  "blocker",
]);

const DISCARD_POLICIES: ReadonlySet<PaperOriginalDiscardPolicy> = new Set([
  "retain_until_accountant_confirms",
  "retain_indefinitely",
  "permit_discard_after_scan",
]);

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

function parseInt10(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function parseComplianceSettings(
  rows: Array<{ key: string; value: string }>,
): ComplianceSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const invoiceMode = map.get("invoice_number_requirement_mode");
  const discardPolicy = map.get("paper_original_discard_policy");
  return {
    business_name: map.get("business_name") ?? COMPLIANCE_DEFAULTS.business_name,
    taxpayer_type: map.get("taxpayer_type") ?? COMPLIANCE_DEFAULTS.taxpayer_type,
    retention_years: parseInt10(
      map.get("retention_years"),
      COMPLIANCE_DEFAULTS.retention_years,
    ),
    require_attendees_for_meeting: parseBool(
      map.get("require_attendees_for_meeting"),
      COMPLIANCE_DEFAULTS.require_attendees_for_meeting,
    ),
    require_attendees_for_entertainment: parseBool(
      map.get("require_attendees_for_entertainment"),
      COMPLIANCE_DEFAULTS.require_attendees_for_entertainment,
    ),
    invoice_number_requirement_mode:
      invoiceMode && INVOICE_MODES.has(invoiceMode as InvoiceNumberRequirementMode)
        ? (invoiceMode as InvoiceNumberRequirementMode)
        : COMPLIANCE_DEFAULTS.invoice_number_requirement_mode,
    export_block_on_warnings: parseBool(
      map.get("export_block_on_warnings"),
      COMPLIANCE_DEFAULTS.export_block_on_warnings,
    ),
    paper_original_discard_policy:
      discardPolicy && DISCARD_POLICIES.has(discardPolicy as PaperOriginalDiscardPolicy)
        ? (discardPolicy as PaperOriginalDiscardPolicy)
        : COMPLIANCE_DEFAULTS.paper_original_discard_policy,
    statement_expected_day: parseInt10(
      map.get("statement_expected_day"),
      COMPLIANCE_DEFAULTS.statement_expected_day,
    ),
  };
}

export async function getComplianceSettings(): Promise<ComplianceSettings> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(`SELECT key, value FROM receipt_settings`)
    .all<{ key: string; value: string }>();
  return parseComplianceSettings(result.results ?? []);
}

export async function updateComplianceSettings(
  updates: Partial<ComplianceSettings>,
  actor: string,
): Promise<ComplianceSettings> {
  const db = getReceiptsDb();
  const now = nowIso();
  const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
  for (const [key, value] of entries) {
    const stringValue =
      typeof value === "boolean" ? (value ? "true" : "false") : String(value);
    await db
      .prepare(
        `INSERT INTO receipt_settings (key, value, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(key, stringValue, now, actor)
      .run();
  }
  return getComplianceSettings();
}

// ─── Accountant review disclaimer ────────────────────────────────────────

export const ACCOUNTANT_DISCLAIMER_EN =
  "These records are preparation materials for accountant review. " +
  "Dazbeez does not provide tax advice or make final tax determinations. " +
  "Please confirm treatment with your tax accountant.";

export const ACCOUNTANT_DISCLAIMER_JA =
  "本資料は税理士による確認用の準備資料です。" +
  "Dazbeez は税務上の助言や最終的な税務判断を提供するものではありません。" +
  "最終的な取り扱いは税理士にご確認ください。";
