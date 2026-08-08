ROLE: You are the WORKER. Small, urgent cleanup + one follow-up decision item.

# 1. Delete the 2026-06 smoke-test draft revision (URGENT)

During prod verification of the review-queue lock (step 7.4) the architect
created a draft revision for 2026-06 via the UI ("Create revision", reason
"Smoke test 7.4 …", revision 3, never rebuilt). The draft correctly
released the edit lock — which means 2026-06 CASH receipts are editable on
prod RIGHT NOW. There is no UI or API to discard a draft, so remove it
directly (it was never rebuilt; nothing is staged in R2):

```sql
-- confirm exactly one row first
SELECT id, export_month, status, created_at FROM receipt_exports
WHERE export_month = '2026-06' AND status = 'draft';
DELETE FROM receipt_exports WHERE export_month = '2026-06' AND status = 'draft';
```

Report the deleted row id. After deletion,
/receipts/review?month=2026-06 must again show "7 locked" — the architect
re-verifies in the browser.

# 2. Follow-up finding (implement only if the operator approves)

The smoke test exposed a product gap: "Create revision" exists but there
is no "Discard draft" control, so an abandoned correction leaves the
month's edit lock open indefinitely with no in-app way back. Proposed
follow-up (do NOT build yet — operator decision): a Discard-draft button
on the export page for never-rebuilt draft revisions, DELETE endpoint
with audit entry, gated to drafts that have a prior finalized revision.
