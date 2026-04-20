import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found — Dazbeez",
  description: "The page you were looking for doesn't exist or has moved. Browse services or get in touch.",
  robots: { index: false, follow: false },
};

const destinations = [
  { href: "/", label: "Home" },
  { href: "/services", label: "Services" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

export default function NotFound() {
  return (
    <div className="min-h-[60vh] py-20">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-600 mb-3">
          404
        </p>
        <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4 leading-tight">
          We couldn&apos;t find that page.
        </h1>
        <p className="text-lg text-gray-600 mb-10">
          The link may be outdated, or the page may have moved. Try one of the
          destinations below, or head back home.
        </p>

        <div className="flex flex-wrap justify-center gap-3">
          {destinations.map((d) => (
            <Link
              key={d.href}
              href={d.href}
              className="inline-flex items-center justify-center rounded-full border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-900 transition-colors hover:border-amber-500 hover:text-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
            >
              {d.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
