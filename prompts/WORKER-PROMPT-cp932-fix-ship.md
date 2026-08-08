ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session, no live D1/R2 bindings) designed the following change and
needs it executed, verified, and reported back — not redesigned. If you hit a
decision this prompt doesn't cover, stop and report back instead of
improvising.

# Ship the CP932-safe filename fix (0d477f9): blurb touch-up, push, deploy

## Context

Commit `0d477f9` (fix(receipts): CP932-safe proof filenames, half-width ¥ →
full-width ￥) is verified — architect independently confirmed diff, live
output, and 1063-test green — but it only exists on local master. Until it's
pushed and deployed, every export the system builds still carries the U+00A5
filenames that broke the accountant's extraction (2026-07-24 field failure).
This round: one cosmetic doc-string fix you flagged yourself, then push and
deploy.

## Part 1 — export.ts blurb (the stale prose you flagged)

`lib/receipts/export.ts` ~line 758, in the bundle-README prose:

```
"named <勘定科目><MonYYYY><①…><店舗><¥金額> — the 科目＆No. matches the",
```

Change `<¥金額>` to `<￥金額>` (full-width, U+FFE5). This string DESCRIBES
filenames (it's the naming-contract pattern shown to the accountant), so under
the doctrine it follows the filename rule, not the content rule — it must
match what the ZIP actually emits. Touch nothing else in that blurb. Do not
sweep other files for ¥; the architect already verified `lib/` is clean.

Commit as its own small commit on master, message:
`docs(receipts): bundle blurb naming pattern ￥ to match emitted filenames`

## Part 2 — Push

`git push origin master`. This publishes your new commit plus `0d477f9` (and
any earlier unpushed master commits — that's expected). Do NOT commit the
dirty `docs/README.md` or any untracked files; leave the working tree as you
found it apart from Part 1.

## Part 3 — Deploy + smoke

1. `npm run deploy` (build:cf + opennextjs-cloudflare deploy, keeps vars).
2. Smoke — read-only, do NOT create or seal a new export revision in prod
   during beta:
   a. Load the receipts AMEX page for 2026-06 in prod and confirm it renders
      (deploy sanity).
   b. In local preview (`npm run cf:dev`), exercise the export build path for
      a test month and confirm generated proof filenames contain `￥` (U+FFE5)
      and no `¥` (U+00A5). If the preview path can't build an export without
      writing to prod-shared state, skip (b), say so, and rely on the unit
      coverage — do not improvise a prod export.

## Report back

- Both commit hashes on origin/master (`git log origin/master --oneline -3`
  after push).
- Deploy output tail (worker/version id).
- Smoke results: prod page render yes/no; preview filename check result or
  the reason it was skipped.
