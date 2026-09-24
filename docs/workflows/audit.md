# Workflow audit

What each of the 54 workflows in `task-list.md` costs a user today, traced through the code (September 2026).
One **action** is a click, a key press or a field typed; searching counts as one field. Budgets are the target
for the redesign and become the limits in each workflow's spec and Playwright test.

| # | workflow | current location in code | current clicks/steps | main friction points | target budget (actions) | automatable | effort |
|---|---|---|---|---|---|---|---|
| 1 | Search/open patient | `components/CommandPalette.jsx` (Ctrl K or `/`), `pages/Patients.jsx`, `pages/PatientDetail.jsx`; `GET /search` (`routes/frontdesk.js`) | 3 actions (Ctrl K, name, Enter), 1 screen change | Opening a chart with an office alert pops a modal (1 more dismiss). No recent-patients list on an empty query. Search is exact-substring: no typos, DOB only as YYYY-MM-DD, no old-system chart number. | 3 | full (already) | S |
| 2 | Today's schedule / switch provider or op | `pages/Schedule.jsx`, `components/calendar/CalendarGrid.jsx`; `GET /schedule` | 2 actions (G S, click Chairs/Providers) | Chairs/Providers toggle has no key; the provider filter is hidden in Day view; changing office reloads the whole page. | 2 | full | S |
| 3 | Appointment status arrived → seated → ready → out | `components/calendar/AppointmentDrawer.jsx`; `PATCH /appointments/:id/status` (`routes/schedule.js`) | 2 clicks per step (open drawer + button), ~6 per visit | Every step opens the drawer. No keyboard keys. No "Ready" status (only a "Text we're ready" button). | 1 per step | partial | S |
| 4 | Patient summary glance | `components/calendar/PatientHoverCard.jsx` (`GET /patients/:id/card`), `PatientDetail.jsx` header/Overview | 0 from schedule (hover, mouse only); 3+ from anywhere else | Hover card is mouse-only. Balance, insurance and next visit need the full chart; nothing follows you to other screens. | 1 | full | S |
| 5 | Identify inbound caller | `components/CallPop.jsx` (live `call` event, `GET /calls/:cid`), `pages/Calls.jsx` | 0 to see, 1 click to open chart | Unknown caller shows "Not a patient on file" with no next step. Pop disappears after 90 s. No key to open the popped caller. | 1 | full | S |
| 6 | Send/read texts | `pages/Inbox.jsx` (`/messages`), `components/patient/CommsTab.jsx`; `/conversations` (`routes/sms.js`) | Read 2 clicks; send 4 actions | Unknown numbers need "Attach to patient" in a modal. Chart and Inbox use different composers. | 3 | partial | S |
| 7 | Clinical/progress notes | `components/NoteComposer.jsx`, `patient/NotesTab.jsx`, `ChartTab.jsx`; `POST /patients/:id/notes`, `/notes/:nid/sign` (`routes/clinical.js`) | ~7 actions (open patient 3, tab, template select, text, save) | Template picked by hand every time (no default from the day's visit). `window.confirm` on unanswered questions. Visit link chosen separately after saving. | 4 | partial (auto-draft from completed procedures exists) | M |
| 8 | Chart existing conditions | `patient/ChartTab.jsx` EntryPanel, `components/Odontogram.jsx`; `POST /patients/:id/conditions` (`routes/clinical.js`) | ~9+ actions per finding (open patient 3, tab, tooth, Condition mode, surfaces 1–3, condition select, save) | Mode resets to Procedure; no keyboard tooth entry; no shorthand ("30 MO caries"); condition notes via `window.prompt`, delete via `window.confirm`; no multi-tooth entry. | 4 | partial | M |
| 9 | Book an appointment | `pages/Schedule.jsx`, `components/AppointmentForm.jsx`; `POST /appointments` (`routes/schedule.js`) | Drag a slot 1 + patient 1–2 + type 1 + Book 1 = 4–5; from N/+ about 7–8 (date, time, length too); 1 modal | Type doesn't set the length after a drag. N/+ defaults to 09:00/60 min. Provider falls back to the first provider, not the patient's own. Open-time finder only shows :00/:30. 12+ fields incl. Status on a new booking. | 3 | partial (suggest the next slot) | S |
| 10 | Move/reschedule | `components/calendar/CalendarGrid.jsx` (drag, resize, pinboard), drawer "Move…"; `PUT /appointments/:id` | Same day 1 drag (with undo); other day 3–4 | No keyboard move (cards only take Enter). Moving onto a blockout uses `confirm()`. | 1 drag / 3 keys | no | M |
| 11 | Set procedures complete | Drawer "Complete visit & procedures" → `PATCH /appointments/:id/status`; chart row Complete (`POST /procedures/:pid/complete`); Checkout | 2 from schedule; 1 per procedure in the chart | No "complete all of today's" in the chart; can't change provider/fee at completion; undo via `window.prompt`; deletes via `window.confirm`. | 2 | full (visit complete completes its procedures) | S |
| 12 | Take a payment | `patient/LedgerTab.jsx`, `pages/Checkout.jsx`; `POST /patients/:id/payments` (`routes/billing.js`) | Chart: 3 (tab, Take payment, Post), 1 modal; checkout 1 | Method always defaults to card, no memory. No payment from the schedule drawer. Card reader stacks a modal inside checkout. | 2 | partial | S |
| 13 | Confirm appointments | Drawer "Confirm…"; `pages/Followups.jsx` Unconfirmed tab; `PATCH /appointments/:id/status`; patient link `POST /confirm/:token` | 2 per visit from drawer | "N unconfirmed" on the schedule isn't a link. No bulk confirm or "remind all unconfirmed". | 1 per row | full (texts and replies already automate most) | S |
| 14 | View/attach x-rays and photos | `patient/DocumentsTab.jsx`, `imaging/ImagingStudio.jsx`, `ImageViewer.jsx`; `POST /patients/:id/documents` | View 3; attach 4–5 | No drag-and-drop upload. No images link from the schedule drawer. Category always defaults to x-ray. Removes use `confirm()`. Viewer stacks an edit modal. | 2 | partial (sensor capture exists) | M |
| 15 | Review/update medical history | `pages/PatientDetail.jsx` (MedicalSummary, HealthHistoryEditor, HistoryReview); `POST /patients/:id/medical-reviewed` | "Reviewed today" 1; updating 4–6 across two modals | Alerts/allergies/meds live in Edit patient; conditions/ASA in another modal. Nothing from the schedule. Staleness only a passive note. | 2 | partial (intake form diff exists) | S |
| 16 | Schedule next hygiene at checkout | `pages/Checkout.jsx` "Book recall" → AppointmentForm | 5–6 incl. leaving the schedule | **Bug:** recall type passed but length stays 60. Time 09:00, provider = first provider not the hygienist, chair blank. No suggested open slot on the due date. | 2 (accept suggested slot) | full | S |
| 17 | Explain a balance / ledger | `patient/LedgerTab.jsx`; `GET /patients/:id/ledger` | 2 (chart, Ledger tab) | No plain-language "why do I owe this" by visit. No balance in the schedule drawer. | 1 | partial | M |
| 18 | Estimate patient portion | Treatment plans (`TreatmentTab.jsx`), Checkout. `POST /patients/:id/estimate` exists but nothing in the client calls it | 3+ and a plan is required | No quick "what would this cost". Booking shows no estimate for the visit. | 2 | full | M |
| 19 | Cancellations and no-shows | Drawer → `PATCH /appointments/:id/status`; broken list `GET /followups/broken` | No-show 2 (no undo); cancel 3 | No reason recorded, no fee, no "rebook now". Slot refill is automatic (good). | 3 incl. rebook | partial | S |
| 20 | Verify eligibility and benefits | `patient/Eligibility.jsx`, `components/EligibilityBatch.jsx`, schedule drawer link; `POST /insurance/:iid/eligibility`, `POST /eligibility/:eid/apply` (`routes/edi.js`); nightly job for tomorrow | 4 from the schedule (real-time); 9+ with a manual clearinghouse | Results never applied to the policy on their own ("Apply to policy" by hand). Nightly job needs a real-time clearinghouse. Manual 270/271 round trip leaves the app. | 1 (review exceptions) | full | S |
| 21 | Build a treatment plan | `patient/ChartTab.jsx` EntryPanel, `TreatmentTab.jsx`; `POST /patients/:id/procedures`, `POST /patients/:id/treatment-plans` | ~5 per procedure + ~3 for the plan; ~22 for a 3-procedure plan | "Add to plan" defaults to "Not on a plan yet". Plan builder has a dropdown of every code, no search. Fee/discount via `window.prompt`; delete via `confirm()`. | 3 per procedure + 1 | partial | M |
| 22 | Present treatment / acceptance | `TreatmentTab.jsx` PresentModal, `pages/public/CaseAcceptance.jsx`; `POST /treatment-plans/:tid/present`, `POST /tp/:token` | Staff 3 + patient 6 | Even on the office tablet the patient types their DOB. Opens a new browser tab. | 2 staff + 3 patient | partial | S |
| 23 | Sign consent forms | `components/FormsSend.jsx` (from Treatment tab); `GET /patients/:id/consents/suggest`, `POST /patients/:id/form-packets` | Staff 3 + patient DOB and sign | DOB gate on the office tablet. Only from the Treatment tab, not from the appointment. | 1–2 | full | S |
| 24 | Create and send claims | `pages/Checkout.jsx`, `patient/InsuranceTab.jsx`, `pages/Claims.jsx`, `ClaimDetail.jsx`; `POST /claims`, `POST /claims/submit` | 4 from checkout; ~6 from the Insurance tab | Claims not created at completion/checkout, not sent automatically. Resend asks `confirm()`. | 0–1 (auto-create, auto-send clean claims) | full | M |
| 25 | Attach x-rays or narratives | `ClaimDetail.jsx`; `POST /claims/:cid/attachments`, `/attachments/send`, `POST /claims/:cid/narrative` | ~7 per attachment | Document dropdown lists every chart document (not filtered by tooth/date), one per attachment. Validator knows what's needed but nothing is attached for you. | 2 | partial | M |
| 26 | Fill openings from the ASAP list | `server/src/fill.js` (automatic texts), `Schedule.jsx` Waitlist/ASAP panel; `GET /asap`, `POST /waitlist/offer` | Automatic for cancellations ≥ 2 h ahead; manual 6–7 | Manual offer time defaults to 09:00, not the gap. No "offer this gap" from an empty slot. Placement mouse-only. | 2 | full | S |
| 27 | Update demographics or contact info | `components/PatientForm.jsx` (Edit window); `PUT /patients/:id`; portal self-service | 6 | Full 30-field form for one change; no inline edit. Address change doesn't reach the household. | 3 | partial | S |
| 28 | Staff-to-staff message or task | `pages/Office.jsx`, `OfficeForms.jsx` TaskForm; `POST /tasks` | ~9 (from the chart ~7) | No staff messaging; no notification or badge to the assignee; no replies. | 3 | no | M |
| 29 | Perio charting | `patient/PerioTab.jsx`, `voicePerio.js`; `POST /patients/:id/perio`, `PUT /perio/:eid` | ~170–190 depth keys + a click for margins + ~190 more; bleeding by mouse | Bleeding/pus/plaque not on the keyboard. Switching to margins needs a click. | ~170 keys, bleeding inline by key | no (voice partial) | S |
| 30 | Collect/import online intake forms | `pages/public/IntakePage.jsx`, `routes/public.js`, history review in the chart; auto-send `runFormSends` | Sending automatic; review 2 | Pending reviews only as per-chart banners and a huddle flag; no worklist. Card photos filed as documents with no prompt to enter the policy. | 1 | full | M |
| 31 | Enter or scan a new insurance card | `patient/InsuranceTab.jsx` PolicyForm, phone scan in `DocumentsTab.jsx`; `POST /patients/:id/insurance` | ~11; +4 to scan; +2 to verify | Everything retyped from the card. Missing carrier is a dead end (go to Settings). | 4 (photo → read → confirm) | partial | M |
| 32 | New patient setup | `pages/Patients.jsx` → `components/PatientForm.jsx` (~25 fields) → `patient/InsuranceTab.jsx` PolicyForm; `POST /patients`, `POST /patients/:id/insurance` | 16–20 over 2 modals and 2 screens | Two modals on two screens. Portal-submitted insurance (with card photos) is retyped. Card reading exists only for plans, not policies. | 8 | partial | M |
| 33 | Post insurance payments (ERA/EOB) | `pages/Claims.jsx` (ERA and Checks tabs), `ClaimDetail.jsx`; `POST /era/import`, `POST /insurance-checks`, `POST /claims/:id/payment` | ERA automatic with a batch clearinghouse, else 3; paper EOB ~5 + 2 per claim | Multi-claim check form doesn't prefill paid/write-off unless AI read is used; must balance exactly; duplicate check via `confirm()`; unmatched ERA lines have no fix-up path. | ERA 0; EOB 3 + 1/claim | full (ERA) / partial | M |
| 34 | Write prescriptions | `patient/RxTab.jsx`; `POST /patients/:id/prescriptions` | 4–7 (+ code for controlled drugs) | Prescriber defaults to the first provider, not the signed-in dentist. Can't prescribe from the note. Pharmacy picker is a separate modal. | 3 | partial | S |
| 35 | Create/track lab cases | `pages/Office.jsx`, `PatientDetail.jsx` → `components/OfficeForms.jsx` (LabCaseForm, LabRx); `POST /lab-cases`, `POST /lab-cases/:lid/send` | 12–15 | Digital Rx only after saving (reopen the case). Tooth/shade typed twice. `confirm()` on save. No overdue-lab alert. | 6 | partial | M |
| 36 | Morning huddle report | `pages/Dashboard.jsx` (home); `GET /huddle` | 0 to view; each fix goes to another screen | Flags (unconfirmed, verify insurance, forms, balance, unscheduled treatment) are read-only badges. Not emailed. | 0 + 1 per fix inline | full | S |
| 37 | Recall and unscheduled treatment lists | `pages/Followups.jsx` (Recall, CallList, BookModal → AppointmentForm); `/recalls`, `/followups/unscheduled` | 7–9 per patient | Booking from a recall passes only the date: no recall type, hygienist, length or open slot. No "next patient". | 3 per patient | partial (recall texts automatic when on) | M |
| 38 | Pre-authorizations | `TreatmentTab.jsx` → `Claims.jsx` Preauths; `POST /preauths`, `POST /preauths/:aid/837` | ~7 over 2 screens + manual upload | 837 only downloads, not sent through the clearinghouse; no attachments; answers typed by hand. | 2 | partial | M |
| 39 | Patient financing application | `patient/Financing.jsx` (in Ledger), TreatmentTab lender links; `POST /patients/:id/financing` | 5–6; later updates 3–4 | Amount empty although the plan's patient portion is known; plan-tab lender links aren't tracked; status by hand without the lender webhook. | 2 | partial | S |
| 40 | Adjustments and write-offs | `LedgerTab.jsx` AdjustmentForm; `POST /patients/:id/adjustments`; collections write-off | 5 | Not tied to a procedure; no batch small-balance write-off; amount not prefilled. | 3 | partial | S |
| 41 | Referral out letter | `PatientDetail.jsx` (referral card); `POST /patients/:id/referrals`, `GET /referrals/:rid/letter` | 6–10 | Print only (no email/fax although stored); no images attached; status by hand. | 4 | partial | M |
| 42 | End-of-day close, deposit, reconciliation | `components/Deposits.jsx`, `CloseBooks.jsx`, `Reconciliation.jsx`; `/deposits`, `/close` | 10–12 over 3 screens | Three places; `confirm()` on close; reconcile by typing the bank amount even though bank lines sync; no cash-drawer count. | 4 | partial | M |
| 43 | Review request after visit | `server/src/messaging.js` runReviewRequests; settings | 0 (automatic once set up) | No manual "ask now". **Bug:** the reputation page counts `kind='review_request'` but requests are saved as `kind='review'`, so the count is always 0. | 0 | full | S |
| 44 | Clock in/out | `components/TimeClock.jsx` (sidebar), Office → Time; `POST /timeclock/in`, `/out` | In 1; out 3 (with a `window.prompt` for break minutes) | Breaks typed from memory; nothing catches a forgotten clock-out. | 1 | partial | S |
| 45 | Claim follow-up / insurance aging | `pages/Claims.jsx` (InsuranceFollowup, `?tab=followup`), `components/ClaimEdi.jsx` CallForm; `GET /reports/outstanding-claims` (`routes/ppo.js`), `POST /claims/:id/calls` | 2 to reach; ~6 per claim in a modal; status check +3 | Sorted by submit date, not follow-up due; no "due today". Bulk status check only on the Claims list. No "next claim". The clearinghouse job never sends status requests for aged claims. | 2 + 3/claim | partial | M |
| 46 | Denied claim appeals | `pages/ClaimDetail.jsx` (Appeal, DenyForm); `POST /claims/:cid/appeal` (`routes/claimai.js`) | ~7–11 | Letter only in page state (lost on leaving), not saved as a document. No appeal status/date/follow-up. Print via `window.open`. Void uses `confirm()`. | 4 | partial | M |
| 47 | Patient statements | `pages/Claims.jsx` (Statements tab); `GET /statements/candidates`, `POST /statements/run` (`routes/growth.js`) | 3; +2 per print-only account | No scheduled run. Print-only statements one at a time, no combined PDF. No preview. | 0 (scheduled) / 2 | full | S |
| 48 | Refunds | `patient/LedgerTab.jsx` RefundForm; `POST /patients/:id/refunds` (`routes/billing.js`) | 6 (amount and card prefilled) | Credit balances only in a collapsed section of A/R aging; no refund queue; leaving the screen to refund. | 3 | partial | S |
| 49 | Production/collection/KPI reports | `pages/Reports.jsx`, `components/Analytics.jsx`; `/reports/*`; scheduled saved reports | 1–3 for KPIs; 4–6 for P&C | KPIs spread across tabs; CSV per table; scheduled delivery exists but isn't the default. | 1–2 | full (partly) | S |
| 50 | Schedule templates and provider hours | `pages/Settings.jsx` (ResourceForm, OfficeHours, AltWeeks, TimeOff), `calendar/BlockoutForm.jsx`; `POST /blockouts`, `/providers/:pid/exceptions` | Hours 5 + 2/day; time off ~6; recurring block ~8–9 | Edited in Settings, not from the schedule. No named day templates or "copy to other days". No effective dates. | 4 | partial | M |
| 51 | Merge duplicate patients | `components/Switching.jsx` (DuplicateCharts, MergeDialog), patient menu; `GET /patients/duplicate-groups`, `POST /patients/:id/merge` | 5–6 | Which chart is kept isn't chosen (first of the pair); no side-by-side compare; matching is exact name + DOB only; nothing flags duplicates automatically. | 3 | partial | S |
| 52 | Inventory ordering | `components/Supplies.jsx`; `GET /inventory/reorder`, `POST /inventory/:iid/moves` | 4 + ordering outside the app; receiving 2–3 per item via `window.prompt` | No purchase orders or "ordered" state; no supplier email; no low-stock alert. | 3 | partial | M |
| 53 | Fee schedule updates | `pages/Settings.jsx` (FeeSchedules, FeeScheduleEditor, CodeImport); `PUT /fee-schedules/:fid` (`routes/ppo.js`) | 4 + 1 per code | No "+X%" bulk change, no effective date, no unsaved-changes warning; CSV import only for standard fees. | 4 (bulk %) | partial | M |
| 54 | Month-end close reports | `components/CloseBooks.jsx`; `GET/POST /close` (`routes/close.js`); Reconciliation tab | 5 + each loose end leaves the screen; reports 2–4 each | Totals, aging, reconciliation and P&C aren't one packet; `window.confirm`; never prompted. | 3 | partial | M |

## Shared problems

- **`window.confirm` 28 times and `window.prompt` 16 times** in the client (condition notes, un-complete reasons, fee
  changes, break minutes, receiving stock…). They block the page, can't be undone and break keyboard flow.
- **The patient doesn't follow you.** Leaving the chart loses the patient; the schedule, billing, messages and
  lists each start over. Balance, insurance and next visit only show on the chart.
- **Defaults are generic.** Booking falls back to 09:00, 60 minutes and the first provider; prescriptions to the first
  provider; payments always to card. Nothing remembers what a person used last.
- **Fixes mean leaving the screen.** Huddle flags, follow-up lists, month-end loose ends and aging all link away
  instead of letting the fix happen in place.
- **Mouse-only steps** in the top 20: moving an appointment, status changes (drawer each time), perio bleeding,
  tooth selection, hover cards.
- **Existing pieces to build on:** Ctrl/⌘K command palette with book/text/pay verbs, `?` shortcut list, G-then-letter
  navigation, schedule keys, drag-and-drop with undo on the schedule, `/patients/:id/card` summary endpoint, live events.

## Bugs found during the audit

- Booking a recall from checkout keeps a 60-minute length instead of the recall type's length (#16).
- The reputation page counts `review_request` messages but requests are saved as `review`, so it always shows 0 (#43).
- `POST /patients/:id/estimate` exists but nothing calls it (#18).

## Not in the app yet

- "Ready" as an appointment status (ready for the doctor / for checkout).
- Staff-to-staff messages, and notifications when a task is assigned.
- Keyboard rescheduling; keyboard perio bleeding; keyboard tooth entry and a charting shorthand ("30 MO caries").
- Quick patient-portion estimate outside a treatment plan.
- Reason, fee and "rebook now" for cancellations and no-shows.
- Reading an insurance card photo into a policy; applying eligibility results automatically.
- Creating claims at checkout and sending clean claims automatically; suggesting the right x-rays for a claim.
- One worklist for history reviews, portal insurance updates and card photos.
- A staff pass so signing on the office tablet skips the DOB check.
- Electronic pre-authorization sending; referral letters by email/fax.
- Scheduled statement runs; appeal tracking; refund queue; purchase orders; bulk fee changes; schedule templates;
  one end-of-day screen; one month-end packet; a forgotten-clock-out alert; an overdue-lab alert.

## The 10 biggest wins (how often × time saved)

| Rank | Change | Workflows | Why |
|---|---|---|---|
| 1 | Active patient bar that follows you, with alerts, balance, insurance, next visit and actions | 1, 4, 6, 12, 17 | Hundreds of times a day; removes re-searching and chart detours |
| 2 | Status changes by key and one click from the schedule, plus a "Ready" status | 3 | 100+ a day × 2 clicks saved each |
| 3 | Chart by keyboard with a shorthand ("30 MO caries", "14 D2740") and batch entry | 8, 21 | Every exam; ~9 → 4 actions per finding |
| 4 | Booking with real defaults (patient's provider, type length, next open slot) and keyboard moves | 9, 10, 16, 37 | 30–100 a day; ~8 → 3 |
| 5 | Notes default to the visit's template and drafted procedures; no blocking confirm | 7 | Every visit |
| 6 | Automatic claims: created at checkout, clean ones sent, x-rays suggested | 24, 25 | Removes a daily manual batch |
| 7 | Eligibility applied automatically overnight; staff see only problems | 20, 36 | 10–30 a day → review only |
| 8 | Perio fully on the keyboard (bleeding, pus, margins) | 29 | Every hygiene visit, ~20 clicks saved |
| 9 | Insurance card photo read into the policy | 31, 32 | 10–30 a day; ~11 → 4 |
| 10 | Undo toasts instead of confirm/prompt dialogs everywhere | all | 44 blocking dialogs removed |
