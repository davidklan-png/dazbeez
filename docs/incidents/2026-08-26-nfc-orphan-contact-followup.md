# Follow-up: two visitors hit the broken NFC capture (for David to act on)

Context: `docs/incidents/2026-08-26-nfc-ghost-fk.md`. Between 2026-05-20 and
2026-08-26 every card capture showed the visitor an error screen. Their data
WAS actually saved (the contact row is written before the failing statement) —
but they don't know that, and the sign-in confirmation email/notification
history for those captures may be incomplete. These are the only two real
visitors in the window.

## 1. non mi — n.mise@sekia.net

- Contact id 24, signed in with **Google** on **2026-06-11** (07:09 UTC /
  16:09 JST), card token `LKcinWR9`.
- What they saw: "Google sign-in issue — Your details could not be saved
  right now. Please try again or use the manual form instead."
- Reality: their name + email were saved to the CRM the moment they signed
  in.

## 2. Jatin Lalit — jatinlalit9@gmail.com

- Contact id 25, signed in with **Google** on **2026-06-30** (05:15 UTC /
  14:15 JST), card token `LKcinWR9`.
- Same experience, same reality.

## Suggested message shape (yours to write)

A short, honest note covers it — something on the order of: "Thanks for
tapping my card on <date> — a technical fault on my side showed you an error
at the time, but your details did come through safely. The fault is fixed;
apologies for the confusion. If anything you intended to send didn't reach
me, please do resend."

Optional, only if useful: re-share the card link (`https://hi.dazbeez.com/hi/LKcinWR9`)
so they can re-verify what profile they shared.

## After sending

No data repair is required for these two — their `contacts` rows are correct.
The only missing artefact is their `contact_events` rows (the audit log of
the capture). If you want the record complete, the event rows can be inserted
manually with their real dates; otherwise leave as-is — the incident record
documents the gap.
