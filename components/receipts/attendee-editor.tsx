"use client";

interface AttendeeEditorProps {
  attendees: string[];
  onChange: (names: string[]) => void;
}

export function AttendeeEditor({ attendees, onChange }: AttendeeEditorProps) {
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

  return (
    <div className="space-y-2">
      {attendees.map((name, i) => (
        <div key={i} className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => update(i, e.target.value)}
            placeholder="Attendee name"
            className="flex-1 rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="rounded-xl border border-gray-200 px-3 py-2 text-xs text-gray-500 hover:bg-gray-50"
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="rounded-xl border border-dashed border-amber-300 px-3 py-2 text-xs font-medium text-amber-700 hover:bg-amber-50"
      >
        + Add attendee
      </button>
    </div>
  );
}
