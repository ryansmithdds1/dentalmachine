# Marketing ROI: definitions

Where every lead and new patient came from, and what they produced afterwards. One calculation:
`server/src/marketing.js` (routes in `server/src/routes/marketing.js`, pinned by `server/test/marketing.test.js`).
Workflow and click budgets: `docs/workflows/specs/MK-marketing.md`. The ground rules in `docs/metrics.md` apply
here too: money comes from the ledger as integer cents, voided entries and their reversals are left out, and dates
are the practice's local dates.

## The model

| Concept | Table | Rules |
|---|---|---|
| Source | `marketing_sources` | A channel (`google_ads`, `facebook`, `instagram`, `google_business`, `website_organic`, `referral_patient`, `referral_doctor`, `insurance_directory`, `mailer`, `event`, `walk_in`, `other`) plus a name the practice picks. `match_keys` lists the words that mean it in a `utm_source`, a `?src=`, a call-tracking line's name or a "How did you hear about us?" answer. Every practice starts with one source per channel. Sources are retired (`active = 0`), never deleted. |
| Campaign | `marketing_campaigns` | Belongs to a source. Matched by its `utm_campaign` tag, its `promo_code` (both unique within a practice) or its `tracking_number_id` while it runs (`starts_on`–`ends_on`). `message_campaign_id` can point at a campaign sent from the app (`campaigns`). |
| Cost | `marketing_costs` | An amount in cents for a date range, for a source and optionally one of its campaigns. Voided with a reason (`voided_at`, `void_reason`), never edited or deleted. `client_key` makes a resend safe. |
| Touch | `marketing_touches` | One piece of evidence of where someone came from, recorded once (`touch_key`): how (`method`), the source and campaign, when (`occurred_at`, UTC), whether it was a lead (`lead`, `lead_kind` call/online), and the record it came from (`entity`, `entity_id`). |
| Attribution | `patients.marketing_first_touch_id`, `marketing_last_touch_id`, `marketing_pinned` | Which touches count for the patient. Changed only through `update()`, so every change is on the patient's history with before and after. |
| Referral code | `marketing_referral_codes` | A patient's refer-a-friend code (`?rp=CODE` on the booking page). Random. It never contains personal details. |

## How touches are captured (method)

| Method | From | Source / campaign |
|---|---|---|
| `promo_code` | `online_bookings.promo_code` (typed on the booking page or `?promo=`), or a promo code typed as the chart's "How did you hear about us?" answer | the campaign with that code |
| `referral` | a booking made through a patient's referral link (`online_bookings.referral_code`); `journey_referrals`; the chart's referring doctor (`referred_by_id`) | Patient referral / Doctor referral. A referral link also adds the pair to `journey_referrals`, so the referral thank-you journey runs. |
| `utm` | an online booking's `utm_campaign`, `utm_source` (plus `utm_medium`: google + cpc/ppc/paid is Google Ads), `?src=`, or the referring site | the campaign with that tag, else the source whose name or keys match, else Other |
| `online_booking` | an online booking with no tags | Website / search |
| `tracking_number` | an inbound call to a call-tracking line (`calls.source`, `tracking_numbers`) | the campaign using that line on the day, else the source matching the line's name. A line that matches nothing becomes a source named after it (audited). |
| `call` | a new caller on the main number | none: a lead with an unknown source |
| `staff` | the chart's "How did you hear about us?" (`patients.referral_source`: patient form, intake paperwork, booking page), and corrections made on the chart | the source whose name or keys match the answer ("Online booking" and blanks are not sources) |

Most precise evidence wins inside one booking: promo code, then referral code, then campaign tag, then source tag,
then referring site, then "no tags". Requests the AI receptionist takes on a call are not online bookings. The call
itself is the lead.

**When capture runs:** the marketing job reads new bookings, calls and charts every hour. Once a day after 2am
practice time it makes a full pass, which catches answers edited later, and runs the **backfill**: charts with no
touch (made by hand after a call, or after a request that was put on a new chart) are matched to their first
unlinked booking request (same name plus birth date or phone) or inbound call (same phone, on or before the day the
chart was made). Capture also runs just before the dashboard or a chart's card is shown. Capture is idempotent:
running it again adds nothing. Its changes are recorded as automation ("Marketing capture"), whoever's screen asked
for them.

