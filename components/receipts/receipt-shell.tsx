"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BeeMark } from "@/components/receipts/ui/bee-mark";

const NAV = [
  { href: "/receipts", label: "Dashboard" },
  { href: "/receipts/capture", label: "Capture" },
  { href: "/receipts/review", label: "Review" },
  { href: "/receipts/amex", label: "AMEX" },
  { href: "/receipts/reconcile", label: "Reconcile" },
  { href: "/receipts/export", label: "Export" },
  { href: "/receipts/settings", label: "Settings" },
] as const;

function currentMonthLabel() {
  return new Date().toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

export function ReceiptShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-10 flex items-center gap-6 border-b border-gray-200 bg-white px-4 py-3.5 sm:px-8">
        <Link
          href="/receipts"
          className="flex items-center gap-2.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          <BeeMark size={26} />
          <span className="text-[15px] font-bold text-gray-900">
            Dazbeez
            <span className="ml-1 font-medium text-gray-400">· Receipts</span>
          </span>
        </Link>
        <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
          {NAV.map((item) => {
            const isActive =
              item.href === "/receipts"
                ? pathname === "/receipts"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "rounded-lg border px-3 py-1.5 text-[13.5px] transition-colors",
                  isActive
                    ? "border-amber-200 bg-amber-50 font-semibold text-gray-900"
                    : "border-transparent font-medium text-gray-500 hover:text-gray-900",
                ].join(" ")}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="hidden items-center gap-3 text-[13px] text-gray-500 sm:flex">
          <span className="text-gray-400">{currentMonthLabel()}</span>
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-900 text-[12px] font-semibold text-white">
            D
          </span>
        </div>
      </header>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
