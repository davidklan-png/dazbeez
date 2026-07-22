import type { Metadata } from "next";
import { getReceiptsPageActor } from "@/lib/receipts/auth-request";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { getSenderControlsSnapshot } from "@/lib/receipts/sender-activity";
import { SenderControls } from "@/components/receipts/sender-controls";

export const metadata: Metadata = {
  title: "Sender controls — Receipts",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function TrustedSendersPage() {
  await getReceiptsPageActor();
  const snapshot = await getSenderControlsSnapshot(getReceiptsDb());

  return (
    <div className="space-y-6 px-8 py-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-600">
          Settings
        </p>
        <h1 className="mt-2 text-[26px] font-bold text-gray-900">
          Sender controls
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Manage which senders can auto-file body-only receipts (trusted),
          which are blocked (metadata-only delivery), and review recent
          unrecognized senders.
        </p>
      </div>

      <SenderControls
        initialTrusted={snapshot.trusted}
        initialBlocked={snapshot.blocked}
        initialUnrecognized={snapshot.unrecognized}
      />
    </div>
  );
}
