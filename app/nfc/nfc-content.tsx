"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { HoneycombBackdrop } from "@/components/honeycomb-backdrop";

type QuickAction = {
  href: string;
  label: string;
  sublabel: string;
  tone: "primary" | "neutral" | "secondary";
  icon: React.ReactNode;
};

const quickActions: QuickAction[] = [
  {
    href: "/contact",
    label: "Book a consultation",
    sublabel: "Reply within 24h",
    tone: "primary",
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    href: "/services",
    label: "Browse services",
    sublabel: "AI · Automation · Data",
    tone: "neutral",
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    ),
  },
  {
    href: "/business-card",
    label: "About this card",
    sublabel: "How it works",
    tone: "secondary",
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20 10 10 0 000-20z" />
      </svg>
    ),
  },
];

const toneClasses: Record<QuickAction["tone"], string> = {
  primary: "bg-amber-500 hover:bg-amber-600 text-white",
  neutral: "bg-gray-900 hover:bg-gray-800 text-white",
  secondary: "bg-white hover:bg-gray-50 text-gray-900 border border-gray-200",
};

export function NFCContent() {
  const params = useSearchParams();
  const source = params.get("src") || "direct";

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center p-4 relative overflow-hidden">
      <HoneycombBackdrop opacity={0.07} color="#FBBF24" />
      <div className="max-w-sm w-full relative">
        <div className="bg-white rounded-3xl shadow-2xl overflow-hidden">
          <div className="relative overflow-hidden bg-gradient-to-r from-amber-400 to-amber-600 p-6 text-white text-center">
            <HoneycombBackdrop opacity={0.18} color="#ffffff" />
            <div className="relative">
              <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center mx-auto mb-3">
                <svg viewBox="-32 -32 64 64" className="w-10 h-10" role="img" aria-label="Dazbeez honeycomb">
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
              <p className="text-amber-50 text-sm tracking-[0.18em] uppercase">
                AI · Automation · Data
              </p>
            </div>
          </div>

          <div className="p-6">
            <p className="text-gray-600 text-center mb-6 text-sm">
              Tap one of the options below to get started.
            </p>

            <div className="space-y-3 mb-6">
              {quickActions.map((action) => (
                <Link
                  key={action.href}
                  href={action.href}
                  className={`${toneClasses[action.tone]} flex items-center gap-4 p-4 rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2`}
                  aria-label={`${action.label} — ${action.sublabel}`}
                >
                  <span aria-hidden="true" className="flex-shrink-0">
                    {action.icon}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-semibold leading-tight">
                      {action.label}
                    </span>
                    <span className="block text-xs opacity-80 mt-0.5">
                      {action.sublabel}
                    </span>
                  </span>
                  <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              ))}
            </div>

            <p className="text-center text-xs text-gray-400">
              Scanned from: {source}
            </p>
          </div>

          <div className="bg-gray-100 p-4 text-center">
            <Link
              href="/"
              className="text-sm text-gray-600 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
            >
              Visit full site →
            </Link>
          </div>
        </div>

        <div className="flex justify-center mt-6">
          <div className="relative">
            <div className="w-4 h-4 bg-amber-400 rounded-full motion-safe:animate-ping absolute" aria-hidden="true"></div>
            <div className="w-4 h-4 bg-amber-500 rounded-full relative" aria-hidden="true"></div>
          </div>
          <p className="ml-3 text-white/60 text-sm">NFC detected</p>
        </div>
      </div>
    </div>
  );
}
