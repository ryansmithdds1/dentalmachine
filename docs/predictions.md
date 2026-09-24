# Predictions: no-show risk and denial risk

Two numbers that help the team decide where to spend a phone call or a second look. They **inform people and
never act**: nothing is cancelled, moved, held, sent or changed because of a prediction.

| What | Where staff see it | Code |
| --- | --- | --- |
| **No-show / late-cancel risk** of each upcoming visit (a percentage and the reasons) | Schedule: a small `⊘ 34%` on the visit card when it's higher than usual (card item "No-show risk", in the default layout); the hover card and the visit panel always show "No-show risk 34% — 2 missed visits in the past year, not confirmed yet". Today's optimizer "Double-confirm" suggestions use it. | `server/src/predict/noshow.js` |
| **Denial risk** of each claim line, and of the claim (its riskiest line) | Billing → Ready to approve (next to the status, and with the reasons under the row), the claim screen's checks, and the treatment plan (on planned procedures worth a look). The scrubber's rule messages stay as they were; the percentage is added alongside. | `server/src/predict/denial.js` |
| **How well it does** (calibration) | Reports → Prediction accuracy: for the last 3/6/12 months, "of visits we said were 30–40% likely to be missed, how many were". | `noShowAccuracy`, `denialAccuracy`; `GET /api/predict/accuracy` |

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
whether they owe a balance. "Missed" = a no-show, or a cancellation with a reason that isn't the office's.

**Denial factors:** this payer × this code (and whether a narrative went with it), the code across payers, the payer
across codes, and the scrubber's rule hits for the line — a `deny` hit (frequency, filing limit, duplicate, missing
tooth/surface…) pushes it up strongly, a missing narrative less. "Denied" = the claim was denied (now or at some
point), or the payer paid the claim but nothing on this line although something was expected. Secondary claims and
claims still waiting are left out.

Levels for the schedule and Double-confirm: `high` ≥ max(30%, 2.5 × the office's usual rate), `some` ≥ max(15%,
1.5 ×), else `low`. Billing shows "Likely denied: 62%" at 50% and over, "Denial risk 8%" otherwise.

Speed: a day or a week of visits is a fixed set of queries (the office’s rates — cached 30 minutes per practice and refreshed in the background —
plus that range's patients' history and balances), never one query per visit.

**Accuracy check.** Tested out of time: rates are learned only from before the period, and each visit's patient
record only from their earlier visits, as it would have looked then. Denials there use history only (the rule
checks can't be re-run as they stood back then). The backtest never calls an outside vendor.

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
