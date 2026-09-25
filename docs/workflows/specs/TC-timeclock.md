# TC · Time clock, staff schedules and payroll (backlog TC1–TC5; replaces workflow 44)

**Budgets.** Clock in or out: **1 action** (the big button on Time clock → My time, or **I**; lunch and back: **1 each**, **L**; on the shared
tablet: tap your name → type your PIN, which is the sign-in, not an extra step). Approve a pay period: **≤ 3**
(Time clock → Pay period opens on the period that just ended → **Approve all ready**, or **Shift+A**). Export to
payroll: **≤ 2** (Time clock → Export → one click on Gusto / ADP / Paychex / QuickBooks / CSV). Server rules are
tested in `server/test/timeclock.test.js`; an e2e budget test belongs in `e2e/workflows/` once the page is
mounted (see "Mounting").

## Trigger and who does it
Everyone on the clock punches in and out, starts and ends breaks and lunch, asks for time off and sets a tablet PIN.
Office managers (`timeclock:manage`) build schedules, watch who is in, late or missing, fix missed punches, approve
each person's hours for the pay period and download the payroll file. Pay rates and labor cost need
`timeclock:rates` (or an administrator).

## Data needed
The person (the signed-in user, or a name + PIN on the tablet), the practice time zone (`practices.timezone`),
their shift for the day (the usual week or that date's override), and the practice's rules (window, pay period,
overtime, rounding, time off). Nothing else is asked for.

## Today (from the audit)
In 1; out 3 (a `window.prompt` for break minutes). Breaks typed from memory, nothing caught a forgotten
clock-out, manager "fixes" edited the punch in place, overtime was weekly-only, and the only export was a plain CSV
of unapproved hours.

## Target
- **My time**: one big button (Clock in / Clock out, **I**), today's shift, a note when it's too early ("Clock-in
  opens at 7:53 AM"), Start break / Start lunch / I'm back, today's and this week's hours, time to overtime, time-off
  balance, and the tablet PIN.
- **Shared tablet** (`/timeclock/kiosk`): tap your name → pick Clock in / Start break / Start lunch / Clock out →
  PIN pad (keyboard digits work) → "Thanks, Ann — clocked in at 7:58 AM", back to the start after 4 seconds (or 25
  seconds of no activity). A manager turns a browser into the tablet from Settings; it holds only a tablet token
  (hash stored, can be switched off) — no staff session, nothing else reachable.
- **Today** board (live): In, On break/lunch, Late (not in by start + grace), Missing (shift over, never came),
  Due later, Off/Time off, with flags: late, early, left early, not scheduled, forgot to clock out, near/over
  overtime. "Fix time" jumps to Corrections for that person. A clock-in still open from yesterday (or > 14 h)
  also becomes a Needs attention item, resolved by the fix.
- **Schedules**: week grid (people × days). Click a day to set a shift (start, end, break), mark off, or go back to
  the usual week; drag a shift onto another day or person to copy it; **Copy last week**; **Make this the usual
  week**; ← / → change week. Staff see the schedule read-only.
- **Corrections**: timesheet for the pay period; **Fix** opens the row in place (in, out, unpaid break, why);
  **Add missed time**; **Remove…** (with why). The punched time stays visible struck through next to the fix;
  a history lists every fix with who, when and why.
- **Pay period**: totals per person by pay type (regular, overtime, double time, PTO, holiday) with things to look
  at (late, early, left early, unscheduled, fixed); expand a person for the day detail; **Approve** per person or
  **Approve all ready**; a lock icon reopens an approval (reason required).
- **Export**: five one-click files, a reconciliation line ("Approved 154.75 h = exported 154.75 h"), and every
  file made for the period with who, when and a SHA-256 fingerprint.
- **Time off**: request (days, hours a day, paid or unpaid, note); managers approve or decline (declining needs a
  note); balances with manual adjustments (reason required).
- **Reports**: hours by person and office, punctuality (late count and average, left early, unscheduled, fixes),
  overtime by week, and labor cost as a percent of production (rates only for `timeclock:rates`).
- **Settings**: window and grace minutes, flag vs block, block unscheduled days, pay period and its start date,
  workweek start day, weekly/daily overtime, double time, California seventh-day rule, rounding (none / 5 / 6 /
  15), paid short breaks, time-off accrual (per hour worked or fixed per period, with a cap), ADP company code,
  Paychex client ID; people (on the clock, payroll ID, hourly/salary, overtime exempt, rate, PIN reset); paid
  holidays (add the usual six US holidays in one click); tablets.

## Rules (server: `server/src/timeclock.js` pure math, `server/src/routes/timeclock.js` routes)
- **Punches** (`time_punches`): local wall-clock times plus the exact UTC instants, office, device (user agent),
  IP, source (self / kiosk / manager), and the flags at the time (early/late/unscheduled in, early/late out, with
  minutes, and the shift then in force). Elapsed time uses the UTC instants, so the spring-forward night pays 7
  hours for 00:00–08:00 and the fall-back night 9.
- **Idempotent**: one open punch per person, enforced by the database (`time_open_punches.user_id` unique) — a
  double click, a retry or two tablets at once make one punch; a second clock-out finds nothing open (409). Breaks
  likewise (one open break per person).
- **Windows**: clock in no earlier than N minutes before the shift (default 7); late after the grace (default 5).
  Too early is either allowed and flagged or refused with the friendly message (practice setting); a refused punch
  is audited (`timeclock.blocked`). Late is never refused. Not scheduled: flagged, or refused if the practice says so.
  Manager-entered time gets the same flags against that day's shift.
- **Corrections never edit a punch**: `time_punch_corrections` (add / change / void, before and after, reason
  required, who, when) is append-only; `eff_in` / `eff_out` / `eff_break` on the punch hold the result. Overlapping
  another punch, future times, > 24 h, out before in, and breaks longer than the time are refused. Every fix is
  audited with before → after and the reason.
- **Overtime** (per person, per workweek, assigned to the day it happens): weekly over 40 h (FLSA); optional daily
  over 8 h, double time over 12 h, and the California seventh-consecutive-day rule (first 8 h overtime, rest
  double time). Daily overtime isn't counted again toward the weekly 40. Salaried or exempt people: all regular.
- **Rounding** applies to clock-in and clock-out instants only (nearest 5, 6 or 15 minutes; 8:07 → 8:00, 8:08 →
  8:15), never to breaks. Rest breaks shorter than the paid-break limit (default 20 min) are paid; lunches are not.
- **Pay periods**: weekly / biweekly from an anchor date, semimonthly (1–15, 16–end), monthly. Overtime is always
  worked out over whole workweeks, even when a period cuts a week in two.
- **Holidays**: hourly people on the clock who worked or took paid time off in those weeks get the holiday's
  hours (so owners who don't punch and people who've left aren't paid for it).
- **Time off**: `pto_requests` (pending → approved / denied / cancelled) and a ledger `pto_ledger` (balance =
  SUM(minutes)): accrual once per person per period (unique), use once per request (unique), cancellations void
  the use row, never edit it. Approving someone's own request needs another manager (unless an administrator).
- **Approval locks**: `pay_period_approvals` stores each person's minutes by pay type and the day detail as
  approved (plus a hash). One live approval per person and period (unique). A period can be approved only after
  it ends and with no one still clocked in. While approved, fixes, added time, time off and holidays inside it are
  refused ("approved and locked — reopen it"). Reopening needs a reason, is audited, and voids that period's
  accrual (re-approval accrues again on the corrected hours).
- **Export**: built only from approved snapshots; refused while anyone with hours is unapproved unless "approved
  people only" is ticked (recorded as partial). Formats: Gusto (hours import: employee id, regular, overtime,
  double overtime, PTO, holiday), ADP Workforce Now (pay data import: Co Code, Batch ID, File #, Reg Hours,
  O/T Hours, then one line per other code — DT, V, H), Paychex Flex (one line per worker and pay component),
  QuickBooks Payroll (time activities: one line per person, day and pay item, duration as hh:mm so it's exact),
  and a plain CSV. Each file is checked against the approved minutes before it's sent (a mismatch downloads
  nothing), then recorded in `payroll_exports` (format, period, who, when, SHA-256 of the file, minutes per person
  and pay type) and audited. The column layouts follow each vendor's published import template; confirm against
  the practice's own account template on first use (every one of them lets you map columns).
- **No outside payroll calls** — files only. A direct sync (Gusto / ADP / Paychex APIs) can come later behind an
  adapter module with a sandbox mode and `loggedFetch`, fed by the same approved snapshots.
- **Reconciliation** on the Export screen: approved minutes vs the latest file, person by person and pay type by
  pay type; a reopen-and-reapprove after an export shows the difference until the file is made again.
- **Reports**: labor cost = rate × (regular + 1.5 × overtime + 2 × double time + PTO + holiday); production =
  SUM(amount) of non-voided `charge` ledger entries in the same dates, by office too. Rates are integer cents,
  shown and changed only with `timeclock:rates`; changes are audited (`timeclock.rate`).
- **Tablet PIN**: 4–8 digits, not one digit repeated or a straight run; stored with scrypt; five wrong in a row
  lock it for 15 minutes (audited `timeclock.pin_locked`), plus a per-address rate limit; a manager can clear it.
  Punches from the tablet are recorded as the person ("Ann Lee (time clock tablet: Front desk)").
- **AI**: the assistant can't fix punches, approve or reopen, export, change rates or settings, or decide time
  off without the person's on-screen OK (428 otherwise).
- **Permissions**: everyone — own clock, own timesheet, schedule (read), time-off requests, PIN.
  `timeclock:manage` — everything else. `timeclock:rates` — rates and labor cost. Every id is checked against the
  caller's practice.

## Edge cases
Forgotten clock-out (flag + Needs attention; the fix closes it). Someone who left mid-period still appears in
their approved period. Clocking out while on a break ends the break first. Open punches from before this release
work (their open-punch marker is added on the next action). The practice time zone governs everything; the tablet
shows the office's time, not its own.

## Mounting (not done here: shared files)
- Server: the signed-in routes are already mounted (`api.use(timeclockRoutes({ db }))`). The tablet needs, in
  `server/src/app.js` before `app.use('/api', api)`: `app.use('/api/kiosk', timeclockKioskRoutes({ db }));` with
  `import timeclockRoutes, { timeclockKioskRoutes } from './routes/timeclock.js';`.
- Client: route `/timeclock` (inside the signed-in shell), public route `/timeclock/kiosk`, a nav item and command
  bar entries (see the hand-off notes).

## Acceptance
- `server/test/timeclock.test.js` (SQLite and Postgres): overtime (weekly, workweek start, daily, double time, no
  pyramiding, seventh day, exempt), rounding, paid/unpaid breaks, windows (early flagged / blocked with message,
  late, unscheduled, early/late out), DST days (pure and through the API), pay periods, PTO accrual, PINs, US
  holidays; idempotent punches under concurrent requests; corrections keep the original and are audited;
  approval locks, unlock with reason, accrual once; every export format's file hours equal the approved hours and
  its hash is recorded; reconciliation catches a stale file; labor % of production; practice isolation;
  permission checks; AI needs approval; PIN hashing and lockout on the tablet.

## Phase 2 batch 1A: "Add missed time" starts on a time that can be saved (scorecard bug 11)
The new row used to start on today 8:00–5:00, which is refused until 5 PM ("Clock-out can't be in the future") and is
rarely the day that was missed. It now starts on the last weekday before today, 8:00–5:00 with a 60-minute break, for
the person the list is filtered to. A date that isn't real says so in plain words ("Clock-out isn't a real date and
time — pick the day and the time") instead of "clock_out must be a real date and time (YYYY-MM-DD HH:MM)".
