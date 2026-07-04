import { redirect } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in — Receipts",
  robots: { index: false, follow: false },
};

export default function EnrollDevicePage() {
  redirect("/receipts/sign-in");
}
