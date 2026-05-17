import Link from "next/link";
import {
  getMissingStatementAlerts,
  listAmexLineCountsByMonth,
  listExports,
  listReceiptRecords,
} from "@/lib/receipts/db";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { headers } from "next/headers";
import { AmexMissingStatementAlert } from "@/components/receipts/amex-missing-statement-alert";
import { Card } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { ArrowRightIcon, CameraIcon } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

type QuickLink = {
  href: string;
  title: string;
  description: string;
  emoji: string;
  accent?: boolean;
};

const QUICK_LINKS: QuickLink[] = [
  {
    href: "/receipts/capture?mode=rapid",
    title: "Capture",
    description: "Photograph or drop in receipts.",
    emoji: "📷",
    accent: true,
  },
  {
    href: "/receipts/review",
    title: "Review queue",
    description: "Verify OCR and add attendees.",
    emoji: "📝",
  },
  {
    href: "/receipts/amex",
    title: "AMEX import",
    description: "Upload Netアンサー CSV.",
    emoji: "💳",
  },
  {
    href: "/receipts/reconcile",
    title: "Reconcile",
    description: "Match statement lines to receipts.",
    emoji: "🔗",
  },
  {
    href: "/receipts/export",
    title: "Monthly export",
    description: "Build, review, finalize.",
    emoji: "📦",
  },
  {
    href: "/receipts/settings",
    title: "Settings",
    description: "Devices and preferences.",
    emoji: "⚙️",
  },
];

export default async function ReceiptsDashboardPage() {
  await assertReceiptsPageAccess();

  const month = new Date().toISOString().slice(0, 7);

  let missingAlerts: Awaited<ReturnType<typeof getMissingStatementAlerts>> = [];
  try {
    const actor = await requireReceiptsActor(await headers());
    missingAlerts = await getMissingStatementAlerts(actor);
  } catch {
    /* alerts optional */
  }

  const [monthReceipts, allLines, exports] = await Promise.all([
    listReceiptRecords({ month, limit: 1000 }),
    listAmexLineCountsByMonth(),
    listExports(),
  ]);

  const unreviewed = monthReceipts.filter(
    (r) => r.status === "captured" || r.status === "needs_review",
  ).length;
  const reviewed = monthReceipts.filter((r) => r.status === "reviewed").length;
  const exportedCount = monthReceipts.filter(
    (r) => r.status === "exported" || r.status === "archived",
  ).length;
  const lineStats = allLines.get(month) ?? { total: 0, unmatched: 0 };
  const monthExport = exports.find((e) => e.export_month === month) ?? null;

  return (
    <div className="px-8 py-8">
      <div className="mb-6 flex items-end gap-3">
        <h2 className="text-[26px] font-bold text-gray-900">Dashboard</h2>
        <span className="pb-0.5 text-sm text-gray-500">
          {formatMonth(month)} at a glance
        </span>
      </div>

      {missingAlerts.length > 0 && (
        <div className="mb-6 space-y-3">
          {missingAlerts.map((alert) => (
            <AmexMissingStatementAlert
              key={alert.statementMonth}
              statementMonth={alert.statementMonth}
              expectedReadyDate={alert.expectedReadyDate}
            />
          ))}
        </div>
      )}

      {/* "This month at a glance" */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Receipts captured"
          value={monthReceipts.length.toString()}
          sub={`${unreviewed} unreviewed`}
          accent={unreviewed > 0}
        />
        <StatTile
          label="AMEX lines"
          value={lineStats.total.toString()}
          sub={`${lineStats.unmatched} unmatched`}
          accent={lineStats.unmatched > 0}
        />
        <StatTile
          label="Reviewed"
          value={reviewed.toString()}
          sub={`${exportedCount} exported`}
        />
        <StatTile
          label="Export status"
          value={
            monthExport?.status === "finalized"
              ? "Sealed"
              : monthExport
                ? "Draft"
                : "Not built"
          }
          sub={
            monthExport?.status === "finalized"
              ? "Immutable"
              : "Run reconcile + finalize"
          }
        />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {QUICK_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={[
              "group flex items-start gap-3.5 rounded-2xl border p-4 transition-all duration-200",
              link.accent
                ? "border-amber-200 bg-amber-50 hover:border-amber-300 hover:shadow-md"
                : "border-gray-200 bg-white hover:border-amber-300 hover:shadow-md",
            ].join(" ")}
          >
            <span className="text-[22px]">{link.emoji}</span>
            <div className="flex-1">
              <div
                className={[
                  "text-[14px] font-semibold",
                  link.accent ? "text-amber-700" : "text-gray-900",
                ].join(" ")}
              >
                {link.title}
              </div>
              <div className="mt-0.5 text-[12px] text-gray-500">
                {link.description}
              </div>
            </div>
            <ArrowRightIcon
              size={16}
              className={[
                "mt-1 transition-transform group-hover:translate-x-0.5",
                link.accent ? "text-amber-600" : "text-gray-400",
              ].join(" ")}
            />
          </Link>
        ))}
      </div>

      <Card className="mt-8">
        <div className="flex items-center gap-3.5">
          <CameraIcon size={20} className="text-amber-600" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-gray-900">
              Capture on phone
            </div>
            <div className="text-xs text-gray-500">
              Bookmark the rapid-capture URL on your home screen for the fastest path.
            </div>
          </div>
          <Pill tone="amber" size="sm">
            iPhone-first
          </Pill>
          <Link
            href="/receipts/capture?mode=rapid"
            className="text-[12px] font-semibold text-amber-700 hover:text-amber-800"
          >
            Open →
          </Link>
        </div>
      </Card>
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <Card>
      <div className="text-[11px] font-bold uppercase tracking-[0.05em] text-gray-500">
        {label}
      </div>
      <div
        className={[
          "mt-1.5 text-[26px] font-bold tabular-nums",
          accent ? "text-amber-700" : "text-gray-900",
        ].join(" ")}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[12px] text-gray-500">{sub}</div>
    </Card>
  );
}

function formatMonth(month: string): string {
  try {
    const [y, m] = month.split("-").map(Number);
    if (!y || !m) return month;
    return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
  } catch {
    return month;
  }
}
