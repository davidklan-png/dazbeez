"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navLinks = [
  { href: "/receipts", label: "Dashboard" },
  { href: "/receipts/capture", label: "Capture" },
  { href: "/receipts/review", label: "Review" },
  { href: "/receipts/amex", label: "AMEX" },
  { href: "/receipts/reconcile", label: "Reconcile" },
  { href: "/receipts/export", label: "Export" },
  { href: "/receipts/settings", label: "Settings" },
];

export function ReceiptShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:flex-row lg:px-8">
        <aside className="w-full shrink-0 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm lg:w-56 lg:self-start">
          <div className="border-b border-gray-100 pb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-600">
              Dazbeez
            </p>
            <h1 className="mt-2 text-xl font-semibold text-gray-900">
              Receipts
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Expense capture &amp; accountant export
            </p>
          </div>
          <nav className="mt-4 space-y-1">
            {navLinks.map((link) => {
              const isActive =
                link.href === "/receipts"
                  ? pathname === "/receipts"
                  : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`block rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-amber-50 text-amber-700"
                      : "text-gray-700 hover:bg-amber-50 hover:text-amber-700"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </aside>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
