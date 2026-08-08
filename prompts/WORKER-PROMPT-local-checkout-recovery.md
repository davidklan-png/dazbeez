ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Recover local checkout after the ADR 0011 merge

Pure recovery task. No feature work. Do not commit anything unless a step
below explicitly says to.

## Background

PR #131 (ADR 0011 email receipt intake) merged to `origin/master` at
`909e313` (commit `d455084` under it). This local checkout, however, is
currently sitting at the pre-merge commit (`13e6abc`) with the entire ADR
0011 file set missing from disk — `lib/receipts/email-intake.ts`,
`workers/receipts-email-intake/`, `docs/adr/0011-email-receipt-intake.md`,
`db/receipts/0024_email_intake.sql` / `0025_email_intake_to_address.sql`,
the inbox screens, etc. This does NOT affect production — the deploy
pipeline builds from the pushed/merged commit on GitHub, not from this
local folder — but the local tree needs to be brought back in sync before
any further work happens here.

Separately, there are four **pre-existing, unrelated dirty files** that
predate this whole feature and must survive the recovery unchanged:
`components/receipts/amex-import-form.tsx`, `lib/receipts/validation.ts`,
`scripts/fix-2016-date-anomaly.ts`, `tests/receipts/amex-parser.test.ts`.
Do not stash-and-drop them, do not discard them, do not "clean up" them as
part of this task — they are someone else's in-progress work.

## Precondition (operator-confirmed, not yours to verify)

David has confirmed no other Claude Code / git session is actively running
against this folder before invoking this prompt. You should still do the
lock/process checks in §1 as a second safety net, but you are not expected
to somehow prove a negative on your own — if §1 finds anything ambiguous,
stop and report rather than guessing.

## Hard rules (from AGENTS.md — read that section before starting)

`AGENTS.md` § "Known risk: shared filesystem" documents that
`git reset --hard` destroyed the architect's uncommitted work twice in one
day on this exact setup, and lays out hard rules adopted afterward:

- **NEVER run `git reset --hard`, `git checkout -- <path>`, `git clean`,
  or `git stash drop`** while the working tree has modifications you
  didn't make. This applies here — the four pre-existing dirty files are
  exactly the kind of "modifications you didn't make."
- **The sanctioned recovery is `git checkout -b <branch> origin/master`**,
  which carries uncommitted changes across onto the new branch (and
  refuses, rather than silently overwriting, if a real conflict exists).
  Use this, not reset.
- **If a destructive command seems necessary at any point, stop and
  report** instead of running it.

## 1. Investigate FIRST (read-only, include full output in report)

1. `git status --short` — confirm the current dirty/untracked file list
   matches what's expected (the four pre-existing files above; plus
   whatever pre-existing untracked paths were already there —
   `.agents/`, `DazbeezCapture/`, `attendee-fix-input.md`,
   `docs/receipts-operating-manual-ja.pdf`, `external/`,
   `ios-dazbeezcapture.xcworkspace/`, `skills-lock.json` — these are NOT
   part of this feature, leave them exactly as they are).
2. `git log --oneline -5` (local HEAD) and confirm it's `13e6abc` or
   later — report the actual value, don't assume it hasn't moved since
   this prompt was written.
3. `ls -la .git/*.lock .git/**/*.lock 2>/dev/null` (or equivalent) — list
   any lock files present with their mtimes. If any lock file's mtime is
   within the last few minutes (plausible sign of an active concurrent
   process), STOP and report — do not proceed to §2. If lock files are
   stale (old mtime, no plausible active process) it is fine to note them
   and continue; do not delete them yet, that happens naturally as part
   of normal git operations succeeding, or explicitly in §4 if still
   present afterward.
4. `git fetch origin` (safe — read-only against the remote, only updates
   local remote-tracking refs).
5. `git log --oneline origin/master -5` — confirm `909e313` (and
   `d455084` beneath it) are present. If not, STOP — the premise of this
   whole recovery is wrong and needs the architect to re-check.
