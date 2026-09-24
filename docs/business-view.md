# The business view — for the practice owner

Dentists often do work that loses money without knowing it: a crown under a low-paying PPO with an expensive lab,
an associate's 30%, the card fee and an hour and a half of chair time can leave less than the chair costs to run.
The business view shows, visit by visit and live through the day, what the practice actually keeps — and whether the
team on the clock matches the work on the schedule.

Only you see it (the **See the business view** permission; administrators always have it). Anything that is pay —
labor cost, labor %, what a provider is paid — also needs **See pay rates** (`timeclock:rates`). Staff never see any
of it; the server simply doesn't send it to them.

## Turning it on
On the schedule, click **Business** in the toolbar (or press **Shift+B**). Press it again to turn it off. Your choice
is remembered. The **Business** page (in the menu, or search "Business" with Ctrl/⌘-K) has today, reports, trends
and your costs.

## What each number means and how it's worked out
All amounts are in whole cents behind the scenes; nothing is rounded until the end.

### A visit
| On screen | What it is | How it's worked out |
|---|---|---|
| **Fee** | What you charge | Your office fee for each procedure on the visit. |
| **PPO write-off** | What the plan doesn't allow | Fee − the plan's allowed fee (from your PPO fee schedule; for completed work, the claim's actual write-off once paid). |
| **Expected** | What you'll really collect | Insurance's share + the patient's share (times the share of patient balances you expect to collect — 100% unless you change it). |
| **Lab** | The lab bill | The cost on the lab case linked to the procedure (or to the visit); if there's no case yet, the estimate you entered. |
| **Supplies** | Materials used | What you entered for that code or kind of work (typical amounts until you do — always marked "typical"). |
| **Card fees** | Card / financing fees | Your card fee % of what the patient pays (insurance pays by check/EFT). |
| **Provider pay** | What the associate or hygienist earns for it | Their pay plan on that date: % of production after write-off, % of collections (optionally after lab), or hourly × their time on the visit. Nothing for the owner. |
| **Margin** | What the visit leaves to pay for everything else | Expected − lab − supplies − card fees − provider pay. |
| **Per chair-hour** | Margin for each hour the chair was used | Margin × 60 ÷ the visit's minutes. |
| **Per doctor-hour** | Margin for each hour of *your* time | Margin × 60 ÷ the doctor time in the visit's time pattern (the X's; assistant time "/" doesn't count). Hygiene visits have none. |
| **Fixed cost per chair-hour** | What it costs to keep a chair open for an hour | Your overhead from Finance (rent, team wages, software, marketing… — not supplies, lab or card fees, which are counted above) ÷ chair hours used, over the last 12 full months. Or your own number (Business → Costs & settings). $180 when there's nothing to go on (marked "typical"). |
| **Profit / per hour** | What's left after fixed costs | Margin − fixed cost per chair-hour × the visit's hours. |

**Colors** (margin per chair-hour, or per doctor-hour if you prefer):
- **Red** — below your fixed cost per hour: this visit doesn't pay for the chair.
- **Amber** — covers the chair, not much more (up to 1.5× the fixed cost, or your own "green from").
- **Green** — good (up to 2.5×, or your own "gold from").
- **Gold** — excellent.

Hover a visit to see its breakdown. Each chair's (or provider's) heading shows its margin and profit for the day.

