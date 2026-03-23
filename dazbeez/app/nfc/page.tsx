"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function NFCPage() {
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    // Track where the user came from (NFC card, promo device, etc.)
    const urlParams = new URLSearchParams(window.location.search);
    setSource(urlParams.get("src") || "direct");
  }, []);

  const quickActions = [
    { href: "/inquiry", label: "Start Inquiry", icon: "💬", color: "bg-amber-500" },
    { href: "/services", label: "Our Services", icon: "📋", color: "bg-gray-900" },
    { href: "/contact", label: "Contact Us", icon: "📧", color: "bg-blue-500" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center p-4">
      <div className="max-w-sm w-full">
        {/* NFC Card */}
        <div className="bg-white rounded-3xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-amber-400 to-amber-600 p-6 text-white text-center">
            <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-3">
              <span className="text-3xl">🐝</span>
            </div>
            <h1 className="text-2xl font-bold">Dazbeez</h1>
            <p className="text-amber-100 text-sm">AI • Automation • Data</p>
          </div>

          {/* Content */}
          <div className="p-6">
            <p className="text-gray-600 text-center mb-6">
              Tap a button below to get started instantly
            </p>

            {/* Quick Actions */}
            <div className="space-y-3 mb-6">
              {quickActions.map((action) => (
                <Link
                  key={action.href}
                  href={action.href}
                  className={`${action.color} text-white flex items-center gap-3 p-4 rounded-xl hover:opacity-90 transition-opacity`}
                >
                  <span className="text-2xl">{action.icon}</span>
                  <span className="font-semibold">{action.label}</span>
                  <svg className="w-5 h-5 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              ))}
            </div>

            {/* Scan Source (for tracking) */}
            {source && (
              <p className="text-center text-xs text-gray-400">
                Scanned from: {source}
              </p>
            )}
          </div>

          {/* Footer */}
          <div className="bg-gray-100 p-4 text-center">
            <Link href="/" className="text-sm text-gray-600 hover:text-gray-900">
              Visit full site →
            </Link>
          </div>
        </div>

        {/* NFC Wave Animation */}
        <div className="flex justify-center mt-6">
          <div className="relative">
            <div className="w-4 h-4 bg-amber-400 rounded-full animate-ping absolute"></div>
            <div className="w-4 h-4 bg-amber-500 rounded-full relative"></div>
          </div>
          <p className="ml-3 text-white/60 text-sm">NFC detected</p>
        </div>
      </div>
    </div>
  );
}
