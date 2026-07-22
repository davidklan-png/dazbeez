import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { listPendingIntake } from "@/lib/receipts/email-intake";
import { listTrustedSenders } from "@/lib/receipts/trusted-senders";
import { listBlockedSenders } from "@/lib/receipts/blocked-senders";
import { normalizeSenderEmail } from "@/lib/receipts/trusted-senders";
import { InboxRow } from "@/components/receipts/inbox/inbox-row";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  await assertReceiptsPageAccess();
  const db = getReceiptsDb();
  const [rows, trusted, blocked] = await Promise.all([
    listPendingIntake(db),
    listTrustedSenders(db),
    listBlockedSenders(db),
  ]);

  const trustedSet = new Set(trusted.map((t) => t.email));
  const blockedSet = new Set(blocked.map((b) => b.email));

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8">
      <header className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Email inbox</h1>
        <p className="mt-1 text-sm text-gray-500">
          Mail sent to <span className="font-medium">receipts@</span> or{" "}
          <span className="font-medium">receipt@dazbeez.com</span>. Promote
          to create a real receipt; reject to dismiss. Use Trust/Block to
          manage sender policy for future mail.
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-600">No emails to triage.</p>
          <p className="mt-1 text-xs text-gray-400">
            Emails with a valid PDF/image attachment will appear here.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((intake) => {
            const norm = normalizeSenderEmail(intake.from_address);
            const senderState = blockedSet.has(norm)
              ? "blocked"
              : trustedSet.has(norm)
                ? "trusted"
                : "unrecognized";
            return (
              <InboxRow
                key={intake.id}
                intake={intake}
                senderState={senderState}
              />
            );
          })}
        </ul>
      )}
    </main>
  );
}
