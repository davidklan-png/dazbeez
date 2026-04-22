import type { Metadata } from "next";
import Link from "next/link";
import { getDashboardSummary, listReviewTasks } from "@/lib/crm";

export const metadata: Metadata = {
  title: "Admin Dashboard — Dazbeez",
  description: "Internal CRM and business card ingestion dashboard for Dazbeez.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-gray-900">{value}</p>
      <p className="mt-2 text-sm text-gray-500">{hint}</p>
    </div>
  );
}

export default async function AdminPage() {
  const [summary, reviewTasks] = await Promise.all([
    getDashboardSummary(),
    listReviewTasks(),
  ]);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-gray-900 px-6 py-8 text-white shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-300">
          Internal Ops
        </p>
        <h2 className="mt-3 text-3xl font-semibold">Business card ingestion and bespoke CRM</h2>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-gray-300">
          Upload composite photos of paper cards, review multilingual extraction, deduplicate against the existing
          Dazbeez contact graph, keep evidence-backed enrichment, and prepare follow-up drafts without auto-sending.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/admin/batches"
            className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600"
          >
            Start a new batch
          </Link>
          <Link
            href="/admin/review"
            className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/5"
          >
            Open review queue
          </Link>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Contacts" value={summary.totalContacts} hint="Unified contacts across card, form, and admin capture sources." />
        <StatCard label="Needs Review" value={summary.needsReview} hint="Low-confidence extraction, dedupe ambiguity, or draft issues." />
        <StatCard label="Draft Ready" value={summary.draftReady} hint="Contacts with draft-ready or approved follow-up messages." />
        <StatCard label="Completed Batches" value={summary.completedBatches} hint="Batch uploads fully processed into CRM records." />
        <StatCard label="Open Review Tasks" value={summary.openReviewTasks} hint="Outstanding tasks that still need a human decision." />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Recent Batches</h3>
              <p className="mt-1 text-sm text-gray-500">Newest business-card uploads and their current state.</p>
            </div>
            <Link href="/admin/batches" className="text-sm font-medium text-amber-700 hover:text-amber-800">
              View all
            </Link>
          </div>
          <div className="mt-4 space-y-3">
            {summary.recentBatches.length > 0 ? (
              summary.recentBatches.map((batch) => (
                <Link
                  key={batch.id}
                  href={`/admin/batches/${batch.id}`}
                  className="block rounded-xl border border-gray-100 px-4 py-3 transition hover:border-amber-200 hover:bg-amber-50/60"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium text-gray-900">{batch.eventName || `Batch #${batch.id}`}</p>
                      <p className="text-sm text-gray-500">
                        {batch.detectedCardCount ?? 0} detected cards
                      </p>
                    </div>
                    <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold capitalize text-amber-800">
                      {batch.status}
                    </span>
                  </div>
                </Link>
              ))
            ) : (
              <p className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-sm text-gray-500">
                No ingestion batches have been created yet.
              </p>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Review Queue</h3>
              <p className="mt-1 text-sm text-gray-500">Human-in-the-loop checkpoints for extraction and dedupe.</p>
            </div>
            <Link href="/admin/review" className="text-sm font-medium text-amber-700 hover:text-amber-800">
              Open queue
            </Link>
          </div>
          <div className="mt-4 space-y-3">
            {reviewTasks.length > 0 ? (
              reviewTasks.slice(0, 6).map((task) => (
                <Link
                  key={task.id}
                  href={task.batchId ? `/admin/batches/${task.batchId}` : "/admin/review"}
                  className="block rounded-xl border border-gray-100 px-4 py-3 transition hover:border-amber-200 hover:bg-amber-50/60"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-gray-900">{task.title}</p>
                      <p className="mt-1 text-sm text-gray-500">{task.taskType.replaceAll("_", " ")}</p>
                    </div>
                    <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold capitalize text-gray-700">
                      {task.priority}
                    </span>
                  </div>
                </Link>
              ))
            ) : (
              <p className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-sm text-gray-500">
                No open review tasks right now.
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
