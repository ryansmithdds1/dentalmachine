# BN · Team bonus module (backlog BN1–BN3)

**Off until the owner turns it on.** Settings → Team bonus → "Team bonuses are on".

**Budgets.**
- See the team's progress and my own status: **0 actions** (the card on the dashboard and the slim bar above the
  schedule, whenever the module is on and the person is in a plan).
- Open my bonus (history, what came off, which payroll): **1** (the bar's or card's **My bonus** link, or `/bonus`).
- Switch the module on: **≤ 2** (Settings → Team bonus → the switch; saves at once, with Undo).
- Set up a plan from the catalog: **≤ 4** (Set up on the plan's card → fill the few numbers it needs → **Save plan**
  (Ctrl+Enter) → **Turn on**). The catalog's defaults are ready to use; the team plan only needs its target.
- Approve a period: **≤ 3** (Review & approve on the plan → it opens on the period that just ended → **Approve $X**).
  A second click (or a retry) changes nothing.
- Reopen an approved period: **≤ 3** (Review & approve → type why → Enter).

Server rules: `server/test/bonus.test.js` (money math, clawbacks, eligibility, caps, visibility, permissions,
practice isolation, idempotent approval, payroll export). An e2e budget test belongs in `e2e/workflows/` once the
screens are mounted.

## Who
- **Everyone** (staff logins, not API keys) sees the team's progress on the plans they're in, whether they qualify,
  and what they've earned — **only their own pay**. Everyone's lines show only on a plan the owner made
  *visible to the team*. A provider's own production on a "% above base" plan is private the same way.
- **Administrators** and people given **`bonus:manage`** switch the module on, set up and change plans, review
  everyone's numbers, approve and reopen periods, and see what goes to payroll. Every change is audited.
- **The assistant (AI)** can read; changing plans, the switch, approving or reopening needs the person's yes on
  screen (428 otherwise, and `requireHuman()` in the routes).

## The plans (BN1) — `server/src/bonus.js`
Each is a deterministic calculation from data the practice already keeps; money in integer cents; every split
adds up exactly (largest remainder). Plain-language rules and a worked example for each are in `PLAN_TYPES` and
shown on the Settings cards.

| Type | What it pays | Built on |
|---|---|---|
| `team_collections` | Share (%) of what collections / net / gross production beat a target — a set amount, or labor cost ÷ target labor % — split by hours, role weights or equally | `computeMetrics` (metrics.js), `computeHours` + pay rates (time clock) |
| `daily_goal` | A set amount per person for each day (or week) the office hits its production/collections goal, to everyone who worked it | `computeMetrics`, `goalsFor` (metric_goals / daily goal) or a fixed goal, time-clock punches |
| `spiff` | A set amount or % per procedure code, to the provider (login linked to the provider), the assistant working with that provider/chair that day (business view staff roles; split if several), or whoever booked the visit (`appointment.create` in the audit log) | Live `charge` ledger entries of completed procedures |
| `provider_pct` | A provider's % of their own production/collections above a base | `computeMetrics` with the provider (collections by allocation) |
| `scorecard` | Points for each KPI target hit → the highest tier reached, paid to everyone who qualifies | Metrics (reappointment, case acceptance, collection rate, new patients, no-show rate, production, collections), review shout-outs, checklists done on time |
| `front_desk` | The scorecard with front-desk measures: schedule fill, no-show & cancel rate, collected at checkout, waiting treatment scheduled | Appointments + provider hours, metrics, ledger, procedures |

Common to all: the period (month or week; daily goals are paid monthly), an office (optional), **who qualifies**
(roles — every role but the owner/administrator by default — specific people left out, a minimum of hours worked
from the time clock, active logins only), **caps** (most per person, then most for the plan, scaled evenly), the
**clawback window** (days) and **visible to the team** (off by default).

## Visible to the team (BN2)
- **Dashboard card** (`client/src/components/bonus/BonusCard.jsx`) and **schedule bar** (`BonusBar.jsx`), both from
  `GET /api/bonus/progress`: one line per plan — "Team goal: $18,400 of $22,000 this month — $3,600 to go · on pace",
  "Today: 92% of goal · 9 of 14 days at goal this month", "Scorecard: 3 of 5 points — 1 more for the $50 tier" — a
  meter (with a marker where the team should be by now), and the person's own line: "Qualified so far · $120 so far"
  / "Not yet: 62 of 80 hours so far" / "Didn't qualify: …". Nothing shows while the module (or that placement) is
  off or the person is in no plan. Once a period is approved it shows the approved figures.
- **My bonus** (`MyBonus.jsx`, `GET /api/bonus/me`): each plan's progress, the measures, my amount and why, and my
  history (earned, over the cap, taken back, paid, which pay period).

