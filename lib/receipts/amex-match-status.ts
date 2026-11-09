import type { PillTone } from "@/components/ui/pill";
import type { AmexMatchStatus } from "@/lib/receipts/types";

/**
 * Statement-line match status → Pill props. Labels "Confirmed" and
 * "No receipt expected" are the exact strings the Reconcile screen uses
 * (reconcile-screen.tsx:1541-1543).
 */
export function amexMatchStatusPill(
  status: AmexMatchStatus,
): { tone: PillTone; label: string } {
  switch (status) {
    case "unmatched":
      return { tone: "amber", label: "No match" };
    case "matched":
      return { tone: "blue", label: "Matched" };
    case "confirmed":
      return { tone: "green", label: "Confirmed" };
    case "no_receipt":
      return { tone: "gray", label: "No receipt expected" };
  }
}
