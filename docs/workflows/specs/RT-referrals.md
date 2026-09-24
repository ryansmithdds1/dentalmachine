# RT — Referral tracker that never loses a patient (RT1–RT5)

**Trigger:** the dentist decides a patient needs a specialist ("refer #19 root canal to Dr. Kim, it's urgent"); the
specialist's letter or report arrives (scanned, faxed, emailed, or uploaded by the specialist through their link);
a patient is referred *to* us; the owner asks "what are we sending out that we could do ourselves?".
**Who:** creating and moving referrals — `patients:write`; attaching files, confirming a report — also
`clinical:read`; marking a report reviewed — `clinical:write`; the in-house opportunity and referral-source
reports — `reports:read`; settings and "run now" — administrators.
**Data:** `server/src/referraltracker.js` (logic), `server/src/routes/referraltracker.js` (routes under
`/api/referral-tracker/…` and the specialist's link `/api/public/referral/:token…`), tables `referrals` (+ new
columns), `referral_items`, `referral_events`, `referral_documents`, `referral_report_matches`, `referral_settings`
(`server/src/db.js`). Pinned by `server/test/referrals2.test.js` and `e2e/workflows/RT-referrals.test.mjs`.

## Click budgets
### Refer the active patient, critical = 3 actions
| Step | Keys | Actions |
|---|---|---|
| Open the form for the active patient (Referrals board, or "Refer…" on the chart / treatment plan) | N | 1 |
| Specialist (the one used last for this kind of work), reason (from the planned procedures), letter by email when they have an address, text to the patient | — (smart defaults) | 0 |
| Critical | click | 1 |
| Send referral | click, or Ctrl/⌘+Enter | 1 |
Routine referral: 2 actions (N, Send).

### Close it when the report comes in = 2 actions (budget), 1 in practice
| Step | Keys | Actions |
|---|---|---|
| File the letter as a referral letter / correspondence (scan inbox, upload, or the specialist uploads it on their link) | — (their filing step) | 0 |
| The report is matched to the open referral and shown on the row ("Report in: file — confirm & complete") | — (automatic) | 0 |
| Confirm & complete | click, or R on the row | 1 |
Pinned by `e2e/workflows/RT-referrals.test.mjs` (3 actions / 6 s; 2 actions / 5 s).

### Board keys
J / K move · Enter opens the side panel · S moves it along (sent → scheduled → seen, with Undo) · R confirms the
report that came in and completes the referral (Undo = reopen) · C closes with a reason · U critical on/off ·
L prints the letter · N refers the active patient · Esc closes the panel. No modals: the form, the referral, the
close reason and settings are side panels.

