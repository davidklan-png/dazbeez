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
