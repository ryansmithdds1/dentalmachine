# Predictions: no-show risk and denial risk

Two numbers that help the team decide where to spend a phone call or a second look. They **inform people and
never act**: nothing is cancelled, moved, held, sent or changed because of a prediction.

| What | Where staff see it | Code |
| --- | --- | --- |
| **No-show / late-cancel risk** of each upcoming visit (a percentage and the reasons) | Schedule: a small `⊘ 34%` on the visit card when it's higher than usual (card item "No-show risk", in the default layout); the hover card and the visit panel always show "No-show risk 34% — 2 missed visits in the past year, not confirmed yet". Today's optimizer "Double-confirm" suggestions use it. | `server/src/predict/noshow.js` |
| **Denial risk** of each claim line, and of the claim (the chance at least one line is denied) | Billing → Ready to approve (next to the status; under the row "Claim: 41% chance something is denied · riskiest line D2950 #3 32%", with the reasons and each line), the claim screen's checks, and the treatment plan (on planned procedures worth a look). The scrubber's rule messages stay as they were; the percentage is added alongside. | `server/src/predict/denial.js` |
| **How well it does** (calibration) | Reports → Prediction accuracy: for the last 3/6/12 months, "of visits we said were 30–40% likely to be missed, how many were" — **What staff saw** (the percentages people were shown) or the **Backtest**, plus a CSV of what staff saw. | `predict/log.js`, `noShowAccuracy`, `denialAccuracy`; `GET /api/predict/accuracy`, `GET /api/predict/log.csv` |

## How the built-in model works (the default)

It learns only from **this practice's own history** (queries always filter by `practice_id`; the cached rates are
kept per practice), with no outside calls:

1. **Smoothed rates.** A rate from few cases is pulled toward a wider one: `(hits + k × prior) / (n + k)`. A weekday's
   rate with 4 visits behind it is mostly the office's overall rate; the office's overall rate is itself pulled toward a
   typical dental-office rate (8% of visits missed, 5% of claim lines denied) until it has its own history.
2. **Factors move the odds** away from the office's usual rate by how different their smoothed rate is (a difference
   in log-odds), damped by a weight because factors overlap, and capped so no one factor decides alone.
3. They are **added on the log-odds scale** and turned back into a probability (a logistic combination).
4. The biggest pushes upward become the **plain-language reasons**; **confidence** (low / medium / high) says how much
   history was behind it, and "not much history yet" is said when that's the case.

**No-show factors:** the patient's own no-shows and late cancellations vs kept visits (a visit a year ago counts
half as much as one this week), a first visit, confirmed or not (only within 3 days of the visit — before then,
not being confirmed yet is normal), how far ahead it was booked, day of the week, time of day, visit type, and
whether they owe a balance.

**What counts as missed** = a no-show, or a **late cancellation**: cancelled less than the practice's window before the
visit (Settings → Messages → Appointment reminders, "A cancellation less than __ hours before the visit counts as a late
cancellation"; 24 by default; `practices.late_cancel_hours`, admin only, audited). The office's own cancellations
("office" reason, a provider's day out) never count; earlier cancellations count neither way. When a visit is cancelled
is `appointments.cancelled_at`, in the practice's own time like `start_time`, set by every path that cancels (the
schedule, the edit form, a series' "this and following", a provider's day out, the patient portal, the reminder link,
the API, the AI receptionist) and cleared when the visit is put back; the change log keeps each value. Cancellations
from before it was kept were filled from the change log where it had them (migration 3); the rest — and imports, whose
old systems don't say when — keep it empty and use the older rule (any cancellation with a reason that isn't the
office's). `server/src/latecancel.js`. The optimizer's Double-confirm uses the same predictions, so the same rule.

**Denial factors:** this payer × this code (and whether a narrative went with it), the code across payers, the payer
across codes, and the scrubber's rule hits for the line — a `deny` hit (frequency, filing limit, duplicate, missing
tooth/surface…) pushes it up strongly, a missing narrative less. "Denied" = the claim was denied (now or at some
point), or the payer paid the claim but nothing on this line although something was expected. Secondary claims and
claims still waiting are left out.

Levels for the schedule and Double-confirm: `high` ≥ max(30%, 2.5 × the office's usual rate), `some` ≥ max(15%,
1.5 ×), else `low`. Billing shows "Likely denied: 62%" at 50% and over, "Denial risk 8%" otherwise.

**A whole claim** (`claimChance` in `builtin.js`). The claim's percentage is the chance that at least one of its lines is
denied — but the lines aren't independent: they share the payer, the patient and the claim itself. A payer that turns
down whole claims (eligibility, a lapsed policy) or a filing limit that applies to every line would be counted once
per line if the lines' chances were simply multiplied, and a four-line claim would look far riskier than it is. So:

1. The **shared part** is the chance the payer turns the claim down as a whole: this payer's history of denying whole
   claims (smoothed toward the office's, and a typical 3% until there's history), raised by any rule hit that is on
   every line (the same message on each: a filing limit).
2. Start from the **riskiest line** (its chance already includes the shared part).
3. Each **other line adds only its own extra risk**, the part of its chance beyond the shared one:
   extra = 1 − (1 − line) ÷ (1 − shared), never below zero.
4. Claim = 1 − (1 − riskiest) × (1 − extra₂) × (1 − extra₃) …

