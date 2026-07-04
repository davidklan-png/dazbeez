import { SignIn } from "@clerk/nextjs";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in — Dazbeez Receipts",
  robots: { index: false, follow: false },
};

export default function ReceiptsSignInPage() {
  return (
    <div className="mx-auto my-12 flex max-w-md flex-col gap-6 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-600">
          Dazbeez Receipts
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-gray-900">Sign in</h1>
        <p className="mt-1 text-sm text-gray-600">
          Use the email address associated with your receipts account. A
          one-time code will be sent to confirm.
        </p>
      </header>
      <SignIn />
    </div>
  );
}
