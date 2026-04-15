import type {
  KpiCard,
  ServiceInterest,
  LeadRow,
  ActivityItem,
  ActionItem,
} from "@/lib/admin-dashboard-data";
import { deleteNfcContact, updateNfcVCard } from "@/app/admin/actions";
import type { NfcAdminPanelData, NfcContactEventRow } from "@/lib/admin-nfc-dashboard";

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

function NfcSourceBadge({ source }: { source: "google" | "linkedin" | "manual" }) {
  return (
    <span className="inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold capitalize text-amber-800">
      {source}
    </span>
  );
}

function NfcEventBadge({ source }: { source: NfcContactEventRow["source"] }) {
  const styles =
    source === "linkedin"
      ? "bg-blue-100 text-blue-800"
      : source === "google"
        ? "bg-green-100 text-green-800"
        : "bg-amber-100 text-amber-800";

  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${styles}`}>
      {source}
    </span>
  );
}

function VCardField({
  name,
  label,
  defaultValue,
  placeholder,
  type = "text",
}: {
  name: string;
  label: string;
  defaultValue: string;
  placeholder?: string;
  type?: "text" | "email" | "url";
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
        {label}
      </span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="mt-2 w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm outline-none transition-colors focus:border-amber-400"
      />
    </label>
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
  nfc: NfcAdminPanelData;
}

export function AdminDashboard({
  kpis,
  services,
  leads,
  activity,
  actions,
  lastUpdatedLabel,
  nfc,
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

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">NFC vCard Profile</h2>
            <p className="mt-1 text-sm text-gray-500">
              Edit the contact card that downloads from the NFC flow. These values also drive the saved-contact confirmation sheet.
            </p>
          </div>
          {nfc.status === "ready" ? (
            <span className="text-xs text-gray-400">Synced {nfc.fetchedAtLabel}</span>
          ) : null}
        </div>

        {nfc.status === "ready" ? (
          <form action={updateNfcVCard} className="mt-6 space-y-6">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <VCardField name="fullName" label="Full Name" defaultValue={nfc.vcardProfile.fullName} />
              <VCardField name="givenName" label="Given Name" defaultValue={nfc.vcardProfile.givenName} />
              <VCardField name="familyName" label="Family Name" defaultValue={nfc.vcardProfile.familyName} />
              <VCardField name="organization" label="Organization" defaultValue={nfc.vcardProfile.organization} />
              <VCardField name="title" label="Title" defaultValue={nfc.vcardProfile.title} />
              <VCardField name="fileName" label="File Name" defaultValue={nfc.vcardProfile.fileName} placeholder="david-klan.vcf" />
              <VCardField name="email" label="Email" type="email" defaultValue={nfc.vcardProfile.email} />
              <VCardField name="website" label="Website" type="url" defaultValue={nfc.vcardProfile.website} />
              <VCardField name="linkedin" label="LinkedIn" type="url" defaultValue={nfc.vcardProfile.linkedin} />
            </div>

            <div className="flex flex-col gap-3 rounded-2xl border border-amber-100 bg-amber-50 px-4 py-4 text-sm text-amber-900 md:flex-row md:items-center md:justify-between">
              <p>
                Saving here updates the live `.vcf` download and the “what was saved and where” sheet on the NFC pages.
              </p>
              <button
                type="submit"
                className="inline-flex items-center justify-center rounded-full bg-amber-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-amber-600"
              >
                Save vCard Profile
              </button>
            </div>
          </form>
        ) : (
          <p className="mt-4 rounded-xl border border-dashed border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            NFC vCard settings are unavailable until the admin API feed is configured.
          </p>
        )}
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.05fr_1.35fr]">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">NFC Card Metrics</h2>
              <p className="mt-1 text-sm text-gray-500">
                Live conversion data from the networking-card app.
              </p>
            </div>
            {nfc.status === "ready" ? (
              <span className="text-xs text-gray-400">
                Synced {nfc.fetchedAtLabel}
              </span>
            ) : null}
          </div>

          {nfc.status === "ready" ? (
            <div className="mt-4 space-y-3">
              {nfc.metrics.length > 0 ? (
                nfc.metrics.map((metric) => (
                  <div
                    key={metric.token}
                    className="rounded-xl border border-gray-100 bg-gray-50 p-4"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-medium text-gray-900">
                          {metric.label || metric.token}
                        </div>
                        <div className="text-xs text-gray-500">{metric.token}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-semibold text-gray-900">
                          {Math.round(metric.conversion_rate * 100)}%
                        </div>
                        <div className="text-xs text-gray-500">tap-to-contact</div>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-lg bg-white p-3">
                        <div className="text-gray-500">Taps</div>
                        <div className="mt-1 text-xl font-semibold text-gray-900">
                          {metric.tap_count}
                        </div>
                      </div>
                      <div className="rounded-lg bg-white p-3">
                        <div className="text-gray-500">Contacts</div>
                        <div className="mt-1 text-xl font-semibold text-gray-900">
                          {metric.contact_count}
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <p className="rounded-xl border border-dashed border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">
                  No NFC card metrics yet.
                </p>
              )}
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-dashed border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              {nfc.message}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5 overflow-x-auto">
          <h2 className="text-lg font-semibold text-gray-900">Recent NFC Contacts</h2>
          <p className="mt-1 text-sm text-gray-500">
            Merged contacts captured from card taps and QR scans. Methods used stay attached to the same person.
          </p>

          {nfc.status === "ready" ? (
            nfc.contacts.length > 0 ? (
              <table className="mt-4 w-full text-sm text-left">
                <thead>
                  <tr className="border-b text-gray-500">
                    <th className="pb-2 font-medium">Contact</th>
                    <th className="pb-2 font-medium">Source</th>
                    <th className="pb-2 font-medium">Card</th>
                    <th className="pb-2 font-medium">Location</th>
                    <th className="pb-2 font-medium text-right">Created</th>
                    <th className="pb-2 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {nfc.contacts.slice(0, 12).map((contact) => (
                    <tr key={contact.id} className="border-b last:border-0">
                      <td className="py-3">
                        <div className="font-medium text-gray-900">{contact.name}</div>
                        <div className="text-xs text-gray-500">{contact.email}</div>
                        {contact.company ? (
                          <div className="text-xs text-gray-400">{contact.company}</div>
                        ) : null}
                      </td>
                      <td className="py-3">
                        <div className="flex flex-wrap justify-start gap-1.5">
                          {(contact.sources.length > 0 ? contact.sources : [contact.source]).map((source) => (
                            <NfcSourceBadge key={`${contact.id}-${source}`} source={source} />
                          ))}
                        </div>
                      </td>
                      <td className="py-3 text-gray-600">{contact.token}</td>
                      <td className="py-3 text-gray-600">
                        {[contact.cf_city, contact.cf_country].filter(Boolean).join(", ") || "—"}
                      </td>
                      <td className="py-3 text-right text-gray-500">{contact.created_at}</td>
                      <td className="py-3 text-right">
                        <form action={deleteNfcContact.bind(null, contact.id)}>
                          <button
                            type="submit"
                            className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50"
                          >
                            Delete
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-4 rounded-xl border border-dashed border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">
                No NFC contacts captured yet.
              </p>
            )
          ) : (
            <p className="mt-4 rounded-xl border border-dashed border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              NFC contacts are unavailable until the admin API feed is configured.
            </p>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5 overflow-x-auto">
        <h2 className="text-lg font-semibold text-gray-900">NFC Registration Activity</h2>
        <p className="mt-1 text-sm text-gray-500">
          Every Google, LinkedIn, and manual registration event is logged here even when the contact is deduped.
        </p>

        {nfc.status === "ready" ? (
          nfc.events.length > 0 ? (
            <table className="mt-4 w-full text-sm text-left">
              <thead>
                <tr className="border-b text-gray-500">
                  <th className="pb-2 font-medium">Contact</th>
                  <th className="pb-2 font-medium">Method</th>
                  <th className="pb-2 font-medium">Card</th>
                  <th className="pb-2 font-medium text-right">Captured</th>
                </tr>
              </thead>
              <tbody>
                {nfc.events.slice(0, 16).map((event) => (
                  <tr key={event.id} className="border-b last:border-0">
                    <td className="py-3">
                      <div className="font-medium text-gray-900">{event.name}</div>
                      <div className="text-xs text-gray-500">{event.email}</div>
                    </td>
                    <td className="py-3">
                      <NfcEventBadge source={event.source} />
                    </td>
                    <td className="py-3 text-gray-600">{event.token}</td>
                    <td className="py-3 text-right text-gray-500">{event.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-4 rounded-xl border border-dashed border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">
              No NFC registration activity recorded yet.
            </p>
          )
        ) : (
          <p className="mt-4 rounded-xl border border-dashed border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            NFC registration activity is unavailable until the admin API feed is configured.
          </p>
        )}
      </section>
    </div>
  );
}
