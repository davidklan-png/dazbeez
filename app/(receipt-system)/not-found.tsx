import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Not found — Dazbeez Receipts",
  robots: { index: false, follow: false },
};

// Boundary for notFound() thrown by receipts pages (review/[id], export,
// trips). Sits at the group root so the ReceiptShell (receipts/layout.tsx,
// which nests above it) still renders around the message.
export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16 text-center sm:px-8">
      <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-600 mb-3">
        404
      </p>
      <h1 className="text-2xl font-bold text-gray-900 mb-3">
        We couldn&apos;t find that page.
      </h1>
      <p className="mb-8 text-gray-600">
        The receipt or record may have been removed, or the link is outdated.
      </p>
      <Link
        href="/receipts"
        className="inline-flex items-center justify-center rounded-full border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-900 transition-colors hover:border-amber-500 hover:text-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
      >
        Back to the dashboard
      </Link>
    </div>
  );
}
