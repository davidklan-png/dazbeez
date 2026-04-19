import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Image from "next/image";
import Link from "next/link";
import { SiteNavigation } from "@/components/site-navigation";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Dazbeez - AI, Automation & Data Solutions",
  description: "Transform your business with AI integration, automation, data management, and governance services.",
  metadataBase: new URL("https://dazbeez.com"),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Dazbeez - AI, Automation & Data Solutions",
    description: "Transform your business with AI integration, automation, data management, and governance services.",
    url: "https://dazbeez.com",
    siteName: "Dazbeez",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Dazbeez AI, Automation & Data Solutions",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Dazbeez - AI, Automation & Data Solutions",
    description: "Transform your business with AI integration, automation, data management, and governance services.",
    images: ["/opengraph-image"],
  },
};

function Footer() {
  return (
    <footer className="bg-gray-900 text-white py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid md:grid-cols-3 gap-8">
          <div>
            <div className="mb-4">
              <Image
                src="/logo.png"
                alt="Dazbeez"
                width={140}
                height={93}
                className="h-20 w-auto brightness-0 invert"
                loading="lazy"
              />
            </div>
            <p className="text-gray-400">AI, Automation & Data Solutions for modern businesses.</p>
          </div>

          <div>
            <h3 className="font-semibold mb-4">Services</h3>
            <ul className="space-y-2 text-gray-400">
              <li><Link href="/services/ai" className="rounded transition-colors hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">AI Integration</Link></li>
              <li><Link href="/services/automation" className="rounded transition-colors hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">Automation</Link></li>
              <li><Link href="/services/data" className="rounded transition-colors hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">Data Management</Link></li>
              <li><Link href="/services/governance" className="rounded transition-colors hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">Governance</Link></li>
              <li><Link href="/services/pm" className="rounded transition-colors hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">Project Management</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="font-semibold mb-4">Connect</h3>
            <ul className="space-y-2 text-gray-400">
              <li><Link href="/contact" className="rounded transition-colors hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">Contact Us</Link></li>
              <li><Link href="/about" className="rounded transition-colors hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">About David</Link></li>
              <li><Link href="/business-card" className="rounded transition-colors hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">About the Card</Link></li>
              <li><Link href="/nfc" className="rounded transition-colors hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">NFC Quick Access</Link></li>
              <li><a href="https://www.linkedin.com/in/david-klan" target="_blank" rel="noopener noreferrer" className="rounded transition-colors hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">LinkedIn</a></li>
            </ul>
          </div>
        </div>

        <div className="border-t border-gray-800 mt-8 pt-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-gray-500 text-sm">
          <p>&copy; {new Date().getFullYear()} Dazbeez G.K. (合同会社) · 法人番号: 登記中. All rights reserved.</p>
          <div className="flex gap-6">
            <Link href="/privacy-policy" className="rounded transition-colors hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">Privacy Policy</Link>
            <Link href="/terms-of-service" className="rounded transition-colors hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">Terms of Service</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} antialiased`}>
      <body className="min-h-screen flex flex-col">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-amber-500 focus:px-4 focus:py-2 focus:text-white focus:shadow-lg"
        >
          Skip to main content
        </a>
        <SiteNavigation />
        <main id="main-content" className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
