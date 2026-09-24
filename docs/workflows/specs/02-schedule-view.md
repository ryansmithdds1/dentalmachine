# 02 — View today's schedule, switch Chairs / Providers, show one provider

**Trigger:** start of the day, between patients, or when someone asks "who's next for Dr. Lee?".
**Who:** front desk, assistants, hygienists, dentists — anyone with `schedule:read`.
**Data:** `GET /schedule?from&to[&location_id]` (visits, blockouts, office and provider hours, production);
chairs (`/operatories`), providers (`/providers`); the person's remembered provider (`user_prefs`
key `schedule.provider`).

## Today (audit row 2)
G S opens the schedule (2 keys), then a click on Chairs / Providers. No key for either. The provider picker was
hidden in Day view, so "just Dr. Lee's day" meant switching to Providers and scanning one column.

## Target: 2 actions to open, 1 to switch — keyboard only
| Step | Keys | Actions |
|---|---|---|
| Open today's schedule from anywhere | G S | 2 |
| Chairs view | C | 1 |
| Providers view | P | 1 |
| Show one provider (again for the next, then all) | V | 1 |
| Show all providers | Shift+V | 1 |

All keys are registered with labels, so they show in the `?` list ("Schedule views"). The command bar offers
"Schedule: Chairs view", "Schedule: Providers view", "Schedule: show only <provider>", "Schedule: show all
providers" and "Schedule: today" while the schedule is open.

## What's automated
- The provider picker shows in every view (Day, Week, List). In Day view it narrows Chairs view to that
  provider's visits and Providers view to that provider's column; the day's totals follow it.
- The choice is remembered per person on the server (`useRemembered('schedule.provider')`), so a hygienist's
  schedule opens on their own day on any computer. A provider who's no longer active falls back to "All".
- C / P in Week view pick the week layout (by chair / by provider); from the List they open Day view.

## Edge cases
- Keys don't fire while typing in a box or with a dialog open (shared `useShortcuts` rules); G then S is still
  "go to the schedule".
- Changing office in the sidebar still reloads the page (outside this screen's files — noted for later).
- Booking from an empty slot while filtered defaults the provider to the one shown (existing behaviour).

## Acceptance
- `e2e/workflows/02-03-schedule.test.mjs` (#2): G S = 2 actions to the grid; P, V, C = 1 action each; the
  filter survives a reload; Shift+V clears it; the command bar lists the views; `?` lists the keys.
