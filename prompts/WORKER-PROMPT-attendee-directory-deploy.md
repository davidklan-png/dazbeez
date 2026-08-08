ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Attendee directory: ship it, verify on prod, scout the revert path

Your previous task (attendee directory / company+title in the export
bundle) was implemented and independently verified by the architect —
suite green, migration seed confirmed byte-exact, gate and route wiring
correct. Operator decision: **deploy first, fix attendee data after.**
The operator will handle the 10 unresolved names himself post-deploy
(renames + registrations via the UI, reverting the sealed month if
necessary).

## Part 1 — Commit, PR, merge, deploy

1. Branch per the AGENTS.md workflow. Commit ONLY the files belonging to
   this change:
   - the 17 modified files from your previous report
   - new: `db/receipts/0022_attendee_directory.sql`,
     `app/api/receipts/attendee-directory/` (route),
     `tests/receipts/attendee-directory.test.ts`
   Do NOT commit the other untracked paths (`prompts/WORKER-PROMPT-*.md`,
   `.agents/`, `DazbeezCapture/`, `external/`, `skills-lock.json`,
   `docs/receipts-operating-manual-ja.pdf`, `ios-dazbeezcapture.xcworkspace/`)
   — pre-existing operator files, not yours to touch. No destructive git
   per the hard rules.
2. Suggested commit message:
   `receipts: attendee directory in D1 + AttendeeIds column + 参加者一覧 export artifact`
   Body: reference the business-manager review comment (attendee
   company/title on 会議費/接待交際費 rows) and the finalize-gate change.
3. Push, open PR, merge, `npm run deploy`.
4. `bash scripts/check-deployment.sh <base-url>` post-deploy smoke test.

## Part 2 — Prod verification (the two steps Clerk blocked locally)

5. On dazbeez.com: rebuild the DRAFT for the settled month. Confirm:
   - receipts CSV has `AttendeeIds` after `Attendees`, with `?` markers
     on rows whose attendee names are among the 10 unresolved
   - `参加者一覧.csv` downloads standalone AND is present inside the
     proofs ZIP with identical bytes
   - the export page shows the 参加者一覧 download link
6. Review UI: open a receipt with attendees, type a throwaway name
   (e.g. `ZZ-TEST DELETE ME`), confirm the inline Company/Title register
   flow works end-to-end (entry persists, name resolves, helper text
   shows `company — title`). Then delete the throwaway row from live D1
   (`DELETE FROM attendee_directory WHERE name = 'ZZ-TEST DELETE ME'`)
   and confirm count returns to 66.
7. Confirm finalize is correctly BLOCKED right now: attempt finalize on
   the settled month's draft (or read the blockers from the validate
   response) and verify the unresolved-attendee blockers list the
   expected names. Do not force anything — blocked is the correct state
   until the operator fixes the data.

## Part 3 — READ-ONLY investigation: the revert path

The operator intends to revert the sealed month to edit attendee data.
Known trap (AGENTS.md backlog #7): the finalized-reconciliation guard
locks receipt edits, and an unfinalize flow has never been verified to
exist. Attendee edits flow through the guarded receipt path
(`createAttendees` via the receipt PATCH route). Investigate and REPORT
FACTS — build nothing, change nothing:

a. Does any code path unfinalize an `amex_reconciliations` row (UI or
   API)? Name the route/function or state that none exists.
b. Does `createExportRevision` / the export revision flow unlock receipt
   edits, or does the reconciliation guard still block them while a
   revision draft is open?
c. Exactly which guard blocks a PATCH to a receipt (attendees field) in
   a finalized month — file and function.
d. Given a–c, list the minimal viable sequences for the operator to get
   attendee names corrected on the sealed month's receipts (e.g.
   "unfinalize reconciliation → edit → re-finalize → export revision" if
   possible, or "direct D1 UPDATE on receipt_attendees is the only path").
   If direct SQL is the only path, say so plainly — the architect will
   spec it as a follow-up.

## Report back

Commit SHA + PR number, deploy + smoke-test results, prod verification
results for steps 5–7 (including the blocker list from step 7), and the
Part 3 findings (a–d) with file/function references.
