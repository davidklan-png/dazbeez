import type { Metadata } from "next";
import { Suspense } from "react";
import { NFCContent } from "./nfc-content";

export const metadata: Metadata = {
  title: "NFC Quick Access — Dazbeez",
  description:
    "Open the Dazbeez NFC quick-access page to book a consultation, browse services, or learn how the card works.",
  alternates: {
    canonical: "/nfc",
  },
};

export default function NFCPage() {
  return (
    <Suspense fallback={null}>
      <NFCContent />
    </Suspense>
  );
}
