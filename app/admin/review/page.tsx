import type { Metadata } from "next";
import Link from "next/link";
import { listReviewTasks } from "@/lib/crm";

export const metadata: Metadata = {
  title: "Review Queue — Dazbeez Admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AdminReviewQueuePage() {
  const tasks = await listReviewTasks();

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-2xl font-semibold text-gray-900">Review queue</h2>
      <p className="mt-2 text-sm text-gray-500">
        Low-confidence OCR, duplicate ambiguity, and unresolved batch issues are held here for human review.
      </p>

      <div className="mt-6 space-y-3">
        {tasks.length > 0 ? (
          tasks.map((task) => (
            <Link
              key={task.id}
              href={task.batchId ? `/admin/batches/${task.batchId}` : "/admin"}
              className="block rounded-2xl border border-gray-100 px-5 py-4 transition hover:border-amber-200 hover:bg-amber-50/60"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium text-gray-900">{task.title}</p>
                  <p className="mt-1 text-sm text-gray-500">
                    {task.taskType.replaceAll("_", " ")} · {task.entityType} #{task.entityId}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold capitalize text-amber-800">
                    {task.priority}
                  </span>
                  <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold capitalize text-gray-700">
                    {task.status}
                  </span>
                </div>
              </div>
            </Link>
          ))
        ) : (
          <p className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-sm text-gray-500">
            The review queue is empty.
          </p>
        )}
      </div>
    </div>
  );
}