### Today
| On screen | What it is |
|---|---|
| **Production** | Scheduled production (the same number as the production bar) and what's been completed (the ledger). |
| **Expected collections** | The day's visits' expected collections, after write-offs. |
| **Direct costs** | Lab + supplies + card fees + provider pay for associates paid by percentage. (Hourly providers on the time clock are counted in labor instead, never twice.) |
| **Labor so far → day** | What the people on the clock have earned so far (hours worked from their punches, breaks and rounding, like payroll × their rate, with overtime at 1.5× and double time at 2×), and what the day will cost if everyone works the rest of their shift (lunch still to come isn't paid). Someone without a pay rate is listed, not counted as $0. |
| **Labor % of production** | Labor for the day ÷ scheduled production, against your target (25–30% unless you change it). Also shown against expected collections. |
| **Margin** | The day's margin and margin per chair-hour. |
| **Fixed costs today** | Your non-wage fixed costs for one open day (from Finance, or your monthly number ÷ days open). |
| **Projected profit** | Expected collections − direct costs − labor − fixed costs today. Break-even shows how much of it the schedule already covers. |

Chips under the strip point at what to look at: how busy the clinical team has been, hours on the clock with nothing
scheduled (and what they cost), visits below fixed cost, open chair time and what it could earn at today's average,
anyone heading into overtime today, and staffing advice.

### Who's doing what (staff lanes)
One bar per person on today's schedule or clock, from their punches (so far) and shifts (the rest of the day, faded):
**with a patient**, **assisting**, **front office**, **break**, **idle** (on the clock with nothing scheduled — outlined
when it's 20 minutes or more) and **not clocked in**. Assistants linked to a provider or chair (Costs & settings →
Who works with whom) are busy when that provider or chair has a patient; others share the busy doctor chairs in the
order they clocked in. For each person: paid hours, **busy %** (patient + assisting time ÷ time on the clock), the
production they supported per labor hour, and (with pay rates) their pay so far and for the day.

For idle time still ahead, it suggests what to do: fill it from the ASAP list, send someone home early (and what that
saves), or move their lunch into it.

**Staffing by hour** compares assistants on the clock with busy doctor chairs (one each unless you change it) and
says so plainly: "2 assistants for 1 doctor chair from 2 pm–4 pm: someone could take lunch then, make recall calls,
or go home early."

### Exams and the production they support
Today's exams by type (new patient, recall, emergency, perio) against your daily targets, and what they're likely to
lead to: exams × what an exam of that type turns into within 1, 3 or 5 months (5 by default; learned from your own
history once there's enough, or your own number, or a typical one). A month's exams are compared with that month's
share of the production goal for the coming months — "This month's exams support about $96k of the $110k goal: add
~9 new patient exams or ~25 recall exams."

### What pays (reports)
Completed work in any dates, by **procedure, provider, insurance, visit type or kind of work**: fees, write-offs,
expected, each cost, margin, hours and margin per chair-hour and doctor-hour, least profitable first. Below: the
least profitable procedures under each insurance. **What if** reprices the same work with one change: raise a fee
(a PPO caps what it pays at its allowed fee — raising your fee changes nothing for those patients), change a lab
fee, or drop a plan (the patients who stay pay your fee; the time freed by those who leave is partly refilled). Each
answer is also given per year.

### Trends
By day, week or month: production and collections (the same numbers as Metrics), labor cost, labor % of production
and of collections, overtime cost (the extra half or whole over the regular rate), paid hours, production per labor
hour, busy %, idle hours and their cost — and per person and per role. Click a labor or overtime figure to see the
punches behind it.

- **Labor cost** = worked minutes (regular + 1.5 × overtime + 2 × double time) × each person's rate, for everyone on
  the time clock with a rate. Time off and holidays aren't included.
- **Labor % of production** = labor cost ÷ gross production (ledger charges). **of collections** likewise.
- **Production per labor hour** = gross production ÷ paid hours of everyone on the clock.
- **Busy %** = patient + assisting minutes ÷ minutes on the clock, for clinical staff (up to two months at a time).
- **Idle hours / cost** = minutes on the clock with nothing scheduled × rate.
- **Overtime cost** = only the premium: half the rate for overtime, the whole rate again for double time.

## Your costs (Business → Costs & settings)
- **Costs per procedure**: supplies, lab (none / a fixed amount / "from the lab case" with an estimate until there
  is one), card fee %, and optionally a different provider pay % for that code. Enter them for a whole kind of work
  (e.g. all restorative) and override single codes. **Use the suggested costs** fills everything in one click:
  typical amounts scaled to what you actually spent on supplies (from Finance), and lab fees from your last year of
  lab cases.
- **How providers are paid**: % of production (after write-off), % of collections, hourly (their time clock rate or
  a set one), before or after lab.
- **Every change is kept.** Saving creates a new version from the date you choose; visits before that date keep the
  costs they had, so reports never change behind your back.
- **Fixed costs, colors and targets**: from Finance or your own numbers; the color thresholds; the labor target;
  how much of patient balances you expect to collect; the card fee; assistants per doctor chair; how long an idle
  stretch has to be to flag it.

Every change is recorded (who, when, before and after). The assistant can read these numbers but can't change your
costs, pay plans or thresholds without your yes on screen.
