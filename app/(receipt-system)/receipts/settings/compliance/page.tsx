import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import {
  getComplianceSettings,
  ACCOUNTANT_DISCLAIMER_EN,
  ACCOUNTANT_DISCLAIMER_JA,
} from "@/lib/receipts/settings";
import { ComplianceSettingsForm } from "@/components/receipts/ComplianceSettingsForm";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ComplianceSettingsPage() {
  await assertReceiptsPageAccess();
  const settings = await getComplianceSettings();

  return (
    <div className="space-y-6 px-8 py-8">
      <div className="flex items-baseline justify-between">
        <div>
          <Link
            href="/receipts/settings"
            className="text-xs text-amber-700 hover:underline"
          >
            ← Settings
          </Link>
          <h2 className="mt-2 text-[26px] font-bold text-gray-900">
            Compliance &amp; 税務 settings
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Configure preservation, qualified-invoice, and attendee rules. These
            apply to all receipts and exports.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">Accountant review boundary</p>
        <p className="mt-1">{ACCOUNTANT_DISCLAIMER_EN}</p>
        <p className="mt-2 text-amber-800">{ACCOUNTANT_DISCLAIMER_JA}</p>
      </div>

      <ComplianceSettingsForm initial={settings} />
    </div>
  );
}
