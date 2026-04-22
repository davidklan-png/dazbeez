import type { Metadata } from "next";
import {
  updateIntegrationSettingsAction,
  updateProfileSettingsAction,
  updateThresholdSettingsAction,
} from "@/app/admin/crm-actions";
import { getCrmIntegrations, getCrmThresholds, getDazbeezProfile } from "@/lib/crm";

export const metadata: Metadata = {
  title: "Settings — Dazbeez Admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function JsonEditor({
  title,
  description,
  value,
  action,
}: {
  title: string;
  description: string;
  value: unknown;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={action} className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
      <p className="mt-2 text-sm text-gray-500">{description}</p>
      <textarea
        name="payload"
        defaultValue={JSON.stringify(value, null, 2)}
        rows={18}
        className="mt-4 block w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-4 font-mono text-xs leading-6 text-gray-900"
      />
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-gray-500">Save valid JSON only.</p>
        <button
          type="submit"
          className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600"
        >
          Save settings
        </button>
      </div>
    </form>
  );
}

export default async function AdminSettingsPage() {
  const [profile, thresholds, integrations] = await Promise.all([
    getDazbeezProfile(),
    getCrmThresholds(),
    getCrmIntegrations(),
  ]);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-2xl font-semibold text-gray-900">Settings</h2>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-gray-500">
          Edit the Dazbeez profile used for fit analysis and drafts, tune confidence thresholds, and document which
          provider strategy the CRM is using. Provider secrets remain environment-backed and are not stored in the
          database.
        </p>
      </section>

      <JsonEditor
        title="David / Dazbeez profile"
        description="Used for synergy scoring and follow-up drafting."
        value={profile}
        action={updateProfileSettingsAction}
      />

      <JsonEditor
        title="Confidence thresholds"
        description="Controls when OCR and dedupe results get routed into review."
        value={thresholds}
        action={updateThresholdSettingsAction}
      />

      <JsonEditor
        title="Integration strategy"
        description="Provider selection, notification flags, and operational configuration notes."
        value={integrations}
        action={updateIntegrationSettingsAction}
      />
    </div>
  );
}
