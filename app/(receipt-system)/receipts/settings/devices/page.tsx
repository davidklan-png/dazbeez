import type { Metadata } from "next";
import Link from "next/link";
import { getReceiptsPageActor } from "@/lib/receipts/auth-request";
import { isReceiptsOwner } from "@/lib/receipts/owners";
import {
  listAllMobileDevices,
  listMobileDevicesForActor,
} from "@/lib/receipts/trusted-devices";
import { DeviceList } from "@/components/receipts/device-list";

export const metadata: Metadata = {
  title: "Trusted mobile devices — Receipts",
  robots: { index: false, follow: false },
};

export default async function DevicesPage() {
  const actor = await getReceiptsPageActor();
  const isOwner = await isReceiptsOwner(actor);
  // Owners get the full mobile fleet across every user; everyone else sees
  // their own. Historical browser rows (platform NULL) never appear here.
  const devices = isOwner
    ? await listAllMobileDevices()
    : await listMobileDevicesForActor(actor);

  return (
    <div className="space-y-6 px-8 py-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-600">
          Settings
        </p>
        <h1 className="mt-2 text-[26px] font-bold text-gray-900">
          Trusted mobile devices
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          {isOwner ? (
            <>
              Owner view — every iPhone or Android capture device paired with a
              receipts account. Signed in as{" "}
              <span className="font-medium text-gray-900">{actor}</span>.
            </>
          ) : (
            <>
              iPhone and Android capture devices paired with your receipts
              account. Signed in as{" "}
              <span className="font-medium text-gray-900">{actor}</span>.
            </>
          )}
        </p>
      </div>
      <DeviceList
        isOwnerView={isOwner}
        devices={devices.map((d) => ({
          id: d.id,
          label: d.label,
          userAgent: d.user_agent,
          createdAt: d.created_at,
          lastSeenAt: d.last_seen_at,
          platform: d.platform,
          appVersion: d.app_version,
          owner: isOwner ? d.actor : null,
        }))}
      />
      <p className="text-sm text-gray-500">
        Pair a new iPhone or Android device from{" "}
        <Link
          href="/receipts/pair"
          className="font-medium text-amber-700 hover:underline"
        >
          Pair a device
        </Link>
        .
      </p>
    </div>
  );
}
