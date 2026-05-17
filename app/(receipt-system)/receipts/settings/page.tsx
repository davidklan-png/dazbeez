import Link from "next/link";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";

export const dynamic = "force-dynamic";

export default async function ReceiptsSettingsPage() {
  await assertReceiptsPageAccess();

  return (
    <div className="space-y-6 px-8 py-8">
      <div>
        <h2 className="text-[26px] font-bold text-gray-900">Settings</h2>
        <p className="mt-1 text-sm text-gray-500">
          Category and export settings — coming in a future milestone.
        </p>
      </div>
      <ul className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        <li>
          <Link
            href="/receipts/settings/devices"
            className="flex items-center justify-between p-4 transition-colors hover:bg-amber-50"
          >
            <div>
              <p className="text-sm font-semibold text-gray-900">
                Trusted devices
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Skip the email login on devices you trust.
              </p>
            </div>
            <span className="text-sm text-amber-700">Manage →</span>
          </Link>
        </li>
      </ul>
    </div>
  );
}
