import type { Metadata } from "next";
import Link from "next/link";
import { listContacts } from "@/lib/crm";

export const metadata: Metadata = {
  title: "Contacts — Dazbeez Admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AdminContactsPage() {
  const contacts = await listContacts();

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Contacts</h2>
          <p className="mt-2 text-sm text-gray-500">
            Unified CRM contacts across NFC capture, public forms, and paper-card batch ingestion.
          </p>
        </div>
      </div>

      <div className="mt-6 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-gray-500">
              <th className="px-3 py-3 font-medium">Contact</th>
              <th className="px-3 py-3 font-medium">Source</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th className="px-3 py-3 font-medium">Synergy</th>
              <th className="px-3 py-3 font-medium">Draft</th>
              <th className="px-3 py-3 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((contact) => (
              <tr key={contact.id} className="border-b border-gray-100 last:border-0">
                <td className="px-3 py-4">
                  <Link href={`/admin/contacts/${contact.id}`} className="font-medium text-gray-900 hover:text-amber-700">
                    {contact.name}
                  </Link>
                  <div className="text-xs text-gray-500">
                    {[contact.email, contact.company].filter(Boolean).join(" · ") || "No email or company"}
                  </div>
                </td>
                <td className="px-3 py-4 text-gray-700">{contact.source}</td>
                <td className="px-3 py-4">
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold capitalize text-amber-800">
                    {contact.status}
                  </span>
                </td>
                <td className="px-3 py-4 text-gray-700">{contact.synergyScore ?? "—"}</td>
                <td className="px-3 py-4 text-gray-700">{contact.draftStatus ?? "—"}</td>
                <td className="px-3 py-4 text-gray-500">{contact.updatedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
