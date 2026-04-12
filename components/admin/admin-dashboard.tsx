import type {
  KpiCard,
  ServiceInterest,
  LeadRow,
  ActivityItem,
  ActionItem,
} from "@/lib/admin-dashboard-data";

// ---- Small presentational helpers -----------------------------------------

function KpiCardEl({ label, value, change, trend }: KpiCard) {
  const colour =
    trend === "up"
      ? "text-green-600"
      : trend === "down"
        ? "text-red-500"
        : "text-gray-500";
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
      <p className={`mt-1 text-sm font-medium ${colour}`}>{change}</p>
    </div>
  );
}

function ServiceBar({ name, count, percent }: ServiceInterest) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-36 shrink-0 truncate text-sm text-gray-700">{name}</span>
      <div className="flex-1 h-3 rounded-full bg-gray-100 overflow-hidden">
        <div
          className="h-full rounded-full bg-amber-500"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="w-8 text-right text-sm text-gray-500">{count}</span>
    </div>
  );
}

const statusStyles: Record<LeadRow["status"], string> = {
  new: "bg-blue-100 text-blue-700",
  contacted: "bg-amber-100 text-amber-700",
  proposal: "bg-purple-100 text-purple-700",
  won: "bg-green-100 text-green-700",
  lost: "bg-red-100 text-red-700",
};

function StatusBadge({ status }: { status: LeadRow["status"] }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${statusStyles[status] ?? "bg-gray-100 text-gray-600"}`}
    >
      {status}
    </span>
  );
}

const priorityDot: Record<ActionItem["priority"], string> = {
  high: "bg-red-500",
  medium: "bg-amber-500",
  low: "bg-green-500",
};

// ---- Main component --------------------------------------------------------

interface AdminDashboardProps {
  kpis: KpiCard[];
  services: ServiceInterest[];
  leads: LeadRow[];
  activity: ActivityItem[];
  actions: ActionItem[];
  lastUpdatedLabel: string;
}

export function AdminDashboard({
  kpis,
  services,
  leads,
  activity,
  actions,
  lastUpdatedLabel,
}: AdminDashboardProps) {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500">Internal overview — not publicly linked</p>
        </div>
        <span className="text-xs text-gray-400">
          Last updated: {lastUpdatedLabel}
        </span>
      </div>

      {/* KPI cards */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <KpiCardEl key={k.label} {...k} />
        ))}
      </section>

      {/* Service interest + Lead pipeline */}
      <section className="grid gap-6 lg:grid-cols-2">
        {/* Service interest */}
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Service Interest</h2>
          <div className="space-y-3">
            {services.map((s) => (
              <ServiceBar key={s.name} {...s} />
            ))}
          </div>
        </div>

        {/* Lead pipeline */}
        <div className="rounded-xl border border-gray-200 bg-white p-5 overflow-x-auto">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Lead Pipeline</h2>
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="border-b text-gray-500">
                <th className="pb-2 font-medium">Company</th>
                <th className="pb-2 font-medium">Service</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={`${l.company}-${l.service}`} className="border-b last:border-0">
                  <td className="py-2">
                    <div className="font-medium text-gray-900">{l.company}</div>
                    <div className="text-xs text-gray-400">{l.contact}</div>
                  </td>
                  <td className="py-2 text-gray-600">{l.service}</td>
                  <td className="py-2">
                    <StatusBadge status={l.status} />
                  </td>
                  <td className="py-2 text-right font-medium text-gray-900">{l.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Activity + Pending actions */}
      <section className="grid gap-6 lg:grid-cols-2">
        {/* Recent activity */}
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Recent Activity</h2>
          <ul className="space-y-3">
            {activity.map((a) => (
              <li key={a.id} className="flex items-start gap-3 text-sm">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-400" />
                <div>
                  <span className="text-gray-700">{a.text}</span>
                  <span className="ml-2 text-gray-400">{a.time}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Pending actions */}
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Pending Actions</h2>
          <ul className="space-y-3">
            {actions.map((a) => (
              <li key={a.id} className="flex items-center gap-3 text-sm">
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${priorityDot[a.priority] ?? "bg-gray-400"}`}
                />
                <span className="text-gray-700">{a.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
