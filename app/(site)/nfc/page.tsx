import type { Metadata } from "next";
import { Suspense } from "react";
import { NFCContent } from "./nfc-content";

export const metadata: Metadata = {
  title: "Tap to reach David — Dazbeez",
  description:
    "Book a consultation, save David's contact, or browse Dazbeez services — straight from the NFC card.",
  alternates: {
    canonical: "/nfc",
  },
  openGraph: {
    title: "Tap to reach David — Dazbeez",
    description:
      "Book a consultation, save David's contact, or browse Dazbeez services — straight from the NFC card.",
    url: "https://dazbeez.com/nfc",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Tap to reach David — Dazbeez",
    description:
      "Book a consultation, save David's contact, or browse Dazbeez services — straight from the NFC card.",
  },
};

function NFCSkeleton() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-4"
      aria-hidden="true"
    >
      <div className="w-full max-w-sm">
        <div className="overflow-hidden rounded-3xl bg-white shadow-2xl">
          <div className="h-32 animate-pulse bg-gradient-to-r from-amber-400 to-amber-600" />
          <div className="space-y-3 p-6">
            <div className="h-14 animate-pulse rounded-xl bg-gray-200" />
            <div className="h-11 animate-pulse rounded-xl bg-gray-100" />
            <div className="flex gap-2">
              <div className="h-8 flex-1 animate-pulse rounded-lg bg-gray-100" />
              <div className="h-8 flex-1 animate-pulse rounded-lg bg-gray-100" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function NFCPage() {
  return (
    <Suspense fallback={<NFCSkeleton />}>
      <NFCContent />
    </Suspense>
  );
}
