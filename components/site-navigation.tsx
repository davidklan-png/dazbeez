"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

export function SiteNavigation() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const menu = document.getElementById("mobile-menu");
      const button = document.getElementById("mobile-menu-button");
      
      if (menu && !menu.contains(event.target as Node) && 
          button && !button.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const toggleMenu = () => {
    setIsMenuOpen(!isMenuOpen);
  };

  return (
    <nav className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-amber-400 to-amber-600 rounded-full flex items-center justify-center">
              <span className="text-white font-bold text-sm">D</span>
            </div>
            <span className="font-bold text-xl text-gray-900">Dazbeez</span>
          </Link>

          <div className="hidden md:flex items-center gap-8">
            <Link href="/" className="text-gray-700 hover:text-amber-600 transition-colors">Home</Link>
            <Link href="/services" className="text-gray-700 hover:text-amber-600 transition-colors">Services</Link>
            <Link href="/inquiry" className="text-gray-700 hover:text-amber-600 transition-colors">Get Started</Link>
            <Link href="/contact" className="bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 rounded-full transition-colors">
              Contact
            </Link>
          </div>

          <button 
            id="mobile-menu-button"
            className="md:hidden p-2"
            aria-label="Menu"
            onClick={toggleMenu}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isMenuOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"} />
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {isMenuOpen && (
        <div 
          id="mobile-menu"
          className="md:hidden bg-white border-t border-gray-200"
        >
          <div className="px-2 pt-2 pb-3 space-y-1">
            <Link 
              href="/" 
              className="block px-3 py-2 text-gray-700 hover:text-amber-600 hover:bg-gray-50 rounded-md transition-colors"
              onClick={() => setIsMenuOpen(false)}
            >
              Home
            </Link>
            <Link 
              href="/services" 
              className="block px-3 py-2 text-gray-700 hover:text-amber-600 hover:bg-gray-50 rounded-md transition-colors"
              onClick={() => setIsMenuOpen(false)}
            >
              Services
            </Link>
            <Link 
              href="/inquiry" 
              className="block px-3 py-2 text-gray-700 hover:text-amber-600 hover:bg-gray-50 rounded-md transition-colors"
              onClick={() => setIsMenuOpen(false)}
            >
              Get Started
            </Link>
            <Link 
              href="/contact" 
              className="block px-3 py-2 text-gray-700 hover:text-amber-600 hover:bg-gray-50 rounded-md transition-colors"
              onClick={() => setIsMenuOpen(false)}
            >
              Contact
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
}
