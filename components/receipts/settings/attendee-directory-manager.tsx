"use client";

import { useState } from "react";
import { Btn } from "@/components/ui/btn";
import { Card } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { Field, TextInput } from "@/components/ui/field";
import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";

// Backlog #27 Part B. Browse + edit company/title. Names are NOT editable
// (rename/merge would orphan receipt_attendees — free-text, no FK — and drift
// sealed-vs-unsealed resolution; see updateAttendeeDirectoryEntry). The sealed
// note below states the immutability guarantee.

export function AttendeeDirectoryManager({
  entries,
  referenceCounts,
  unregistered,
}: {
  entries: ReceiptAttendeeDirectoryEntry[];
  referenceCounts: Record<string, number>;
  unregistered: { name: string; count: number }[];
}) {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-800">
        Editing a name&apos;s company or title changes what <strong>future</strong>{" "}
        months resolve — it does <strong>not</strong> change already-sealed months.
        The 参加者一覧 CSV is sealed bytes in R2 at finalize time and is never
        regenerated from the directory. Names are not editable here (renaming would
        orphan referencing receipts).
      </div>

      <Card pad={0}>
        <div className="border-b border-gray-150 px-5 py-3">
          <span className="text-[13.5px] font-semibold text-gray-900">
            Directory entries
          </span>
          <span className="ml-2 text-[12px] text-gray-500">
            {entries.length} total
          </span>
        </div>
        <ul className="divide-y divide-gray-100">
          {entries.map((entry) => (
            <DirectoryEntryRow
              key={entry.id}
              entry={entry}
              count={referenceCounts[entry.name] ?? 0}
            />
          ))}
        </ul>
      </Card>

      {unregistered.length > 0 && (
        <Card pad={20}>
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold text-amber-700">
              Unregistered names
            </span>
            <Pill tone="amber" size="sm">{unregistered.length}</Pill>
          </div>
          <p className="mt-1 text-[12px] text-gray-500">
            Referenced by receipts but not in the directory. These produce the{" "}
            <code>attendee_unresolved</code> finalize blocker — register each (name,
            company, title) to clear it.
          </p>
          <ul className="mt-3 space-y-1 text-[12.5px]">
            {unregistered.map((u) => (
              <li key={u.name} className="flex items-center justify-between">
                <span className="font-medium text-gray-900">{u.name}</span>
                <span className="text-gray-500">{u.count} receipt{u.count === 1 ? "" : "s"}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function DirectoryEntryRow({
  entry,
  count,
}: {
  entry: ReceiptAttendeeDirectoryEntry;
  count: number;
}) {
  const [company, setCompany] = useState(entry.company);
  const [title, setTitle] = useState(entry.title);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = company.trim() !== entry.company || title.trim() !== entry.title;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/receipts/attendee-directory/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, title }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(json.error ?? "Save failed.");
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="px-5 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[13.5px] font-semibold text-gray-900">{entry.name}</div>
        <div className="shrink-0">
          {count === 0 ? (
            <Pill tone="gray" size="sm">no receipts · stale</Pill>
          ) : (
            <Pill tone="blue" size="sm">{count} receipt{count === 1 ? "" : "s"}</Pill>
          )}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Company">
          <TextInput value={company} onChange={(e) => setCompany(e.target.value)} />
        </Field>
        <Field label="Title">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
      </div>
      {error && (
        <p className="mt-1.5 text-[12px] text-red-600">{error}</p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Btn kind="primary" size="sm" onClick={save} disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save"}
        </Btn>
        {saved && <span className="text-[12px] text-green-600">Saved</span>}
        {!dirty && !saved && (
          <span className="text-[11.5px] text-gray-400">No changes</span>
        )}
      </div>
    </li>
  );
}
