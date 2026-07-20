import type { Metadata } from "next";
import { getReceiptsPageActor } from "@/lib/receipts/auth-request";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { listTrustedSenders } from "@/lib/receipts/trusted-senders";
import { TrustedSendersList } from "@/components/receipts/trusted-senders-list";

export const metadata: Metadata = {
  title: "Trusted intake senders — Receipts",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

// ADR 0011 Phase B follow-up: the email-body auto-promote allowlist, managed
// here instead of the consumer's TRUSTED_INTAKE_SENDERS env var. This list is
// the single safety gate for a zero-human-review auto-promotion path, so the
// page leads with that risk — it is NOT a routine settings toggle.
export default async function TrustedSendersPage() {
  await getReceiptsPageActor(); // Clerk access gate (throws if not allowed)
  const senders = await listTrustedSenders(getReceiptsDb());

  return (
    <div className="space-y-6 px-8 py-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-600">
          Settings
        </p>
        <h1 className="mt-2 text-[26px] font-bold text-gray-900">
          Trusted intake senders
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Emails on this list auto-file body-only receipts into the books with
          no manual review step — see ADR 0011 Phase B. Only add addresses you
          control and are actively forwarding from.
        </p>
      </div>

      <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
        <p className="text-sm font-semibold text-red-800">
          Auto-promotion has no manual review step.
        </p>
        <p className="mt-1 text-xs text-red-700">
          A receipt is filed straight into the books the moment a body-only
          email from one of these addresses lands (SPF and DKIM must also
          pass). Only add email addresses you control. A spoofed address on
          this list — if SPF/DKIM were also defeated — could inject fraudulent
          receipts unattended.
        </p>
      </div>

      <TrustedSendersList initial={senders} />
    </div>
  );
}
