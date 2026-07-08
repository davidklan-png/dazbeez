# ADR 0003 — Compliance engine as a finalize gate

- **Status:** Accepted
- **Date:** 2026-07-08
- **Owner:** David (PM)
- **Affects:** `lib/receipts/month-closing.ts`, `lib/receipts/compliance.ts`, `lib/receipts/settings.ts`, `app/api/receipts/export/*`
- **Audits:** 2026-07-08 export review (activity A1)

## Context

`receipt_settings.export_block_on_warnings` existed in the schema and was surfaced in the compliance settings UI, but **no code path consulted it**. Open compliance checks (blocker or warning severity) did not gate export finalize. A receipt with an unresolved `blocker`-severity check (e.g. missing qualified invoice number on a ≥¥10k entertainment receipt) could ship in the monthly bundle without complaint. The setting was a documented control that did nothing — a bug, not a feature.

Separately, the export finalize path had drifted: `POST /api/receipts/export/month {finalize:true}` contained an inline finalize-blocker loop that validated AMEX lines only, while `POST /api/receipts/export/[month]` routed through `validateMonthReadyForExport()` which validated receipt-level fields too. One path could finalize a month the other would block — a real audit-9 drift incident.

## Decision

1. **Single enforcement authority.** Both finalize paths call `validateMonthReadyForExport(month)`. The inline loop was deleted. `lib/receipts/blockers.ts` (UI tiles) is presentation-only with a code comment cross-referencing month-closing.ts as the enforcement authority.

2. **Compliance-engine gate is part of the authority.** `validateMonthReadyForExport` calls `summarizeOpenChecksForMonth(db, month)`:
   - Open `blocker`-severity checks always block finalize.
   - Open `warning`-severity checks block only when `receipt_settings.export_block_on_warnings = true`.

3. The `export_block_on_warnings` setting is now the toggle the schema always promised. Operators who want warnings to pass through leave it false; operators who want a stricter gate turn it on. There is no hidden bypass.

## Consequences

- Finalize now fails on real compliance issues. Operators may need to resolve or dismiss checks before they can ship a month.
- The setting is the only escape hatch for warning-severity checks; blocker-severity checks have no bypass at finalize time (they must be resolved or explicitly dismissed via the compliance engine).
- The two finalize paths cannot drift again — they share one code path.
