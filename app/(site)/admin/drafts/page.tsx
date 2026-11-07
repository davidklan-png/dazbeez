import type { Metadata } from "next";
import Link from "next/link";
import { listDrafts } from "@/lib/crm";

export const metadata: Metadata = {
  title: "Draft Emails — Dazbeez Admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AdminDraftsPage() {
  const drafts = await listDrafts();

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-2xl font-semibold text-gray-900">Draft emails</h2>
      <p className="mt-2 text-sm text-gray-500">
        Personalized follow-up drafts are kept here for review, copy, and future send integration.
      </p>

      <div className="mt-6 space-y-4">
        {drafts.length > 0 ? (
          drafts.map((draft) => (
            <div key={draft.id} className="rounded-2xl border border-gray-100 p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium text-gray-900">{draft.subjectLine}</p>
                  <p className="mt-1 text-sm text-gray-500">
                    <Link href={`/admin/contacts/${draft.contactId}`} className="text-amber-700 hover:text-amber-800">
                      {draft.contactName}
                    </Link>
                    {draft.companyName ? ` · ${draft.companyName}` : ""}
                  </p>
                </div>
                <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold capitalize text-gray-700">
                  {draft.status}
                </span>
              </div>
              <p className="mt-3 text-sm text-gray-700">{draft.rationaleSummary}</p>
              <p className="mt-2 text-xs text-gray-500">{draft.createdAt}</p>
            </div>
          ))
        ) : (
          <p className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-sm text-gray-500">
            No email drafts have been generated yet.
          </p>
        )}
      </div>
    </div>
  );
}
