import type { Metadata } from "next";
import { ReceiptShell } from "@/components/receipts/receipt-shell";

export const metadata: Metadata = {
  title: "Receipts — Dazbeez",
  robots: { index: false, follow: false },
};

export default async function ReceiptsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <ReceiptShell>{children}</ReceiptShell>;
}
