import type { Metadata } from "next";
import { headers } from "next/headers";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { EnrollDeviceForm } from "@/components/receipts/enroll-device-form";

export const metadata: Metadata = {
  title: "Trust this device — Receipts",
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function EnrollDevicePage({ searchParams }: PageProps) {
  const requestHeaders = await headers();
  const actor = await requireReceiptsActor(requestHeaders);
  const { next } = await searchParams;
  const safeNext = next && next.startsWith("/receipts") ? next : "/receipts";

  return (
    <div className="mx-auto my-12 max-w-lg rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-600">
        Trusted device
      </p>
      <h1 className="mt-2 text-2xl font-semibold text-gray-900">
        Trust this device
      </h1>
      <p className="mt-2 text-sm text-gray-600">
        You&rsquo;re signed in as{" "}
        <span className="font-medium text-gray-900">{actor}</span>. Naming this
        device sets a long-lived cookie so you won&rsquo;t need to sign in again
        for a year.
      </p>
      <EnrollDeviceForm next={safeNext} />
      <p className="mt-4 text-xs text-gray-500">
        Manage or revoke devices from{" "}
        <a
          href="/receipts/settings/devices"
          className="text-amber-700 underline"
        >
          Settings → Devices
        </a>
        .
      </p>
    </div>
  );
}