## First touch and last touch
- The touches that count are the ones with a source, up to the patient's **first visit** (the `new_patients` rule in
  `docs/metrics.md`: the earliest completed appointment or completed procedure's charge; one day of slack for time
  zones). If every touch came later, all of them count, because a late answer is still better than nothing.
- **First touch** = the earliest of those; **last touch** = the latest. Ties go to the lower id.
- **Corrections:** a person with `patients:write` can set the first and/or last touch to a source and campaign.
  This adds a `staff` touch and pins the attribution (`marketing_pinned = 1`) so capture leaves it alone. Replacing
  what the system found needs a reason. "Back to automatic" unpins it and uses only captured evidence (never the
  earlier corrections). Both are audited (`marketing.attribution_edit` / `marketing.attribution_reset`, with
  before → after and the reason).

## The report (MK2)

Filters: a range of months (or dates), **group by** source / campaign / channel / month, **credit** first or last
touch, and the **ROI window** (30, 90, 180, 365 days or to date; default 365). Office filter and people limited to
some offices: patients are held to their offices (`patientScope`).

| Number | Exactly what's counted |
|---|---|
| Leads | Touches marked as leads that happened in the range: each online booking request from someone new (`booking_requests.new_patient`, per person), and a new caller's **first** inbound call from that number (`calls.new_caller`). Grouped by the lead's own source, not the patient's attribution. Leads not yet linked to a chart are left out for people limited to some offices. |
| New patients | The `new_patients` metric: first completed visit in the range, merged charts left out. Grouped by the patient's first (or last) touch. Month = month of the first visit. |
| Booked / showed / show rate | Charts **made** in the range (attributed the same way) that had any visit starting by today (*booked*), and how many of those had a completed visit (*showed*). Show rate = showed ÷ booked. |
| Production *N* days | `SUM(amount)` of live `charge` entries for those patients dated before first visit + *N* days (a charge before the visit counts). Also to date. |
| Collections *N* days | Live `payment` and `insurance_payment` received (as positive) minus live `refund`s, dated before first visit + *N* days. Also to date. |
| Matured *N* | How many of the patients have been with us at least *N* days. Fewer than the new patients means that window is still growing (the screen marks it with *). |
| Treatment accepted | Fees of non-cancelled procedures on treatment plans now `accepted` or `completed`, for those patients (all time). |
| Cost | Live `marketing_costs` spread evenly over their days (whole cents; the remainder goes to the last days, so a cost always adds back to what was entered). Only the days inside the range count. Grouped by the cost's source and campaign. A source-level cost shows as "*Source* — no campaign" when grouped by campaign. |
| Cost per lead | cost ÷ leads |
| Cost per new patient | cost ÷ new patients |
| ROI % | (collections in the chosen window − cost) ÷ cost × 100, one decimal. Collections, not production, because it's cash back. |
| Return multiple | collections in the window ÷ cost |
| Payback months | The first month *m* (1–36; month 1 = the first 30 days from each patient's first visit) by which the group's cumulative collections reach its cost. "Not yet" if they haven't. |
| Lifetime value | collections to date ÷ new patients (also production to date ÷ new patients) |

**Who sees what:** the report needs `reports:read`. Money columns (production, collections, accepted, value) also
need `billing:read`, otherwise they're left out of the response and the CSV. Costs, ROI and payback cover the whole
practice, so they're shown only to people who see every office and only without an office filter. The patient
drill-down (names, first visit, source, and money if allowed) also needs `patients:read`. Looking at it is audited
(`marketing.drill_down`), and so is every CSV (`marketing.export`). No export carries birth dates, phone numbers,
addresses or free-text answers.

**Setup permissions:** sources, campaigns and costs can be changed by administrators and people with `finance:write`.
Every change is audited with before and after.

## Links
- A campaign's link: the practice's booking page (`/book/<slug>`), or a page on the practice's own site with the
  booking button, plus `utm_source` (the source's first key), `utm_medium` (chosen, or the usual one for the channel:
  cpc, social, print…), `utm_campaign` and `promo`. The website button (`/api/public/os/embed.js`) passes `utm_*`,
  `promo` and `rp` from the page's address into the booking page.
- A patient's refer-a-friend link: `/book/<slug>?rp=CODE&utm_source=patient-referral&utm_medium=referral`.
