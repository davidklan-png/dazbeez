// A small value-object that bundles "is this month finalized?" with the
// metadata UI surfaces need: a label, a reason for the lock, and a date.
// Pages fetch the finalized flag server-side and pass this down so client
// components can disable mutating controls upstream — instead of letting
// the user click a button and discover the 409 in a toast.

export type MonthLock = {
  /** True when the month is finalized (no further edits allowed). */
  locked: boolean;
  /** ISO timestamp the reconciliation was sealed, if any. */
  finalizedAt: string | null;
  /** Short label suitable for a Pill or badge ("Sealed" / "Draft"). */
  badge: "Sealed" | "Draft" | "Not built";
  /** One-line reason to surface in tooltips and confirm dialogs. */
  reason: string;
};

export function buildMonthLock(input: {
  finalized: boolean;
  finalizedAt?: string | null;
  hasDraft?: boolean;
}): MonthLock {
  if (input.finalized) {
    return {
      locked: true,
      finalizedAt: input.finalizedAt ?? null,
      badge: "Sealed",
      reason: "This month is finalized. Reopen reconciliation to edit.",
    };
  }
  if (input.hasDraft) {
    return {
      locked: false,
      finalizedAt: null,
      badge: "Draft",
      reason: "Reconciliation is in progress.",
    };
  }
  return {
    locked: false,
    finalizedAt: null,
    badge: "Not built",
    reason: "Reconciliation hasn't been started for this month.",
  };
}
