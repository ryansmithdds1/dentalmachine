# MK — Marketing ROI, end to end (MK1–MK2)

**Trigger:** the owner asks "which marketing actually pays?". A new patient calls a tracking number, books online
from an ad, a mailer or a friend's link, or tells the front desk how they heard about us. The office gets an ad
invoice, starts a mailer or needs a link for an ad.
**Who:** Marketing results: `reports:read` (money also needs `billing:read`; costs, ROI and payback need access to
every office). The patients behind a number also need `patients:read`. Sources, campaigns and costs: administrators
or `finance:write`. A chart's "Where they came from": `patients:read` to see it, `patients:write` to change it.
**Data:** `server/src/marketing.js`, `server/src/routes/marketing.js` (under `/api/marketing/…`), tables
`marketing_sources`, `marketing_campaigns`, `marketing_costs`, `marketing_touches`, `marketing_referral_codes`,
`marketing_sync_state`, columns `patients.marketing_first_touch_id` / `marketing_last_touch_id` /
`marketing_pinned`, `online_bookings.promo_code` / `referral_code` (`server/src/db.js`). Definitions:
`docs/marketing.md`. Pinned by `server/test/marketing.test.js`.
**Screens:** `client/src/pages/Marketing.jsx` (Results · Sources & campaigns · Costs),
`client/src/components/marketing/AttributionCard.jsx` (on the chart), the "How did you hear about us?" field on the
patient form (lists the practice's sources and takes a promo code), and the promo code field on the booking page.

## Click budgets
### See which source pays = 1 action
| Step | Keys | Actions |
|---|---|---|
| Open Marketing (sidebar, or Ctrl/⌘-K "Marketing results") | click / Ctrl-K | 1 |
| Last 12 months by source, first touch, first-year ROI | — (defaults) | 0 |

### See the patients behind a number = 1 action
| Step | Keys | Actions |
|---|---|---|
| Move to the row and open it (side panel) | J/K + Enter, or click | 1 |
| Open a patient | click | (1) |

### Enter an ad invoice = 2 actions
| Step | Keys | Actions |
|---|---|---|
| Costs tab | 3 | 1 |
| Source (the last one used stays picked), dates (from = first of this month), amount | type | 0 |
| Add cost | Enter | 1 |

### Link for a new ad = 3 actions
| Step | Keys | Actions |
|---|---|---|
| Sources & campaigns (2); name + source (+ promo code) then Add campaign | 2, type, Enter | 2 |
| Link, then Copy | click, click | 1 + 1 (the medium defaults to the channel's usual one) |

### Correct where a patient came from = 2 actions
| Step | Keys | Actions |
|---|---|---|
| "Change" on the chart's Where they came from card | click | 1 |
| Source (+ campaign), reason, Save | type, Enter | 1 |

No modals: the drill-down is a side panel, and the link builder and the void reason appear in place. Nothing asks
"are you sure?". A cost entered by mistake is voided with a reason (and appears struck through), because money
records are reversed, not deleted.

## What it does
- **MK1 attribution.** Touches are captured automatically from online bookings (UTM tags, `?src=`, promo codes,
  referral links), inbound calls to call-tracking lines, the chart's "How did you hear about us?" answer (patient
  form, intake paperwork, booking page), referring doctors and patient-to-patient referrals. Each patient has a first
  and a last touch (the rules are in `docs/marketing.md`). People can correct them, which pins the attribution,
  needs a reason when it replaces evidence, and records the change with before → after. "Back to automatic" undoes
  it. The nightly backfill links charts made by hand to their first booking request or call.
- **MK2 dashboard and report.** By source, campaign, channel or month: leads (calls and online), new patients, show
  rate, production and collections within 30/90/180/365 days of the first visit and to date (ledger, voided entries
  left out), treatment accepted, cost, cost per lead and per new patient, ROI, payback months and lifetime value.
  First- or last-touch credit. Drill-down to the patients. CSV of the summary and of the patients.
- **Helpers.** A campaign link builder (booking page or the practice's own page with the booking button, with
  `utm_*` and `promo`), the promo code field on the booking page, the website button passing `promo`/`rp`, each
  patient's refer-a-friend link, and the "Marketing capture" job (hourly, plus the nightly full pass and backfill).

## Safeguards
- Money from the ledger only (`SUM(amount)`, live entries), integer cents. Costs are voided, never edited. The same
  cost sent twice (`client_key`) is kept once.
- Capture is idempotent (`touch_key` unique per practice). The evidence itself never changes afterwards, except
  that the patient is filled in when a lead is linked to a chart later, and a changed "How did you hear" answer
  replaces the touch it made (audited).
- Every id is checked against the practice. A campaign must belong to the cost's source, and a correction's source
  must be the practice's own. Promo codes and campaign tags are unique within a practice.
- Patient names appear only in the drill-down and its CSV (audited, `patients:read`). Money needs `billing:read`.
  Practice-wide costs are not shown to people limited to some offices.

## To wire up (lines for shared files)
- `server/src/app.js`: `import marketingRoutes from './routes/marketing.js';` and, with the other signed-in routers,
  `api.use(marketingRoutes({ db, config }));`
- `server/src/index.js`: `import { runMarketingJobs } from './marketing.js';` and
  ```js
  // Marketing capture: where new leads and patients came from (hourly); full pass + backfill nightly after 2am.
  if (process.env.MARKETING_JOBS !== 'off') {
    const marketing = () => runExclusive('marketing', 30 * 60 * 1000, () => runMarketingJobs(db)).catch(jobFailed('Marketing capture'));
    setInterval(marketing, 60 * 60 * 1000).unref();
    setTimeout(marketing, 130_000).unref();
  }
  ```
- `client/src/App.jsx`: `const Marketing = lazy(() => import('./pages/Marketing.jsx'));`, the route
  `<Route path="/marketing" element={<Marketing />} />`, and a sidebar entry (Megaphone icon) for people with
  `reports:read`.
- `client/src/pages/PatientDetail.jsx` (overview): `import AttributionCard from '../components/marketing/AttributionCard.jsx';`
  and `<AttributionCard patientId={patient.id} />`.
- `server/src/reportlibrary.js`: `import { MARKETING_LIBRARY_REPORT } from './marketing.js';` and
  `def(MARKETING_LIBRARY_REPORT);` in the Patients section.
- `docs/architecture-and-data-rules.md`, in "Communication, work and history": *Marketing attribution:
  `marketing_sources` / `marketing_campaigns` / `marketing_costs` (voided, never edited) and `marketing_touches`.
  The patient's first and last touch are `patients.marketing_first_touch_id` / `marketing_last_touch_id`
  (`docs/marketing.md`).*
