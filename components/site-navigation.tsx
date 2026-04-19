"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navLinks = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About" },
  { href: "/services", label: "Services" },
  { href: "/business-card", label: "Business Card" },
];

function LinkedInIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19 3A2 2 0 0 1 21 5v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm-9.75 6.75H6.5V18h2.75zM7.88 5.94A1.63 1.63 0 0 0 6.25 7.56c0 .9.72 1.63 1.6 1.63h.03c.92 0 1.63-.73 1.63-1.63a1.62 1.62 0 0 0-1.62-1.62zm10.12 6.48c0-2.37-1.27-3.47-2.96-3.47-1.37 0-1.98.75-2.32 1.28v-1.1H10V18h2.72v-4.72c0-.25.02-.5.09-.68.2-.5.65-1.01 1.41-1.01 1 0 1.4.76 1.4 1.88V18H18z" />
    </svg>
  );
}

export function SiteNavigation() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const pathname = usePathname();
  const firstMobileLinkRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const menu = document.getElementById("mobile-menu");
      const button = document.getElementById("mobile-menu-button");

      if (
        menu &&
        !menu.contains(event.target as Node) &&
        button &&
        !button.contains(event.target as Node)
      ) {
        setIsMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (isMenuOpen) {
      firstMobileLinkRef.current?.focus();
    }
  }, [isMenuOpen]);

  const toggleMenu = () => {
    setIsMenuOpen((open) => !open);
  };

  const isActiveLink = (href: string) => {
    if (href === "/services") {
      return pathname.startsWith("/services");
    }

    return pathname === href;
  };

  return (
    <nav className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-24">
          <Link
            href="/"
            className="flex items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            aria-label="Dazbeez — home"
          >
            <Image
              src="/logo.png"
              alt="Dazbeez"
              width={140}
              height={93}
              className="h-20 w-auto"
              priority
            />
          </Link>

          <div className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => {
              const isActive = isActiveLink(link.href);

              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={isActive ? "page" : undefined}
                  className={`rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${isActive ? "font-semibold text-amber-600" : "text-gray-700 hover:text-amber-600"}`}
                >
                  {link.label}
                </Link>
              );
            })}
            <a
              href="https://www.linkedin.com/in/david-klan"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="David Klan on LinkedIn"
              className="text-gray-500 transition-colors hover:text-amber-600 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <LinkedInIcon />
            </a>
            <Link
              href="/contact"
              className="bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
            >
              Book a consultation
            </Link>
          </div>

          <button
            id="mobile-menu-button"
            className="md:hidden p-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            aria-label={isMenuOpen ? "Close menu" : "Open menu"}
            aria-expanded={isMenuOpen}
            aria-controls="mobile-menu"
            onClick={toggleMenu}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d={isMenuOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"}
              />
            </svg>
          </button>
        </div>
      </div>

      {isMenuOpen && (
        <div id="mobile-menu" className="md:hidden bg-white border-t border-gray-200">
          <div className="px-2 pt-2 pb-3 space-y-1">
            {navLinks.map((link, index) => {
              const isActive = isActiveLink(link.href);

              return (
                <Link
                  key={link.href}
                  ref={index === 0 ? firstMobileLinkRef : undefined}
                  href={link.href}
                  aria-current={isActive ? "page" : undefined}
                  className={`block rounded-md px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${isActive ? "bg-amber-50 font-semibold text-amber-600" : "text-gray-700 hover:bg-gray-50 hover:text-amber-600"}`}
                  onClick={() => setIsMenuOpen(false)}
                >
                  {link.label}
                </Link>
              );
            })}
            <a
              href="https://www.linkedin.com/in/david-klan"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="David Klan on LinkedIn"
              className="flex w-fit items-center rounded-md px-3 py-2 text-gray-500 transition-colors hover:bg-gray-50 hover:text-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              onClick={() => setIsMenuOpen(false)}
            >
              <LinkedInIcon />
            </a>
            <Link
              href="/contact"
              className="block px-3 py-2 mt-2 bg-amber-500 hover:bg-amber-600 text-white rounded-md font-semibold text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
              onClick={() => setIsMenuOpen(false)}
            >
              Book a consultation
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
}
