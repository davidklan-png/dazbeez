import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "@/app/globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

/**
 * The shared `<html>`/`<body>` scaffolding for the app's two root layouts
 * (`app/(site)/layout.tsx` and `app/(receipt-system)/layout.tsx`). Owns the
 * Inter font, global styles, ClerkProvider, and the skip-to-content link so
 * the two document shells cannot drift apart.
 */
export function RootDocument({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} antialiased`}>
      <body className="min-h-screen flex flex-col">
        <ClerkProvider>
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-amber-500 focus:px-4 focus:py-2 focus:text-white focus:shadow-lg"
          >
            Skip to main content
          </a>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
