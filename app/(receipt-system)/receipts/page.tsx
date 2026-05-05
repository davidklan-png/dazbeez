import Link from "next/link";
import { getMissingStatementAlerts } from "@/lib/receipts/db";
import { assertReceiptsAccessFromHeaders } from "@/lib/receipts/auth";
import { headers } from "next/headers";
import { AmexMissingStatementAlert } from "@/components/receipts/amex-missing-statement-alert";

export const dynamic = "force-dynamic";

export default async function ReceiptsDashboardPage() {
  let missingAlerts: Awaited<ReturnType<typeof getMissingStatementAlerts>> = [];
  try {
    const hdrs = await headers();
    await assertReceiptsAccessFromHeaders(hdrs);
    const actor = hdrs.get("cf-access-authenticated-user-email") ?? "user";
    missingAlerts = await getMissingStatementAlerts(actor);
  } catch {
    // Non-fatal — alerts are optional
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-gray-900">Dashboard</h2>
        <p className="mt-1 text-sm text-gray-500">
          Expense capture, AMEX reconciliation, and monthly accountant exports.
        </p>
      </div>

      {missingAlerts.length > 0 && (
        <div className="space-y-3">
          {missingAlerts.map((alert) => (
            <AmexMissingStatementAlert
              key={alert.statementMonth}
              statementMonth={alert.statementMonth}
              expectedReadyDate={alert.expectedReadyDate}
            />
          ))}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <QuickLink
          href="/receipts/capture"
          title="Capture Receipt"
          description="Upload and log a new expense receipt from your phone or desktop."
          accent
        />
        <QuickLink
          href="/receipts/review"
          title="Review Queue"
          description="Review and correct captured receipts before export."
        />
        <QuickLink
          href="/receipts/amex"
          title="AMEX Import"
          description="Import your monthly AMEX statement CSV from Netアンサー."
        />
        <QuickLink
          href="/receipts/reconcile"
          title="Reconcile"
          description="Match AMEX statement lines to captured receipts."
        />
        <QuickLink
          href="/receipts/export"
          title="Monthly Export"
          description="Generate and archive the monthly accountant bundle."
        />
        <QuickLink
          href="/receipts/settings"
          title="Settings"
          description="Configure expense categories and export preferences."
        />
      </div>
    </div>
  );
}

function QuickLink({
  href,
  title,
  description,
  accent = false,
}: {
  href: string;
  title: string;
  description: string;
  accent?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`block rounded-2xl border p-4 shadow-sm transition-shadow hover:shadow-md ${
        accent
          ? "border-amber-200 bg-amber-50 hover:bg-amber-100"
          : "border-gray-200 bg-white hover:bg-gray-50"
      }`}
    >
      <p
        className={`text-sm font-semibold ${accent ? "text-amber-700" : "text-gray-900"}`}
      >
        {title}
      </p>
      <p className="mt-1 text-xs text-gray-500">{description}</p>
    </Link>
  );
}
