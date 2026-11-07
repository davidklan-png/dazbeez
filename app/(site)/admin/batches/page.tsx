import type { Metadata } from "next";
import Link from "next/link";
import { BatchUploadForm } from "@/components/admin/batch-upload-form";
import { listBatches } from "@/lib/crm";

export const metadata: Metadata = {
  title: "Batch Uploads — Dazbeez Admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AdminBatchesPage() {
  const batches = await listBatches();

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="max-w-3xl">
          <h2 className="text-2xl font-semibold text-gray-900">Business card batch ingestion</h2>
          <p className="mt-2 text-sm leading-7 text-gray-500">
            Upload a composite image, detect each paper card, crop it, extract bilingual contact data, and create a
            reviewable CRM batch inside the admin.
          </p>
        </div>
        <div className="mt-6">
          <BatchUploadForm />
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Existing batches</h3>
            <p className="mt-1 text-sm text-gray-500">Each batch keeps upload metadata, review state, and downstream CRM activity.</p>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-gray-500">
                <th className="px-3 py-3 font-medium">Batch</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium">Detected</th>
                <th className="px-3 py-3 font-medium">Contacts</th>
                <th className="px-3 py-3 font-medium">Needs review</th>
                <th className="px-3 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {batches.length > 0 ? (
                batches.map((batch) => (
                  <tr key={batch.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-4">
                      <Link href={`/admin/batches/${batch.id}`} className="font-medium text-gray-900 hover:text-amber-700">
                        {batch.eventName || `Batch #${batch.id}`}
                      </Link>
                      <div className="text-xs text-gray-500">
                        {[batch.eventDate, batch.eventLocation].filter(Boolean).join(" · ") || "No event metadata"}
                      </div>
                    </td>
                    <td className="px-3 py-4">
                      <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold capitalize text-amber-800">
                        {batch.status}
                      </span>
                    </td>
                    <td className="px-3 py-4 text-gray-700">{batch.detectedCardCount ?? 0}</td>
                    <td className="px-3 py-4 text-gray-700">
                      {batch.createdContactsCount} new / {batch.updatedContactsCount} updated
                    </td>
                    <td className="px-3 py-4 text-gray-700">{batch.needsReviewCount}</td>
                    <td className="px-3 py-4 text-gray-500">{batch.createdAt}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-gray-500">
                    No batch uploads yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