## What it does
- **RT1 Create in one step** — `POST /referral-tracker/patients/:id/referrals` with the specialist (`contact_id`, or
  `new_contact` typed inline — the same name + practice again is the existing contact), reason, planned procedures
  (`items: [{ procedure_id }]` or `{ code, tooth, surfaces }`), urgency routine / soon / critical, files from the
  chart (`document_ids`), the letter (`send`: email = a secure link, print, print to fax, none) and a text to the
  patient with the specialist's name and number (`text_patient`, default from settings). Every procedure is priced
  on the day (office fee via `officeFee`, PPO allowed via `resolveFee` on the patient's plan) for RT5.
  Idempotent: the form sends a `client_key` (unique per practice) plus the usual Idempotency-Key; the same form
  twice returns the first referral (`replayed: true`).
- **The letter** — email carries only a link (no patient details in the email). The link (60 days) opens a plain page
  with the letter, medical alerts, insurance, the attached files, "Scheduled"/"Patient seen" buttons and a report
  upload; each view/download is audited as `Specialist link: <name>` (source integration). A report uploaded there is
  linked to the referral straight away (the link proves which one). There is no fax service connected: "Print to
  fax" prints the existing letter (`/referrals/:id/letter`) and records it.
- **RT2 Follow it to the end** — statuses open → scheduled → seen → report_received → closed, each with its date
  (`scheduled_on`, `seen_on`, `report_received_on`) and a timeline row (`referral_events`: who, when, source).
  Expected-by dates per urgency (settings: 30 / 14 / 7 days). Closing always has a reason (completed, treated here,
  patient declined, no longer needed, sent elsewhere, entered by mistake, other + note); reopening needs a note.
  - **Critical** referrals alert the referral's dentist, every active front-desk user and anyone added in settings —
    Needs attention (one item per referral, severity high, counted up on each repeat), an urgent team-chat post
    mentioning them, and a live alert — when created (or made critical) and then every **7 days** (setting) until
    the patient is seen or the referral is closed. The repeat is claimed with one conditional UPDATE, so two job
    runs can't both send it.
  - **Routine / soon** referrals don't nudge anyone by default. With "make a task when overdue" on, an overdue one
    gets one task for its owner (never two open at once; at most one a day).
  - **Past-due report** — `GET /referral-tracker/past-due` (and the board's Past due tab): everything open more than
    30 days (setting), filterable by urgency, specialist and dentist, CSV download.
  - Shown on the **patient bar** (`ReferralChip`: red when a critical one isn't seen yet) and in the **huddle**
    (`ReferralHuddle`: critical ones, and referrals of today's patients).
- **RT3 Closing the loop** — when a patient document is filed as `referral` or `correspondence` (upload, re-filed,
  or suggested so by the reader), `referralDocumentFiled` compares its read text and file name with the patient's
  open referrals out (specialist's surname, practice name, specialty). Clear winner → a suggestion; unclear → the AI
  adapter (`createReferralMatcher`: Claude through `ai.js` only when the practice allows AI reading of documents;
  sandbox in tests/demos; off otherwise) may pick one with a one-line reason. **Nothing is linked until a person
  confirms** (`POST /referral-tracker/matches/:id/confirm`, optional `complete`); dismissed suggestions never come
  back. Confirming links the report, sets report_received and gives the dentist a task to review it; "I've reviewed
  the report" closes that task. The job also sweeps the last 30 days of filed letters no hook saw.
- **RT4 Referred to us** — the same form with direction `in` (referring doctor; the first one becomes the patient's
  "referred by"). Thank-you letter (template; by email with the patient's first name and initial only, or printed;
  once unless resent). "Ready to report back" once treatment since the referral is complete and nothing is planned;
  the report back lists the completed procedures, goes by secure link or print, and closes the referral.
  `GET /referral-tracker/sources`: per referring doctor — patients, production since, % thanked, % reported back.
- **RT5 In-house opportunity** — `GET /referral-tracker/opportunity?from&to`: everything referred out with codes,
  counts and value at the office's fees and after PPO write-offs (fees stored on the day of the referral), by
  category, procedure, month, year and specialist, with a headline ("You referred out 46 × D3330 … ≈ $58,000").
  Referrals closed as "entered by mistake" don't count; referrals without codes are counted separately.

## Safety
- Server validation: patient, specialist, provider, owner, documents and procedures must be this practice's (and the
  patient's); codes must be in the practice's code list; teeth 1–32 / A–T; dates real and not in the future
  ("scheduled" may be); office-restricted users only see referrals of patients in their offices.
- Nothing is deleted: referrals are closed with a reason; events are append-only; suggestions are dismissed, not
  removed. Every change goes through `insert`/`change` (before/after) and `audit()` with the reason.
- AI never changes a referral: it suggests a match with its reason (source ai on the audit row); a person confirms.
- Failures are visible: an email that doesn't go, a chat post that fails, a matcher or job that breaks → Needs
  attention items, resolved automatically by the next success.
- Messages go through `sendMessage`: patient opt-outs and STOP are respected (a child's text goes to the parent).

## Settings (`GET/PUT /referral-tracker/settings`, administrators)
Expected-by days (routine 30, soon 14, critical 7), past due after 30 days, critical re-alert every 7 days, tasks for
overdue routine/soon (off), text the patient (on), extra people to alert, and the patient text / thank-you / report
back wording (placeholders `{first_name} {practice} {specialist} {specialist_practice} {specialist_phone} {urgent}
{practice_phone} {contact_name} {patient_name} {referral_date} {treatment} {note} {provider}`).

## Mounting (hand-off)
- `server/src/app.js`: `import referralTrackerRoutes, { referralPublicRoutes } from './routes/referraltracker.js';`,
  `api.use(referralTrackerRoutes({ db, storage, config, messenger }));` next to `referralRoutes`, and
  `referralPublicRoutes({ db, storage, config })` added to the `/api/public` list (next to `labPublicRoutes`).
- `server/src/index.js`: run `runReferralJobs(db, { storage, config })` hourly (`runExclusive('referrals', …)`).
- `client/src/App.jsx`: `const Referrals = lazy(() => import('./pages/Referrals.jsx'));`,
  `<Route path="/referrals" element={<Referrals />} />`, sidebar `['/referrals', Send, 'Referrals', can('patients:read')]`.
- `PatientBar.jsx`: `<ReferralChip patientId={p.id} />`; `Dashboard.jsx`: `<ReferralHuddle date={date} />`;
  treatment plan / chart: `<ReferButton patient={p} procedureIds={[…planned ids]} />`.
