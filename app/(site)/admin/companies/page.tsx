import type { Metadata } from "next";
import { listCompanies } from "@/lib/crm";

export const metadata: Metadata = {
  title: "Companies — Dazbeez Admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AdminCompaniesPage() {
  const companies = await listCompanies();

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-2xl font-semibold text-gray-900">Companies</h2>
      <p className="mt-2 text-sm text-gray-500">
        Company records linked to contacts, enrichment facts, and outreach drafts.
      </p>

      <div className="mt-6 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-gray-500">
              <th className="px-3 py-3 font-medium">Company</th>
              <th className="px-3 py-3 font-medium">Website</th>
              <th className="px-3 py-3 font-medium">Industry</th>
              <th className="px-3 py-3 font-medium">Contacts</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th className="px-3 py-3 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((company) => (
              <tr key={company.id} className="border-b border-gray-100 last:border-0">
                <td className="px-3 py-4 font-medium text-gray-900">{company.name}</td>
                <td className="px-3 py-4 text-gray-700">{company.website || company.websiteDomain || "—"}</td>
                <td className="px-3 py-4 text-gray-700">{company.industry || "—"}</td>
                <td className="px-3 py-4 text-gray-700">{company.contactCount}</td>
                <td className="px-3 py-4">
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold capitalize text-amber-800">
                    {company.status}
                  </span>
                </td>
                <td className="px-3 py-4 text-gray-500">{company.updatedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
