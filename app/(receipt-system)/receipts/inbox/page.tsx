import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { listPendingIntake } from "@/lib/receipts/email-intake";
import { InboxRow } from "@/components/receipts/inbox/inbox-row";

export const dynamic = "force-dynamic";

// ADR 0011: human triage queue for emailed receipts (receipts@dazbeez.com).
// Unauthenticated mail never writes to receipt_records directly — it lands in
// email_receipt_intake at pending_triage and only an explicit Promote creates
// a real receipt. This screen is deliberately separate from /receipts/review
// (whose lock/month-scoping semantics don't apply to unreviewed mail).
export default async function InboxPage() {
  await assertReceiptsPageAccess();
  const rows = await listPendingIntake(getReceiptsDb());

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8">
      <header className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Email inbox</h1>
        <p className="mt-1 text-sm text-gray-500">
          Mail sent to <span className="font-medium">receipts@</span> or{" "}
          <span className="font-medium">receipt@dazbeez.com</span>. Promote
          to create a real receipt; reject to dismiss. SPF/DKIM verdicts are
          informational — nothing is auto-accepted or auto-rejected.
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
          {rows.map((intake) => (
            <InboxRow key={intake.id} intake={intake} />
          ))}
        </ul>
      )}
    </main>
  );
}
