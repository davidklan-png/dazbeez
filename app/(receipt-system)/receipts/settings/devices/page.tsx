import type { Metadata } from "next";
import { headers } from "next/headers";
import {
  assertReceiptsAccessFromHeaders,
  getReceiptsActor,
} from "@/lib/receipts/auth";
import {
  listDevicesForActor,
  getCurrentDeviceId,
} from "@/lib/receipts/trusted-devices";
import { DeviceList } from "@/components/receipts/device-list";

export const metadata: Metadata = {
  title: "Trusted devices — Receipts",
  robots: { index: false, follow: false },
};

export default async function DevicesPage() {
  const requestHeaders = await headers();
  await assertReceiptsAccessFromHeaders(requestHeaders);
  const actor = await getReceiptsActor(requestHeaders);
  const devices = await listDevicesForActor(actor);
  const currentDeviceId = await getCurrentDeviceId(requestHeaders);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-600">
          Settings
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-gray-900">
          Trusted devices
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Devices below skip the email login for one year. Signed in as{" "}
          <span className="font-medium text-gray-900">{actor}</span>.
        </p>
      </div>
      <DeviceList
        devices={devices.map((d) => ({
          id: d.id,
          label: d.label,
          userAgent: d.user_agent,
          createdAt: d.created_at,
          lastSeenAt: d.last_seen_at,
          isCurrent: currentDeviceId === d.id,
        }))}
      />
    </div>
  );
}
