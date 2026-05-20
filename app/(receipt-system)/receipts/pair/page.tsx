import type { Metadata } from "next";
import { headers } from "next/headers";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { PairMobileDeviceForm } from "@/components/receipts/pair-mobile-device-form";

export const metadata: Metadata = {
  title: "Pair iPhone — Receipts",
  robots: { index: false, follow: false },
};

interface PairingPageProps {
  searchParams: Promise<{ code?: string }>;
}

export default async function PairMobileDevicePage({ searchParams }: PairingPageProps) {
  const requestHeaders = await headers();
  const actor = await requireReceiptsActor(requestHeaders);
  const { code } = await searchParams;
  const initialCode = code?.trim().toUpperCase() ?? "";

  return (
    <div className="space-y-6 px-8 py-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-600">
          Mobile
        </p>
        <h1 className="mt-2 text-[26px] font-bold text-gray-900">
          Pair an iPhone
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Open Dazbeez Capture on your iPhone, tap{" "}
          <span className="font-medium text-gray-900">Pair with Dazbeez</span>,
          then enter the code shown on the phone here. Signed in as{" "}
          <span className="font-medium text-gray-900">{actor}</span>.
        </p>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <PairMobileDeviceForm initialCode={initialCode} />
        <p className="mt-4 text-xs text-gray-500">
          The bearer token is sent directly to the polling iPhone and is never
          shown in this browser. Revoke a paired device anytime from{" "}
          <a className="font-medium text-amber-700 hover:underline" href="/receipts/settings/devices">
            Trusted devices
          </a>.
        </p>
      </div>
    </div>
  );
}
