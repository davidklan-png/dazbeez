import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import {
  listAttendeeDirectory,
  listAttendeeNameReferenceCounts,
} from "@/lib/receipts/db";
import { AttendeeDirectoryManager } from "@/components/receipts/settings/attendee-directory-manager";

export const dynamic = "force-dynamic";

// Backlog #27 Part B: a management surface for the attendee directory (the
// company/title lookup behind the 参加者一覧 roster). Browse, edit company/title,
// and spot stale (no referencing receipts) + unregistered (referenced by a
// receipt but not in the directory — the source of attendee_unresolved at
// finalize). Editing does NOT change already-sealed months (the CSV is immutable
// in R2); it changes what FUTURE bundles resolve.

export default async function AttendeeDirectoryPage() {
  await assertReceiptsPageAccess();

  const [entries, refCountsMap] = await Promise.all([
    listAttendeeDirectory(),
    listAttendeeNameReferenceCounts(),
  ]);
  const referenceCounts: Record<string, number> = Object.fromEntries(refCountsMap);

  // Unregistered names: referenced by receipts but NOT in the directory. These
  // are exactly what produces attendee_unresolved at finalize.
  const directoryNames = new Set(entries.map((e) => e.name));
  const unregistered = [...refCountsMap.entries()]
    .filter(([name]) => !directoryNames.has(name))
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="space-y-6 px-8 py-8">
      <div>
        <h2 className="text-[20px] font-bold text-gray-900">Attendee directory</h2>
        <p className="mt-1 text-sm text-gray-500">
          The company/title lookup behind the 参加者一覧 roster.
        </p>
      </div>
      <AttendeeDirectoryManager
        entries={entries}
        referenceCounts={referenceCounts}
        unregistered={unregistered}
      />
    </div>
  );
}
