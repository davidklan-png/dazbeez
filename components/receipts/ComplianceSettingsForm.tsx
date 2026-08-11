"use client";

import { useState, useTransition } from "react";
import type { ComplianceSettings } from "@/lib/receipts/types";

/** Mirrors resolveNotificationRecipient's return (lib/receipts/notify.ts).
 *  Defined locally to avoid pulling server-only imports into the client bundle. */
type EffectiveRecipient = {
  email: string | null;
  source: "settings" | "fallback" | null;
};

type TestResult = { ok: true } | { ok: false; error: string };

type Props = {
  initial: ComplianceSettings;
  effectiveRecipient: EffectiveRecipient;
};

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
  track_tax_breakdown: "Track tax rate / amount breakdown",
  notification_recipient: "通知先 (Notification recipient)",
  notification_cc_recipient: "CC (Business manager / Cc recipient)",
  delivery_signature: "配信メール署名 (Delivery email signature)",
  homebase_signals: "Homebase signals (ADR 0010)",
};

export function ComplianceSettingsForm({
  initial,
  effectiveRecipient,
}: Props) {
  const [settings, setSettings] = useState<ComplianceSettings>(initial);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [effective, setEffective] = useState<EffectiveRecipient>(effectiveRecipient);
  const [persistedRecipient, setPersistedRecipient] = useState(
    initial.notification_recipient,
  );
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  // homebase_signals is edited as a textarea (one signal per line). Keep the
  // raw text for editing; mirror the parsed array into settings.homebase_signals
  // so Save serializes it (Phase A serializer JSON-stringifies arrays).
  const [homebaseText, setHomebaseText] = useState(
    initial.homebase_signals.join("\n"),
  );

  const recipientDirty = settings.notification_recipient !== persistedRecipient;

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
      const data = (await res.json()) as {
        settings: ComplianceSettings;
        effectiveRecipient: EffectiveRecipient;
      };
      setSettings(data.settings);
      setEffective(data.effectiveRecipient);
      setPersistedRecipient(data.settings.notification_recipient);
      setSavedAt(new Date().toLocaleTimeString());
    });
  }

  // Exercises the full Resend path (compose + send) against the PERSISTED
  // recipient without finalizing. Disabled while the field is dirty so the test
  // always reflects saved config — the endpoint reads Settings, not this input.
  async function sendTest() {
    setTestResult(null);
    setTesting(true);
    try {
      const res = await fetch("/api/receipts/notify/test", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (data.ok === true) {
        setTestResult({ ok: true });
      } else {
        setTestResult({
          ok: false,
          error: data.error ?? `テスト送信に失敗しました (HTTP ${res.status})。`,
        });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
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

      <Row
        label={LABELS.track_tax_breakdown}
        hint="Off by default — most JP receipts declare tax-included totals only. Turn on to warn when tax rate / amount are missing."
      >
        <Toggle
          checked={settings.track_tax_breakdown}
          onChange={(v) => update("track_tax_breakdown", v)}
        />
      </Row>

      <Row
        label={LABELS.notification_recipient}
        hint="月次確定通知の送信先。空欄なら ACCOUNTANT_EMAIL フォールバックを使用します。"
      >
        <div className="flex w-full flex-col gap-2 sm:w-80">
          <div className="flex gap-2">
            <input
              type="email"
              value={settings.notification_recipient}
              onChange={(e) => update("notification_recipient", e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
              maxLength={160}
              placeholder="accountant@example.com"
            />
            <button
              type="button"
              onClick={sendTest}
              disabled={pending || testing || recipientDirty}
              className="shrink-0 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              title={
                recipientDirty
                  ? "まず Save してください（テスト送信は保存済み設定を使用します）"
                  : undefined
              }
            >
              {testing ? "送信中…" : "テスト送信"}
            </button>
          </div>

          <EffectiveRecipientLine effective={effective} />

          {testResult ? (
            <p
              className={`text-xs ${
                testResult.ok ? "text-green-700" : "text-red-600"
              }`}
            >
              {testResult.ok
                ? "テスト送信: 成功 — 送信先の受信トレイを確認してください。"
                : `テスト送信: 失敗 — ${testResult.error}`}
            </p>
          ) : null}
        </div>
      </Row>

      <Row
        label={LABELS.delivery_signature}
        hint="配信メールの末尾（「ご不明な点があればお知らせください。」の後）に追加される署名です。確定した封筒内の通知には含まれません（送信メールのみ）。空欄なら追加されません。"
      >
        <textarea
          value={settings.delivery_signature}
          onChange={(e) => update("delivery_signature", e.target.value)}
          rows={4}
          maxLength={1000}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm sm:w-96"
          placeholder={"山田 太郎\nDazbeez合同会社\neditor@dazbeez.com"}
        />
        <p className="mt-1 text-[11px] text-gray-400">
          {settings.delivery_signature.length}/1000
        </p>
      </Row>

      <Row
        label={LABELS.homebase_signals}
        hint="Merchant name fragments that indicate homebase (charges here never anchor a business trip). One per line."
      >
        <textarea
          value={homebaseText}
          onChange={(e) => {
            const text = e.target.value;
            setHomebaseText(text);
            update(
              "homebase_signals",
              text
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            );
          }}
          rows={5}
          className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm sm:w-96"
          placeholder={"東京\n新宿\n渋谷"}
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

function EffectiveRecipientLine({
  effective,
}: {
  effective: EffectiveRecipient;
}) {
  if (effective.source === "settings") {
    return (
      <p className="text-xs text-gray-600">
        有効な送信先:{" "}
        <span className="font-medium text-gray-900">{effective.email}</span>{" "}
        <span className="text-gray-400">（Settings で設定）</span>
      </p>
    );
  }
  if (effective.source === "fallback") {
    return (
      <p className="text-xs text-gray-600">
        有効な送信先:{" "}
        <span className="font-medium text-gray-900">{effective.email}</span>{" "}
        <span className="text-gray-400">
          （フォールバック: ACCOUNTANT_EMAIL）
        </span>
      </p>
    );
  }
  return (
    <p className="text-xs text-amber-700">
      送信先が未設定 — 確定通知は送信されません（{`{ok: false}`}）。
    </p>
  );
}
