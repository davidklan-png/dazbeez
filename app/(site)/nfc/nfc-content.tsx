"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { HoneycombBackdrop } from "@/components/honeycomb-backdrop";

type PrimaryAction = {
  href: string;
  label: string;
  sublabel: string;
  icon: React.ReactNode;
};

type SecondaryAction = {
  href: string;
  label: string;
};

const primaryAction: PrimaryAction = {
  href: "/contact",
  label: "Book a consultation",
  sublabel: "Reply within 24h",
  icon: (
    <svg
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
  ),
};

const secondaryActions: SecondaryAction[] = [
  { href: "/services", label: "Browse services" },
  { href: "/business-card", label: "About this card" },
];

const VCARD_HREF = "/api/vcard";

const subscribeNoop = () => () => {};
const getShareSupport = () =>
  typeof navigator !== "undefined" && typeof navigator.share === "function";

export function NFCContent() {
  const params = useSearchParams();
  const source = params.get("src") || "direct";
  // Hydration-safe client-only feature detection: server snapshot is always
  // false (matches the initial markup), then the client snapshot reads the
  // real value on the first client render without an effect-driven setState.
  const canShare = useSyncExternalStore(
    subscribeNoop,
    getShareSupport,
    () => false,
  );

  useEffect(() => {
    if (source === "direct") return;
    // Fire-and-forget analytics; never block the UI on this.
    const url = `/api/nfc/hit?src=${encodeURIComponent(source)}`;
    try {
      if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
        navigator.sendBeacon(url);
      } else {
        void fetch(url, { method: "GET", keepalive: true }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }, [source]);

  async function handleShare() {
    try {
      await navigator.share({
        title: "Dazbeez — David Klan",
        text: "AI · Automation · Data consulting",
        url: typeof window !== "undefined" ? window.location.origin : "https://dazbeez.com",
      });
    } catch {
      /* user cancelled or share unavailable */
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-4">
      <HoneycombBackdrop opacity={0.07} color="#FBBF24" />
      <div className="relative w-full max-w-sm">
        <div className="overflow-hidden rounded-3xl bg-white shadow-2xl">
          <div className="relative overflow-hidden bg-gradient-to-r from-amber-400 to-amber-600 p-6 text-center text-white">
            <HoneycombBackdrop opacity={0.18} color="#ffffff" />
            <div className="relative">
              <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/20">
                <svg
                  viewBox="-32 -32 64 64"
                  className="h-10 w-10"
                  role="img"
                  aria-label="Dazbeez honeycomb"
                >
                  <polygon
                    points="0,-22 19,-11 19,11 0,22 -19,11 -19,-11"
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth={2.5}
                    strokeLinejoin="round"
                  />
                  <polygon
                    points="0,-10 8.7,-5 8.7,5 0,10 -8.7,5 -8.7,-5"
                    fill="#ffffff"
                  />
                </svg>
              </div>
              <h1 className="text-2xl font-bold">Dazbeez</h1>
              <p className="text-sm uppercase tracking-[0.18em] text-amber-50">
                AI · Automation · Data
              </p>
            </div>
          </div>

          <div className="p-6">
            <Link
              href={primaryAction.href}
              className="flex items-center gap-4 rounded-xl bg-amber-500 p-4 text-white transition-colors hover:bg-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
              aria-label={`${primaryAction.label} — ${primaryAction.sublabel}`}
            >
              <span aria-hidden="true" className="flex-shrink-0">
                {primaryAction.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold leading-tight">
                  {primaryAction.label}
                </span>
                <span className="mt-0.5 block text-xs opacity-80">
                  {primaryAction.sublabel}
                </span>
              </span>
              <svg
                className="h-5 w-5 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </Link>

            <a
              href={VCARD_HREF}
              className="mt-3 flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-900 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M16 12V4M8 12V4m-4 8h16M4 20h16"
                />
              </svg>
              Save David&apos;s contact (vCard)
            </a>

            <div className="mt-4 flex gap-2">
              {secondaryActions.map((action) => (
                <Link
                  key={action.href}
                  href={action.href}
                  className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-center text-xs font-medium text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                >
                  {action.label}
                </Link>
              ))}
            </div>

            {canShare ? (
              <button
                type="button"
                onClick={handleShare}
                className="mt-3 flex w-full items-center justify-center gap-2 text-center text-xs font-medium text-gray-500 hover:text-gray-900"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                  />
                </svg>
                Share this card
              </button>
            ) : null}
          </div>

          <div className="bg-gray-100 p-3 text-center">
            <Link
              href="/"
              className="text-xs text-gray-500 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
            >
              Visit full site →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