6. For each of the four pre-existing dirty files, run
   `git diff HEAD origin/master -- <path>` and confirm origin/master's
   version is IDENTICAL to local HEAD's version for that file (i.e., the
   merge didn't touch them, matching the prior report's claim that they
   were deliberately excluded from the ADR 0011 commit). If any of the
   four differs between HEAD and origin/master, STOP and report — that
   changes the safety analysis for §2 and needs an explicit decision
   before proceeding (a real conflict between your local edit and the
   merged change is possible in that case).

## 2. Recovery

Only proceed here if §1 raised no stop conditions.

```
git checkout -b receipts/local-checkout-recovery origin/master
```

This is the AGENTS.md-sanctioned method: it moves the working tree to
match `origin/master` while carrying your uncommitted local modifications
(the four pre-existing dirty files) forward, and refuses with a clear
error — rather than silently discarding anything — if git finds an actual
conflict. If it refuses: STOP, report the exact error and file list,
do not force past it with any of the forbidden commands above.

Do not delete or move the local `master` branch pointer in this step —
leave it as-is at `13e6abc` for now (optional low-risk cleanup for it is
in §5, separate from the working-tree recovery).

## 3. Verify the recovery actually worked

1. Confirm the previously-missing files are back and non-empty:
   `lib/receipts/email-intake.ts`, `lib/receipts/email-parse.ts`,
   `workers/receipts-email-intake/src/index.ts`,
   `docs/adr/0011-email-receipt-intake.md`,
   `db/receipts/0024_email_intake.sql`,
   `db/receipts/0025_email_intake_to_address.sql`,
   `app/(receipt-system)/receipts/inbox/page.tsx`,
   `components/receipts/inbox/inbox-row.tsx`.
2. Confirm the four pre-existing dirty files are STILL showing as
   modified in `git status --short` with their expected in-progress
   content (spot-check: they should NOT match origin/master's or HEAD's
   committed content — if `git status` now shows them as clean, the
   recovery silently ate someone's uncommitted work and that is a
   BLOCKER — stop and report immediately, do not continue to §4).
3. Confirm the untracked-but-not-part-of-this-feature paths listed in
   §1.1 are still present and untouched.
4. `git status --short` in full, included in your report.

## 4. Health check on the recovered tree

Standard verification ritual, same as every other prompt in this repo:

1. `npx tsc --noEmit` — clean.
2. `npm test` — report pass/fail counts; you should land back at the
   last-known-good baseline (611 tests / 610 pass / 1 skip) since nothing
   new was written in this pass.
3. `npm run build:cf` — clean.
4. `cd workers/receipts-email-intake && npx tsc --noEmit` — clean.

If any of these fail where they previously passed, STOP and report —
do not attempt fixes as part of a "recovery" task; that's scope creep
into feature work and needs the architect to triage.

## 5. Optional, low-risk cleanup (do only after §3–4 are fully green)

`git branch -f master origin/master` — this only moves the local `master`
ref forward (a fast-forward; local master had no unique commits of its
own, it was purely behind). It does NOT touch the working tree and is
safe specifically because you are NOT currently checked out on `master`
(you're on `receipts/local-checkout-recovery` from §2). Do this only if
you want local `master` to stop being stale for next time — it's a
convenience, not required. Report whether you did it.

Do not delete the `receipts/local-checkout-recovery` branch, don't merge
it into anything, don't push it. Leave the working tree checked out on it
(or on `master` if you did §5 and separately checked back onto it —
either is fine, report which).

## 6. Report

State plainly: did §1 find any stop conditions (and if so, where you
stopped), the exact recovery command outcome, the §3 file/status checks
(especially the "did the pre-existing dirty files survive" check — this
is the single most important thing to get right), and the §4 verification
results. Do not commit, push, or deploy anything in this pass.
