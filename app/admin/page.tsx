import type { Metadata } from "next";
import {
  dashboardLastUpdated,
  dashboardKpis,
  serviceInterestBreakdown,
  leadPipeline,
  recentActivity,
  pendingActions,
} from "@/lib/admin-dashboard-data";
import { AdminDashboard } from "@/components/admin/admin-dashboard";

export const metadata: Metadata = {
  title: "Admin Dashboard — Dazbeez",
  description: "Internal dashboard for Dazbeez operations.",
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <AdminDashboard
        kpis={dashboardKpis}
        services={serviceInterestBreakdown}
        leads={leadPipeline}
        activity={recentActivity}
        actions={pendingActions}
        lastUpdatedLabel={dashboardLastUpdated}
      />
    </div>
  );
}
