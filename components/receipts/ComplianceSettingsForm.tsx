"use client";

import { useState, useTransition } from "react";
import type { ComplianceSettings } from "@/lib/receipts/types";

type Props = { initial: ComplianceSettings };

const LABELS: Record<keyof ComplianceSettings, string> = {
  business_name: "Business name (事業者名)",
  taxpayer_type: "Taxpayer type",
  retention_years: "Retention years",
  require_attendees_for_meeting: "Require attendees for 会議費 (meetings)",
  require_attendees_for_entertainment: "Require attendees for 交際費 (entertainment)",
  invoice_number_requirement_mode: "Qualified-invoice number enforcement",
  export_block_on_warnings: "Block export when warnings are present",
  paper_original_discard_policy: "Paper original discard policy",
  statement_expected_day: "AMEX statement expected day",
};

export function ComplianceSettingsForm({ initial }: Props) {
  const [settings, setSettings] = useState<ComplianceSettings>(initial);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function update<K extends keyof ComplianceSettings>(
    key: K,
    value: ComplianceSettings[K],
  ) {
    setSettings((s) => ({ ...s, [key]: value }));
  }

  async function save() {
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/receipts/settings/compliance", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Save failed (${res.status}).`);
        return;
      }
      const data = (await res.json()) as { settings: ComplianceSettings };
      setSettings(data.settings);
      setSavedAt(new Date().toLocaleTimeString());
    });
  }

  return (
    <div className="space-y-5 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <Row label={LABELS.business_name}>
        <input
          type="text"
          value={settings.business_name}
          onChange={(e) => update("business_name", e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          maxLength={120}
        />
      </Row>

      <Row label={LABELS.taxpayer_type}>
        <select
          value={settings.taxpayer_type}
          onChange={(e) => update("taxpayer_type", e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="kojin">個人事業主 (sole proprietor)</option>
          <option value="hojin">法人 (corporation)</option>
          <option value="other">その他 / other</option>
        </select>
      </Row>

      <Row label={LABELS.retention_years} hint="7 years is the typical minimum; some categories require 10.">
        <input
          type="number"
          min={1}
          max={20}
          value={settings.retention_years}
          onChange={(e) =>
            update("retention_years", Number.parseInt(e.target.value, 10) || 1)
          }
          className="w-24 rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
      </Row>

      <Row label={LABELS.require_attendees_for_meeting}>
        <Toggle
          checked={settings.require_attendees_for_meeting}
          onChange={(v) => update("require_attendees_for_meeting", v)}
        />
      </Row>

      <Row label={LABELS.require_attendees_for_entertainment}>
        <Toggle
          checked={settings.require_attendees_for_entertainment}
          onChange={(v) => update("require_attendees_for_entertainment", v)}
        />
      </Row>

      <Row
        label={LABELS.invoice_number_requirement_mode}
        hint="warning = surface as warning; blocker = block export; disabled = ignore."
      >
        <select
          value={settings.invoice_number_requirement_mode}
          onChange={(e) =>
            update(
              "invoice_number_requirement_mode",
              e.target.value as ComplianceSettings["invoice_number_requirement_mode"],
            )
          }
          className="rounded-md border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="warning">warning (recommended)</option>
          <option value="blocker">blocker</option>
          <option value="disabled">disabled</option>
        </select>
      </Row>

      <Row label={LABELS.export_block_on_warnings}>
        <Toggle
          checked={settings.export_block_on_warnings}
          onChange={(v) => update("export_block_on_warnings", v)}
        />
      </Row>

      <Row
        label={LABELS.paper_original_discard_policy}
        hint="Dazbeez does not authorize discarding paper originals. Confirm with your accountant first."
      >
        <select
          value={settings.paper_original_discard_policy}
          onChange={(e) =>
            update(
              "paper_original_discard_policy",
              e.target.value as ComplianceSettings["paper_original_discard_policy"],
            )
          }
          className="rounded-md border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="retain_until_accountant_confirms">
            Retain until accountant confirms (recommended)
          </option>
          <option value="retain_indefinitely">Retain indefinitely</option>
          <option value="permit_discard_after_scan">
            Permit discard after scan (only with accountant policy)
          </option>
        </select>
      </Row>

      <Row label={LABELS.statement_expected_day}>
        <input
          type="number"
          min={1}
          max={31}
          value={settings.statement_expected_day}
          onChange={(e) =>
            update(
              "statement_expected_day",
              Number.parseInt(e.target.value, 10) || 1,
            )
          }
          className="w-24 rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
      </Row>

      <div className="flex items-center justify-between border-t border-gray-100 pt-4">
        <div className="text-xs text-gray-500">
          {error ? (
            <span className="text-red-600">{error}</span>
          ) : savedAt ? (
            <span>Saved at {savedAt}</span>
          ) : (
            <span>Changes are saved when you click Save.</span>
          )}
        </div>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-md bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="sm:max-w-md">
        <div className="text-sm font-medium text-gray-900">{label}</div>
        {hint ? <div className="text-xs text-gray-500">{hint}</div> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        checked ? "bg-amber-500" : "bg-gray-300"
      }`}
      aria-pressed={checked}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}
