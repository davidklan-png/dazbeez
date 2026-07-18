"use client";

import { useState } from "react";
import { useId } from "react";
import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";

interface AttendeeEditorProps {
  attendees: string[];
  onChange: (names: string[]) => void;
  directory?: ReceiptAttendeeDirectoryEntry[];
  /**
   * Called when the operator registers a new attendee from this editor. The
   * parent merges it into its directory list so the row resolves for the rest
   * of the session (and the inline Company/Title inputs disappear).
   */
  onRegister?: (entry: ReceiptAttendeeDirectoryEntry) => void;
  /** When true (receipt sealed by a finalized export/reconciliation), every
   *  mutating control is disabled so the operator can read attendee values
   *  without being able to change them. */
  disabled?: boolean;
}

export function AttendeeEditor({
  attendees,
  onChange,
  directory = [],
  onRegister,
  disabled = false,
}: AttendeeEditorProps) {
  const listId = useId();
  // Per-row company/title drafts for attendee names that don't resolve against
  // the directory yet. Keyed by row index — these are ephemeral draft inputs
  // that clear once the name resolves (registration adds it to the directory,
  // so the matched branch takes over and the inputs unmount).
  const [drafts, setDrafts] = useState<Record<number, { company: string; title: string }>>({});
  const [registering, setRegistering] = useState<number | null>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);

  function add() {
    onChange([...attendees, ""]);
  }

  function update(index: number, value: string) {
    const next = attendees.slice();
    next[index] = value;
    onChange(next);
  }

  function remove(index: number) {
    onChange(attendees.filter((_, i) => i !== index));
  }

  function setDraft(index: number, field: "company" | "title", value: string) {
    setDrafts((prev) => {
      const existing = prev[index] ?? { company: "", title: "" };
      return { ...prev, [index]: { ...existing, [field]: value } };
    });
  }

  async function register(index: number, name: string) {
    const draft = drafts[index] ?? { company: "", title: "" };
    const company = draft.company.trim();
    const title = draft.title.trim();
    if (!company || !title) return;
    setRegistering(index);
    setRegisterError(null);
    try {
      const res = await fetch("/api/receipts/attendee-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), company, title }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        entry?: ReceiptAttendeeDirectoryEntry;
        error?: string;
      };
      if (!res.ok || !json.entry) {
        setRegisterError(json.error ?? "Registration failed");
        return;
      }
      onRegister?.(json.entry);
      // Clear this row's draft — the name now resolves, so the inline inputs
      // unmount and the matched helper takes over.
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
    } catch {
      setRegisterError("Network error");
    } finally {
      setRegistering(null);
    }
  }

  return (
    <div className="space-y-2">
      {attendees.map((name, i) => {
        const trimmed = name.trim();
        const matched = trimmed
          ? directory.find((d) => d.name === trimmed)
          : undefined;
        return (
          <div key={i} className="space-y-1.5">
            <div className="flex gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => update(i, e.target.value)}
                placeholder="Attendee name"
                disabled={disabled}
                list={directory.length > 0 ? listId : undefined}
                className="flex-1 rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:bg-gray-50 disabled:text-gray-500"
              />
              <button
                type="button"
                onClick={() => remove(i)}
                disabled={disabled}
                className="rounded-xl border border-gray-200 px-3 py-2 text-xs text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Remove
              </button>
            </div>
            {matched ? (
              <p className="pl-1 text-[11.5px] text-gray-500">
                {matched.company} — {matched.title}
              </p>
            ) : trimmed ? (
              <div className="ml-1 rounded-lg border border-dashed border-amber-300 bg-amber-50/60 px-3 py-2">
                <p className="text-[11.5px] text-amber-800">
                  Not in the directory — add company &amp; title to register this
                  attendee (required for finalize).
                </p>
                <div className="mt-1.5 flex flex-col gap-1.5 sm:flex-row">
                  <input
                    type="text"
                    value={drafts[i]?.company ?? ""}
                    onChange={(e) => setDraft(i, "company", e.target.value)}
                    placeholder="Company"
                    disabled={disabled}
                    className="flex-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs focus:border-amber-500 focus:outline-none disabled:bg-gray-50"
                  />
                  <input
                    type="text"
                    value={drafts[i]?.title ?? ""}
                    onChange={(e) => setDraft(i, "title", e.target.value)}
                    placeholder="Title"
                    disabled={disabled}
                    className="flex-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs focus:border-amber-500 focus:outline-none disabled:bg-gray-50"
                  />
                  <button
                    type="button"
                    onClick={() => register(i, trimmed)}
                    disabled={
                      disabled ||
                      registering === i ||
                      !drafts[i]?.company.trim() ||
                      !drafts[i]?.title.trim()
                    }
                    className="rounded-lg border border-amber-400 bg-amber-100 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {registering === i ? "Registering…" : "Register attendee"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      {directory.length > 0 && (
        <datalist id={listId}>
          {directory.map((entry) => (
            <option
              key={entry.id}
              value={entry.name}
              label={`${entry.company} - ${entry.title}`}
            />
          ))}
        </datalist>
      )}
      {registerError && (
        <p className="text-[11.5px] text-red-600">{registerError}</p>
      )}
      <button
        type="button"
        onClick={add}
        disabled={disabled}
        className="rounded-xl border border-dashed border-amber-300 px-3 py-2 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        + Add attendee
      </button>
    </div>
  );
}