## Owner control and payroll (BN3)
- **Off by default** (`bonus_settings.enabled = 0`); a plan starts **off** until switched on.
- **Versioned**: each change is a new `bonus_plan_versions` row (never edited) with `effective_from` and a
  required reason. Default start: the next period, so the current one keeps the rules the team was promised. A
  version can't start inside a period that's already approved (reopen it first). A period uses the version in
  effect on its first day.
- **Clawbacks, computed from the ledger**: approving a period recalculates every approved period of the same plan
  inside the clawback window (default 90 days) from the ledger as it stands now. If a voided charge, a voided
  payment or a refund means someone was paid more than they'd earn today, the difference comes off this period's
  bonus — oldest first, never below zero; what's left carries on to the next one. Nothing approved is edited; the
  owner's review shows "approved $X, now $Y" for each approved period that has moved.
- **Approval** (`POST /api/bonus/periods/approve`): only after the period ends; stores the whole calculation
  (`bonus_approvals.detail` + hash) and one `bonus_payout_lines` row per person. At most one live approval per
  plan and period (partial unique index) — a double click or a retry returns the first. `expected_total_cents`
  refuses an approval when the numbers moved since the owner looked. **Reopen** needs a reason (status
  `reopened`, never deleted) and warns if the bonuses were already in a payroll file.
- **Payroll**: each approval names the pay period whose export carries it (default: the pay period in progress).
  The time clock's export (`GET /api/timeclock/period/export.csv`) adds approved bonuses as their own pay type —
  a `bonus` column (Gusto), `Earnings 3 Code/Amount` = `B` (ADP), a `Bonus` pay component with an `Amount`
  (Paychex), a `Bonus` line with an `Amount` (QuickBooks), `Bonus ($)` (plain CSV). The file is refused unless the
  bonus total in it equals the approved total; `payroll_exports.bonus_cents` / `bonus_detail` record which
  approvals went. Without bonuses the files are exactly as before.

## Data model (`server/src/db.js`)
| Table | What it is |
|---|---|
| `bonus_settings` | One per practice: `enabled`, `show_dashboard`, `show_schedule`, `pay_type_label`. Audited. |
| `bonus_plans` | `type`, `name`, `status` active / off / archived. Never deleted. |
| `bonus_plan_versions` | `version`, `effective_from`, `config` (JSON, validated by `normalizeConfig`), `reason`, who. Never edited. |
| `bonus_approvals` | Plan, version, period, totals (earned, over cap, taken back, paid), `detail` + `detail_hash`, `payroll_period_start`, approved / reopened by, when, why. |
| `bonus_payout_lines` | Per person per approval: earned, cap cut, clawback (with `clawbacks` JSON naming the approvals it recovers), net, detail. Never edited. |
| `payroll_exports.bonus_cents`, `bonus_detail` | What each payroll file carried. |

## Endpoints (`server/src/routes/bonus.js`)
`GET/PUT /bonus/settings` · `GET /bonus/plan-types` · `GET/POST /bonus/plans` · `PUT /bonus/plans/:id` ·
`POST /bonus/plans/:id/status` · `POST /bonus/preview` (what a plan would have paid, saving nothing) ·
`GET /bonus/progress` · `GET /bonus/me` · `GET /bonus/periods?plan_id&start` · `POST /bonus/periods/approve` ·
`POST /bonus/periods/:id/reopen` · `GET /bonus/approvals` · `GET /bonus/payroll?start`.

## Mounting
- `server/src/app.js`: `import bonusRoutes from './routes/bonus.js';` and `api.use(bonusRoutes({ db }));` after `api.use(timeclockRoutes({ db }));`.
- `server/src/auth.js` `PERMISSION_CATALOG`: `'bonus:manage': 'Set up team bonus plans, see everyone’s bonus numbers, approve and reopen bonus periods',`
- `server/src/aiguard.js` `HIGH_RISK`: `['POST', /^\/bonus\/(plans(\/\d+\/status)?|periods\/(approve|\d+\/reopen))$/, 'bonus plans and approving bonuses'], ['PUT', /^\/bonus\/(settings|plans\/\d+)$/, 'bonus plans and approving bonuses'],`
- Client: the Settings tab (`BonusSettings`), the dashboard card (`BonusCard`), the schedule bar (`BonusBar`) and
  the `/bonus` page (`MyBonus`), plus "My bonus" in the command bar.

## Keyboard
Every control is a native button, input or select. Plan editor: **Ctrl/Cmd+Enter** saves, **Esc** closes. Period
review: **←/→** move between periods; **Enter** in the reopen reason reopens. The schedule bar is a live region.
