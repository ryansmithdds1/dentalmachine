# CAP — Capacity meter: when to add a hygiene day or doctor time

**Trigger:** the owner or office manager asks "is hygiene booked out too far — do we need another hygiene day?",
"should Dr. Chen stay later or open a Friday?", "are emergencies and new patients getting in quickly?". Also a
glance on the Today screen / huddle, and a line in the metric emails.
**Who:** anyone who can see the schedule (`schedule:read`). Nothing on it is money or a patient's name. Targets are
changed by an administrator only (audited, before → after, optional reason).
**Data:** `GET /capacity[?location_id=<id>|all]`, `GET /capacity/trend[?location_id=][&days=7-731]`,
`GET /capacity/targets`, `PUT /capacity/targets` (`server/src/routes/capacity.js`), calculated once in
`server/src/capacity.js` (definitions: `docs/capacity.md`, pinned by `server/test/capacity.test.js`).

## Click budget: open Capacity → red meter + its recommendation = 1 action
| Step | Keys | Actions |
|---|---|---|
| Open Capacity (sidebar, or Cmd/Ctrl-K "Capacity") | click | 1 |
| See what's red and what to do about it, with the numbers | — ("What to do" is at the top, red first) | 0 |
| See the first openings, booked %, open vs needed per kind | — (always on screen) | 0 |
| A first opening's exact time and provider | hover the chip | 0 |
| Go to the list that fixes it (recall, unscheduled treatment, online requests, schedule setup) | the link on the recommendation | 1 |
| Targets | T (or the Targets button / command bar "Capacity targets") | 1 |
| Close targets | Escape | 1 |
| Refresh | R | 1 |

Pinned by `e2e/workflows/CAP-capacity.test.mjs` (budget 1 action, 5 s).

## What's on screen
- **What to do** — the recommendations, red first, each with a status (icon + word), the sentence, the numbers
  behind it ("First recall opening 2026-11-02 (35 days), target 21 days · 100% booked next 4 weeks · …") and a link
  to the list or setup screen that acts on it. "Everything is on target" when there's nothing to do.
- **Doctor** and **Hygiene** cards — status; **first openings** as chips (new patient, emergency in business days,
  recall/hygiene, treatment 30 / 60 / 90+ minutes; each coloured by its target, date underneath, exact time and
  provider on hover); **booked** 2 / 4 / 8 weeks as bars over the shaded target band; **open vs needed** hours a
  week for the next 8 weeks with "N h a week to spare / short"; the demand behind it (recall due 4 / 8 weeks and
  overdue, unscheduled treatment, ASAP list, online requests, emergencies a day, new patients a week, open
  perfect-day blocks); a **trend** sparkline of the 4-week booked % over the last 90 nights (hover for a night's
  numbers).
- **By provider** — each provider's booked 2 / 4 / 8 weeks, their main first opening and status.
- **Targets** side panel (no modal): new patients within 7 days, emergencies within 1 business day, hygiene within
  21 days, treatment within 14 days, booked 85–95%, backlog worked off over 8 weeks, and which visit type is the
  new-patient / emergency visit (found automatically unless chosen). Read-only unless an administrator.
- An office picker when the practice has more than one office (defaults to the office the screen works in).

## Safety
- Read-only: recommendations never change the schedule; people act on them.
- Target changes: administrator only, validated on the server (whole numbers in range, low ≤ high, visit types of
  this practice and switched on), audited `capacity.targets.update` with before/after and reason.
- Office scoping: someone limited to some offices sees only theirs (another office → 403); another practice's
  office → 404.
- Nightly trend rows are derived data (`capacity_snapshots`), written once a day per scope and kind (unique key),
  hard-deleted after two years. A failed night becomes a Needs attention item (Scheduling), resolved by the next
  night that works.
