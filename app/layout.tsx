import type { Metadata } from "next";
import { Inter } from "next/font/google";
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
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 bg-gradient-to-br from-amber-400 to-amber-600 rounded-full flex items-center justify-center">
                <span className="text-white font-bold text-sm">D</span>
              </div>
              <span className="font-bold text-xl">Dazbeez</span>
            </div>
            <p className="text-gray-400">AI, Automation & Data Solutions for modern businesses.</p>
          </div>

          <div>
            <h3 className="font-semibold mb-4">Services</h3>
            <ul className="space-y-2 text-gray-400">
              <li><a href="/services/ai" className="hover:text-amber-400 transition-colors">AI Integration</a></li>
              <li><a href="/services/automation" className="hover:text-amber-400 transition-colors">Automation</a></li>
              <li><a href="/services/data" className="hover:text-amber-400 transition-colors">Data Management</a></li>
              <li><a href="/services/governance" className="hover:text-amber-400 transition-colors">Governance</a></li>
            </ul>
          </div>

          <div>
            <h3 className="font-semibold mb-4">Connect</h3>
            <ul className="space-y-2 text-gray-400">
              <li><a href="/contact" className="hover:text-amber-400 transition-colors">Contact Us</a></li>
              <li><a href="/inquiry" className="hover:text-amber-400 transition-colors">Start Inquiry</a></li>
              <li><a href="/nfc" className="hover:text-amber-400 transition-colors">NFC Quick Access</a></li>
            </ul>
          </div>
        </div>

        <div className="border-t border-gray-800 mt-8 pt-8 text-center text-gray-500">
          <p>&copy; {new Date().getFullYear()} Dazbeez. All rights reserved.</p>
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
        <SiteNavigation />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
