import type { Metadata } from "next";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { ReceiptShell } from "@/components/receipts/receipt-shell";

export const metadata: Metadata = {
  title: "Receipts — Dazbeez",
  robots: { index: false, follow: false },
};

export default async function ReceiptsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await assertReceiptsPageAccess();

  return <ReceiptShell>{children}</ReceiptShell>;
}