In plain words: the payer's habit is counted once, each line's own problems are added on top. A one-line claim is
exactly its line; if nothing is shared it's the lines as if independent; if everything is shared it's the riskiest
line. It is never below the riskiest line nor above the independent product, never goes down when a line gets riskier
or a line is added, and goes down as more of the risk is shared. The screens show both where there's room: "Claim: 41%
chance something is denied · riskiest line D2950 #3 32%"; the Ready to approve row's chip shows the claim's percentage
(its hover says it's the chance at least one line is denied).

Speed: a day or a week of visits is a fixed set of queries (the office’s rates — cached 30 minutes per practice and refreshed in the background —
plus that range's patients' history and balances), never one query per visit.

**Accuracy check.** Two ways, one toggle (Reports → Prediction accuracy):

- **What staff saw** (the default once 30 or more shown predictions in the period have an outcome): the percentages the
  team was actually shown, saved when shown (below), against what happened. For each visit (or claim line) the last
  percentage shown counts. Outcomes: a visit that was a no-show or a late cancellation (as above) vs one that was kept
  (visits still ahead, earlier cancellations and the office's own don't count); a claim line on a claim the payer has
  answered, denied (the claim denied, or nothing paid on the line though something was expected) vs paid. Whole claims
  (from the claim screen, and from Ready to approve before the claim existed) are summarised on their own line.
- **Backtest**: tested out of time: rates are learned only from before the period, and each visit's patient record only
  from their earlier visits, as it would have looked then. Denials there use history only (the rule checks can't be
  re-run as they stood back then). The backtest never calls an outside vendor.

**Predictions shown to staff** (`prediction_log`, `server/src/predict/log.js`). Written when a percentage is served to a
person (not an API key): the schedule, the visit panel, the optimizer's Double-confirm, Ready to approve (lines and the
claim being prepared, keyed by its first procedure), the claim screen while the claim is still to send (lines and the
claim), and the treatment plan (lines only — no claim is being made). Each row: practice, office, kind, subject
(appointment / procedure / claim / claim_group and its id), probability, percent, confidence, model and model version
(`MODEL_VERSION` in `builtin.js`, or the vendor), the plain-language reasons, the screen, who was shown it, when.
- **Once per subject, percentage and day** (the table's unique key, plus a memo in the server): reopening the schedule
  all day writes nothing new; a percentage that changes (the visit was confirmed, a narrative was attached) is a new row.
- **Cheap and never in the way:** one multi-row insert per screen load, for only what's new, written after the response
  has gone out. A failed write is logged; three in a row become a Needs attention item ("Predictions shown to staff
  aren't being saved", Background work), resolved automatically by the next write that works.
- **Export:** `GET /api/predict/log.csv?kind=no_show|denial&months=` (Reports → Prediction accuracy → "What staff saw
  (CSV)"): reports permission, audited as an export; record numbers only, no names.
- **Retention:** derived analytics, not a clinical record or part of the chart. Rows are never edited and are kept (not
  deleted) with the practice's data (backups include them). At a few hundred rows per office per day it stays small; if
  it ever needs trimming, older rows can be summarised into the report's bins by a numbered data migration — not
  deleted from a route.

**Demo data.** The themed demo practice (`themeddemo.js`, `themedplan.js` plan version 2) makes missed visits realistic:
most kept visits were confirmed (about 88%) and some never were; about 40% of no-shows had confirmed; about half of
cancellations were late; and misses follow the patient's record, long booking lead times, Monday mornings and Friday
afternoons, first visits and balances owed, so the accuracy report has something real to show. A themed practice seeded
before version 2 finishes with its original plan and is then upgraded in place once, by the next batch run at boot
(`demo_seed_state.upgraded`): realistic confirmations, a time on every cancellation (about 45% late) and longer lead
times on half the missed visits. Which visits were missed can't change in place (their procedures, claims and payments
follow from it), so the full set of risk factors needs a fresh seed. The original demo practice (`demo.js`) confirms
most past visits and times its cancellations (one late) on new seeds.

## A vendor model behind the same adapter: TypeSafe AI's Jev (off by default)

`server/src/predict/index.js` is the adapter (`predictMany(kind, features)` → `{ probability, confidence, reasons }`).
Drivers: `builtin` (default) and `jev`.

| Setting | Meaning |
| --- | --- |
| `PREDICT_DRIVER=jev` | use Jev (anything else, or unset: the built-in model) |
| `JEV_MODE=sandbox` | Jev played locally, nothing leaves the server (the default while `JEV_API_KEY` is unset) |
| `JEV_MODE=live`, `JEV_API_KEY`, `JEV_URL` | real calls through `loggedFetch` (Settings → Connection activity) |
| `JEV_BAA=signed` | **required for live mode.** A Business Associate Agreement with TypeSafe AI must be signed before any patient-derived data is sent; without it live mode refuses to send anything and the built-in model is used. |
| `JEV_TIMEOUT_MS` | per call (default 4000) |

- **What is sent:** only whitelisted, de-identified features (`JEV_FIELDS` in `predict/jev.js`): counts, rates,
  categories and an opaque per-request reference (`r0`, `r1`…). Never names, birth dates, phone numbers, emails,
  record ids, dates of service, payer names or the scrubber's messages. A test checks the payload.
- **The request/response shape is a placeholder** (`MAPPING` in `predict/jev.js`): Jev's API isn't published to us.
  Fit it to TypeSafe AI's real spec (one object) before turning live mode on.
- **If Jev fails** (down, slow, bad answer, no BAA) the built-in answer is used, and a "Needs attention" item
  (`predict-driver`, Connections) is raised once per practice; it resolves by itself when Jev answers again. After
  a failure Jev is left alone for a minute, so the schedule never waits on it.
- The reasons always come from the built-in model (the office's own history, which staff can check).
