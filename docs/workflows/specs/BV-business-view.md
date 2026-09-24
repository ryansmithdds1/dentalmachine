# BV · The business view: margin per visit on the schedule, labor vs production today (backlog PM1–PM4, BD1–BD4, EX1–EX3)

**Budgets.** Turn the business view on or off on the schedule: **1 action** (the **Business** button in the
schedule toolbar, or **Shift+B**; also in the command bar as "Schedule: business view"). Everything it shows —
visit colors, the hover breakdown, column totals, today's strip with labor %, the exams card and the staff lanes —
is on screen with **no further action** (staff lanes: **Shift+L** to hide or show, remembered). The Business page:
**1 action** from the command bar ("Business: today, what pays, trends, costs"); its tabs are **1–4**. Pinned by
`server/test/business.test.js` (math, versions, permissions, isolation) and `e2e/workflows/BV-business.test.mjs`
(the toggle in 1 action and labor % on screen).

## Trigger and who does it
The owner, several times a day ("are we making money today?", "is this crown worth it under this PPO?", "why is
labor 34%?"), and when setting fees, choosing plans and staffing. **Owner only**: `business:view` (see),
`business:manage` (change costs, pay plans, thresholds, roles). Anything that is pay — labor cost, labor %,
provider pay lines and plans, idle cost — also needs `timeclock:rates`. Office managers with `timeclock:manage`
see the staff lanes (hours, busy/idle) without any dollars. Everyone else gets **403** from every business
endpoint; the server never sends a money field to someone without the permission. The exam counts vs target
(huddle card) are for anyone who sees the schedule; their dollar value only with `business:view`.

## Data needed (nothing is typed twice)
Visits, procedures and fees (the schedule), the insurance estimate (`estimateCoverage`: PPO allowed fee,
insurance and patient portions), claims (actual write-off and payment for completed work), the fee resolver
(`resolveFee`, by date of service, for completed work without a claim), lab cases (`cost`, linked by procedure or
visit), time patterns (doctor X / assistant / time), the time clock (punches, breaks, shifts, rates, overtime
rules — `computeHours`/`shiftsFor`, the payroll's own), production (`scheduleProduction`), metrics
(`computeMetrics`, `goalsFor`), finance (`financeOverview`: fixed costs per chair-hour), the diagnosis module
(`examsForDay`, `examValues`) — plus the owner's own inputs below.

**The owner enters once:** costs per procedure code or kind of work (supplies, lab fixed or "from the lab case"
with an estimate, card-fee %, an optional provider-pay % override) — or accepts the suggestions (typical amounts
scaled to the practice's real supply spend from Finance; lab fees averaged from the last year of lab cases);
how each provider is paid (% of production after write-off, % of collections, hourly from the time clock or a set
rate, before or after lab; none for the owner); thresholds and targets (defaults work). Every cost and pay change is
a **new version from a date** — never overwritten; past visits keep the costs they had.

## Definitions (one calculation each — `server/src/business.js`, pure, integer cents)
- **Expected collection** = fee − PPO write-off (the plan's allowed fee) = insurance + patient portion × the
  share of patient portions the owner expects to collect (default 100%).
- **Direct costs** = supplies + lab (the linked lab case's cost, else the profile's estimate or fixed amount) +
  card/financing fee (% of what the patient pays) + provider pay (the plan in effect on the date of service).
- **Contribution margin** = expected collection − direct costs. **Per chair-hour** over the whole visit; **per
  doctor-hour** over the pattern's X time (hygiene visits have none).
- **Fixed cost per chair-hour** = overhead from Finance except supplies, lab and card fees (team wages included),
  over chair hours — or the owner's number; a typical $180 when neither exists (labelled "typical").
- **Profit** = margin − fixed cost per chair-hour × the visit's hours; **profit per hour** likewise.
- **Bands** (margin per chair-hour, or per doctor-hour if the owner prefers): **red** below the fixed cost per
  hour (or the owner's "red below"), **amber** up to "green from" (default 1.5×), **green** up to "gold from"
  (default 2.5×), **gold** above.
- **Labor so far / projected** = worked minutes (punches, breaks, rounding) and the rest of today's shifts (less the
  lunch still to come; someone out for lunch is expected back after it) classified by the payroll's own overtime
  rules (daily, weekly 40, double time; exempt/salaried never overtime) × rate: regular + 1.5× overtime + 2× double
  time. People without a rate are listed, never counted as $0.
- **Labor % of production** = projected labor / scheduled production (the production bar's number); **of
  collections** = projected labor / expected collections. Target 25–30% (owner-set).
- **Today's profit** = expected collections − direct costs (except hourly providers already on the clock) −
  projected labor − other fixed costs for the day (Finance's non-wage overhead per open day, or the owner's
  monthly figure / days open).
- **Staff lanes**, minute by minute: *with a patient* (a doctor's X time or a hygienist's visit), *assisting*
  (an assistant's linked provider or chair has a patient; unlinked assistants share the busy doctor chairs in the
  order they clocked in), *front office*, *break*, *idle* (on the clock, nothing to do), *not clocked in*
  (scheduled). Past minutes from punches, the rest of the day from shifts (faded). **Busy %** = patient/assisting
  minutes / working minutes (clinical staff). **Production supported per labor hour** = the fees of the visits
  they worked on, per minute of them, over paid hours.
- **Staffing by hour**: busy doctor chairs vs assistants on (rule of thumb 1 per chair, owner-set); ≥ 1 more
  than needed = over, ≥ 1 fewer = under; consecutive hours become one sentence ("2 assistants for 1 doctor chair
  from 2 pm–4 pm: …").
- **Overtime risk**: minutes worked this week + the rest of today's shift past 40 h (or the daily limit) — when it
  starts and what the extra half costs.
- **Exams supported production (EX3)**: exams (today / this week / this month: booked and done) × what an exam
  of that type leads to within 1, 3 or 5 months (default 5; the practice's history via `examValues`, else the
  owner's number, else typical) vs the production goal for the matching coming months at the period's share.
- Trends (BD4) and their definitions: `docs/business-view.md` → "Trends"; the section for `docs/metrics.md` is in
  the hand-over notes.

## What's on screen
- **Schedule toolbar**: *Business* (owner only), lit when on.
- **Legend** (the four bands with this practice's $/h), **today's strip** (production scheduled/done, expected
  collections after write-offs, direct costs, labor so far → day with overtime, **labor % of production** vs target
  and of collections, margin and $/chair-hour, fixed costs today, projected profit; chips: team busy %, idle hours
  and their cost, visits below fixed cost and the shortfall, open chair time and what it's worth, overtime
  warnings, staffing advice), the **exams card** (today vs target; month's exams support $X of the $Y goal, with
  the guidance), the **staff lanes** (per person: the day as colored bars with idle stretches outlined and "now";
  paid hours, busy %, production supported per hour, pay so far → day (rates only), overtime time; suggestions
  under idle stretches still ahead: fill from the ASAP list, send home early — saves $X, move lunch).
- **Each visit** is tinted by its band, shows its $/h, and hovering shows the breakdown: fee − write-off (payer),
  insurance + patient = expected, lab / supplies / card fees / provider pay, margin per chair-hour and per
  doctor-hour, profit after fixed costs, and a note when costs are typical estimates.
- **Column headings**: each chair's / provider's (week view: each day's) margin and profit.
- **Business page** (`/business`): Today (strip, exams, lanes for any date) · What pays (margins by procedure,
  provider, insurance, visit type, kind of work; least profitable under each insurance; what if: raise a fee, change a
  lab, drop a plan; CSV) · Labor trends (by day/week/month: labor, labor %, overtime, paid hours, production per labor
  hour, busy %, idle hours and cost; by person and role; drill-down to the punches behind every number) · Costs &
  settings (thresholds and targets, costs per procedure with versions, "Use the suggested costs", pay plans, who
  works with whom, exam targets and values).

## What's automated
Everything refreshes live when the schedule, the time clock or the business settings change (the shared live
connection; a moment later so a burst is one request) and every minute for "labor so far". Costs, pay plans and
thresholds apply the moment they're saved. The end-of-day email adds the day's labor and margin for owners (see
hand-over notes for the digests line).

## Edge cases
- No finance data: typical fixed costs, labelled; no cost entered: typical costs per kind of work, labelled.
- A visit with no procedures: $0 and "no procedures yet"; one with no time: no $/h (band "none").
- Insurance estimate fails: priced at the office fee with a note on the visit (never silently).
- A person on the clock with no rate: listed as "no rate", not $0; their hours still count for busy %.
- Forgotten clock-outs are the time clock's Needs attention item; the lanes show the punch as it stands.
- Multi-office: one office at a time (visits by the visit's office, people by their shift's or punch's office);
  someone limited to some offices can't ask for another (403); ids from another practice are 404.
- The assistant (AI) can read the business view but can't change costs, pay plans, thresholds or roles without a
  person's yes on screen (428).

## Mounting (until done, the e2e test mounts the routes itself and skips screen steps)
- `server/src/app.js`: `import businessRoutes from './routes/business.js';` and `api.use(businessRoutes({ db }));`
  (anywhere in the signed-in `api` router, e.g. after `api.use(timeclockRoutes({ db }));`).
- `client/src/App.jsx`: `const Business = lazy(() => import('./pages/Business.jsx'));`, the route
  `<Route path="/business" element={<Business />} />` and the nav entry
  `['/business', CircleDollarSign, 'Business', can('business:view') || can('timeclock:manage')]`.
- `client/src/pages/Schedule.jsx`: see the five lines at the top of `components/business/ScheduleBusiness.jsx`.
