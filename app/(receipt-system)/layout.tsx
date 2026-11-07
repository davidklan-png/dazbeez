import type { Metadata } from "next";
import { RootDocument } from "@/components/root-document";

export const metadata: Metadata = {
  title: "Dazbeez Receipts",
  description: "Receipt capture, review, and reconciliation.",
  robots: { index: false, follow: false },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Dazbeez",
  },
  // Previously inherited from the single root layout; the split dropped it.
  // The operator's home-screened capture page needs the icon (Codex P2, #193).
  icons: {
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
};

/**
 * Root layout for the receipts module. Deliberately renders NO site
 * header/footer — the module's own `ReceiptShell` (via
 * `app/(receipt-system)/receipts/layout.tsx`) provides the frozen top row.
 */
export default function ReceiptsRootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <RootDocument>
      <main id="main-content" className="flex-1">{children}</main>
    </RootDocument>
  );
}
