# Dental Machine

Cloud practice management software for dental offices: scheduling, patient records, clinical charting, treatment planning, billing, insurance claims and reporting. Several practices can share one deployment, and each practice's data is kept separate.

## Features

| Area | What it does |
| --- | --- |
| **Scheduling** | A fast calendar with day view (by chair or by provider), week view, and a list view that phones use automatically.<br>• **Mouse:** drag an appointment to move it, including to another chair, provider or day. Drag its bottom edge to change its length, or drag across empty time to book or block it.<br>• **Phone:** tap *Move*, then tap the new time.<br>• **Speed:** changes show instantly, roll back if the server rejects them, and every move has Undo. Every open screen updates live, including when a patient confirms by text or link. Neighbouring days are loaded in the background so moving between dates is instant.<br>• **On the grid:** office hours, blocked time (lunch, meetings, holidays; can repeat weekly), a current-time line, appointment types with colours and preset procedures, scheduled production against the daily goal, confirmation status, medical-alert flags and an ASAP list.<br>• **Rules:** no double-booking of a provider, chair or patient. Booking into blocked time asks for confirmation. Keyboard shortcuts: ←/→ change day, T today, D/W/A switch view, N new appointment. |
| **Today (morning huddle)** | One screen for the day: scheduled production against goal, and every patient on the schedule with what the team needs to know. Flags cover new patients, birthdays, unconfirmed visits, insurance to verify, medical history due for review, forms not returned, lab cases not back, recall due, diagnosed-but-unscheduled treatment and balances to collect. Filter by flag, print the huddle, or print a **route slip** that travels with the patient. |
| **Recurring visits & provider hours** | Book a visit that repeats every 1–4 weeks or every 1, 3 or 6 months. Times that are already taken are skipped and listed. Moving or cancelling a visit asks whether to change just that visit or that visit and the ones after it. Each provider can have their own weekly hours: their column is shaded outside them, online booking and open-time search respect them, and staff are asked before booking outside them. |
| **Patients** | Demographics, medical alerts, allergies and medications, referral source, and a **pop-up office alert** ("prefers text", "collect balance first") shown once when the chart opens. A "medical history reviewed" stamp flags charts due for an annual update. Patients are archived rather than deleted, so records are kept. |
| **Quick search** | Press **Ctrl K** (or **/**) anywhere to find a patient by name, phone, DOB or ID, open a claim, or jump to any page. |
| **Family accounts** | A guarantor (head of household) with linked family members. The family view shows each member's balance, next visit and recall. Family statements go to the guarantor. You can change the guarantor, and new members copy the household's contact details. |
| **Payment plans & autopay** | Weekly, every-two-weeks or monthly installments with a down payment. Shows the installment schedule and tracks past-due amounts, and a plan closes itself when paid off. **Autopay:** the patient saves a card on Stripe's secure page (a link is texted or emailed, or opened at the front desk), and installments are charged automatically when due. Autopay never charges more than the household owes. A declined card creates a task and a note to the patient; after three declines in a row autopay pauses. |
| **Clinical charting** | Interactive tooth chart with five surfaces per tooth (Universal numbering 1–32, primary teeth A–T). Records conditions (caries, missing, crown, RCT, implant and more), planned work and completed work. |
| **Perio charting** | Six probing depths per tooth, with bleeding on probing. Depths of 4mm and 5mm+ are highlighted. A summary shows bleeding %, pocket counts and the change since the last exam. Exam history is kept. |
| **Treatment plans & case acceptance** | Multi-procedure plans with an insurance vs. patient estimate for each line. Estimates apply the PPO fee schedule, deductible, coverage tier and remaining annual maximum. **Present & e-sign:** text or email the patient a plain-language plan with their cost, or hand them a tablet; they accept with a typed name and drawn signature. Plans also print, and can be sent for **pre-authorization**. |
| **Prescriptions & e-prescribing** | One-click favourites for common dental drugs, a preferred pharmacy for each patient, and printed or electronic prescriptions. E-prescribing runs through **DoseSpot** (Surescripts-certified, DEA-audited for controlled substances), opened from the chart with single sign-on. Only the prescriber can sign and send an electronic prescription. Controlled substances follow the DEA rules, with the schedule taken from the drug itself rather than the form: a DEA number, signed by the prescriber's own login with a fresh two-factor code that can't be reused, and no refills on Schedule II. Allergy screening catches drug classes, not just exact names: a codeine allergy flags hydrocodone, and a penicillin allergy flags cephalexin. |
| **Imaging bridges** | A small agent on each operatory PC opens the patient in DEXIS, Sidexis, Carestream, Apteryx, VixWin and similar programs straight from the chart. New x-rays and photos in the program's export folder are filed in the patient's documents automatically, under the patient just opened on that computer. A DICOM patient ID or chart number in the file name (`P123_…`) is used when nothing was opened. If a label disagrees with the open patient, or nothing identifies the patient, the image goes to **To-do → Unfiled images** for someone to file (several at once) rather than being guessed. Offices without imaging software can capture straight from the sensor (Tuxedo, Jazz or any TWAIN sensor — see [docs/imaging-sensors.md](docs/imaging-sensors.md)) in the **imaging studio**: a full-screen light box where the spot for the next exposure glows, a click aims the sensor at another spot, **Retake** replaces an image (the first stays in the chart), and the sensor's status shows live. X-rays open with **Clarity** (auto levels, CLAHE local contrast, noise reduction, sharpening) so any sensor reads well; measurements are in mm from the DICOM spacing, the sensor's pixel size, or a one-time per-sensor calibration. An **intraoral camera** (any USB camera) runs live in the studio and files photos by tooth. The diagnostic viewer also has caries/endo/perio presets, gamma, sharpening, false colour, a magnifier, lengths, canal lengths and angles in mm, keyboard shortcuts and full screen; settings save per image without changing the original. Any spot can be compared with the same spot from earlier visits, mounts print or save as one picture, and each x-ray records its exposure (kVp, mA, time) for the radiation log. |
| **Patient portal** | Patients sign in with a one-time code sent to the email or mobile number on file. A guarantor sees their whole household in one place: balance and online payment, payment plans, upcoming visits (confirm, or cancel more than 24 hours ahead), forms to fill out, treatment plans to review and e-sign, and contact details and reminder preferences. |
| **Clinical notes** | Note templates. Signed notes can't be edited; corrections go in a new note. Signing requires a clinical role. |
| **Ledger & billing** | Completing a procedure posts the charge automatically. Handles payments, adjustments and refunds, shows a running balance, and prints patient statements. |
| **Insurance** | Carriers and primary/secondary policies. Claims are built from completed procedures and move through draft → submitted → paid, partially paid or denied (or void). EOB entry posts the insurance payment and write-off to the ledger, and the deductible met updates automatically. |
| **Clearinghouse connection** | Claims go straight to your clearinghouse over SFTP (DentalXChange, Change Healthcare/Optum, Availity, Vyne, Claim.MD and others). 999 and 277CA acknowledgments, 277 claim status and 835 ERAs are picked up automatically, filed under the right claim and posted. Rejected claims come back to *Ready to send* with the reason. **Check status with payer** (276/277) and eligibility (270/271) run in real time over CAQH CORE. Each claim shows a timeline of its electronic journey. A built-in sandbox clearinghouse lets you demo the whole loop. |
| **Electronic insurance (EDI)** | • **Claims:** sent as ANSI X12 5010 **837D** batches, with checks before sending (NPI, tax ID, payer ID, DOB and so on).<br>• **Eligibility:** **270/271** checks show active coverage, annual maximum and amount remaining, deductible and coverage percentages. Verified benefits can be applied to the policy.<br>• **Remittance:** importing an **835 ERA** posts payments, contractual write-offs and denials to the matching claims automatically, with plain-English reason codes. The same file can't be posted twice. |
| **Two-way texting** | An inbox for patient replies, with unread badges that update live and quick replies. **C** (or yes, ok, sí…) confirms the next day's visits for everyone at that number, **R** asks for a new time (the front desk gets a task), **HELP** answers with the office's name and phone as carriers require, and **STOP**/**START** manage opt-out. Incoming texts are verified with Twilio's signature. |
| **Lab cases & tasks** | Lab cases are tracked by due date, with an alert when the seat appointment is before the case is due back. There's also a team to-do list with priorities, assignees and a patient link. |
| **PPO fee schedules** | Contracted fees per carrier (start from a percentage of office fees, then edit each code). Estimates, claims and EOB entry use them, so write-offs are expected rather than a surprise. |
| **Insurance follow-up** | Outstanding claims aged 0–30 / 31–60 / 61–90 / 90+ days with the payer's phone number, plus a pre-authorization tracker (837D predeterminations, approved/denied answers). |
| **Follow-up lists** | Three call lists, like Dentrix's Continuing Care and Unscheduled lists: **recall** (with a bulk text/email campaign), **unscheduled treatment** (diagnosed work with no appointment, largest value first) and **broken appointments**. Every call is logged with an outcome so the team sees who was reached. |
| **Statements** | Batch statement runs to guarantors over a minimum balance, skipping accounts statemented recently. Statements are emailed with a link to pay in the portal. Accounts without email are printed and mailed by **Lob** (a print-and-mail service), or left for the office to print. Every delivery is recorded. |
| **Practice KPIs** | Production, collections and collection rate, case acceptance, hygiene reappointment, no-show rate, patients current on recall, new patients by referral source and production by provider — each against an industry benchmark. |
| **Reports** | Production and collections by day, provider, category and procedure, A/R aging (0–30 / 31–60 / 61–90 / 90+) and the day sheet. |
| **Reviews & templates** | After a completed visit, patients can get one text asking for a Google review (at most every six months). Reminder, booking, recall and review texts are editable templates with a live preview. |
| **Confirmations & reminders** | • **When a visit is booked or moved** by the office, the patient gets a text or email with the time and a confirm link (untick *Let the patient know* to skip one).<br>• **Reminder schedule:** up to five steps, e.g. the recommended email a week out, a text two days out asking for a yes, and a same-day "see you soon" that confirmed patients get too. A visit booked late gets only the steps still ahead of it.<br>• **Families:** people sharing a phone get one message for everyone's visits that day, and a child's messages go to the parent (guarantor). One link or one "C" confirms them all.<br>• **The link:** confirm, cancel or ask for a new time (the front desk gets a task, with the ASAP list/waitlist count when a slot opens), add to calendar, directions, call. Older links keep working after a newer reminder.<br>• **Email** is HTML with a Confirm button, the calendar invite (.ics) attached and one-click unsubscribe.<br>• **Sending hours** (8 AM–8 PM office time unless changed) apply to reminders, notices, recall and form messages.<br>• **Delivery:** Twilio and SendGrid delivery reports mark landlines, dead numbers and bounced emails on the chart; the reminder is retried by the other channel.<br>• **Missed visits** get a same-day "we missed you" message (can be turned off).<br>• **Follow-up → Unconfirmed:** the call list for the next days, with what was sent and whether it arrived, the last reply, and one click for Confirmed / Left message / Send again, plus the confirmation rate and no-show rates for confirmed vs unconfirmed visits.<br>Staff can also send one-off messages. Every message is logged, and patients can opt out of texts or email. |
| **Finance (bank & QuickBooks)** | • **Bank:** connect the practice's business checking and cards through Plaid (read-only). Lines come in several times a day and are filed under dental cost categories (team wages, doctor pay, supplies, lab, facility, marketing, equipment, office & software, card fees…). Change one and tick "always" to make a rule.<br>• **Deposit matching:** each bank deposit is matched to what the office recorded: deposit slips (cash and checks), insurance EFTs (by trace number) and card or CareCredit payouts (a day's or a weekend's card payments less the processor's cut, which is recorded as a fee). Certain matches happen on their own; the rest are suggested. Money recorded as collected that never reached the bank is listed.<br>• **QuickBooks Online:** the chart of accounts (each expense account mapped to a category) and the monthly profit and loss come in. Optionally, matched deposits go to QuickBooks as deposits (totals only, fees split out).<br>• **Profit & costs:** collections, overhead % against typical ranges, profit, overhead per visit and per chair hour, profit per chair hour, break-even per clinic day, and what reached the bank, month by month. Costs come from QuickBooks when connected, else from the bank.<br>No patient information goes to Plaid or QuickBooks. Admins connect accounts; the *See bank activity, costs and profit* permission lets others view. |
| **AI scribe** | In Clinical notes, start the scribe and talk as you work. It drafts the note in the office's own template, the procedures done (checked against the office's codes, with fees) and chart findings, for the provider to review and save. The conversation itself is never stored. |
| **AI x-ray reading** | Suspected caries, bone loss, calculus, periapical lesions and more outlined on the x-ray, for the dentist to agree with (and chart in one click) or dismiss. Runs on an FDA-cleared vendor (Pearl, Overjet, VideaHealth — partner agreement needed) or on Claude as decision support; new x-rays can be read automatically. |
| **Cancellation fill & confirmation calls** | When a visit is cancelled, the opening is texted to ASAP patients, then the waitlist; the first YES is booked. Unconfirmed patients can get an automated call (press 1 or say yes to confirm, 2 to ask for a new time; voicemail gets a message). |
| **Insurance benefits & EOBs read by AI** | Upload a payer portal page or benefits fax and the plan's maximums, percentages, frequencies, waiting periods, age limits, downgrades and missing tooth clause fill in for staff to check. Upload a paper EOB and the check fills in, matched to your claims line by line. Estimates apply age limits and the missing tooth clause. |
| **Denial scrubber, narratives & appeals** | Before a claim goes out it lists what's likely to be denied: frequency limits, waiting periods, filing deadlines, duplicates, missing teeth or surfaces, codes that need a narrative, and what this payer has denied before. Narratives and appeal letters are drafted from the chart for staff to edit. |
| **PPO profitability** | For each carrier: fees, write-offs, what was kept per chair hour against what an hour costs (from the bank or QuickBooks), fees by code as a % of yours, the raise needed to break even, and what leaving the plan would likely do. |
| **Ask your data & MCP** | Ask questions in plain words ("who owes us the most?") and get answers from the practice's own numbers, limited to what the person may see. An MCP server lets Claude Desktop, Claude Code or other AI apps look things up read-only with a scoped API key. |
| **Phones** | The office line (Twilio) rings the desk and pops the caller's chart on every screen; recorded calls get a transcript and a summary with follow-up tasks; missed callers get a text back; voicemail is transcribed. An **AI receptionist** answers after hours or when nobody picks up: books existing patients, takes new-patient requests, moves or cancels visits, and takes messages. **Call tracking** numbers per marketing source show calls, new patients and production by source. |
| **Mobile check-in** | Patients text HERE or scan the QR poster at the door (mobile number and date of birth); the schedule updates live and "Text we're ready" calls them in from the car. |
| **Reviews** | Google Business Profile reviews in one place; low ratings become a task; AI drafts replies that never confirm the reviewer is a patient; replies post from the app. |
| **Patient financing** | Send CareCredit, Sunbit, Cherry and other lender applications by text; approvals and funding come back by signed lender callbacks (or staff enter them from the portal) and funding posts to the ledger. |
| **Digital lab Rx** | A structured prescription (material, shades, margins, contacts, occlusion, pontic, impression) with scans and x-rays from the chart, sent to the lab as a private link; the lab updates status and tracking, and questions become tasks. |
| **Risk & education** | Caries (CAMBRA) and periodontal risk assessments, started from the chart, with recall intervals, bitewing frequency and home-care recommendations; a patient education library matched to the treatment plan and sent by text or email (the office can edit pages or add its own). |
| **Practice groups** | Several offices under one owner or a DSO: each office's numbers side by side with group totals, and templates, appointment types, message settings and fees copied across. Offices join with a one-time code; the group sees totals, never another office's patients. |
| **Help, onboarding & status** | A getting-started checklist on Today that ticks itself off, searchable help, and a public status page (`/status`) with live checks and background-job health. SOC 2 readiness policies are in [docs/soc2](docs/soc2/README.md). |
| **Online booking** | Each practice gets a mobile-friendly booking page (`/book/<name>`) showing real open times on weekdays, a button for the office's website (`widget.js`), a QR code, and a **Book** button on its Google listing — each tagged so you see where bookings come from. Requests land in the **Online requests** queue. Accepting one matches an existing patient or creates a new one, books the appointment and sends a confirmation. |
| **Digital intake forms** | Staff text or email a single-use link, or open it on a tablet in the office. The patient fills in their medical history and contact details and signs on screen. The answers update the chart's alerts, allergies and medications, and the signed form is kept on the record. |
| **Campaigns** | Text or email a segment of patients: haven't visited in N months, unscheduled treatment, overdue recall, birthdays, no insurance, or everyone (office news). Preview the audience and message first, send now or schedule it. Families sharing a phone get one message, opted-out patients are skipped, texts carry STOP wording and emails a one-click unsubscribe, and nothing goes out outside 9am–8pm. Results show who was reached and who has booked since. |
| **Membership plans** | In-house plans for patients without insurance: a monthly or yearly fee, services included each membership year (cleanings, exams, x-rays) and a discount on other treatment. Fees post on each billing date and are charged to the card on file; a decline marks the membership past due for the office to follow up. Included services and the discount come off automatically as work is completed, treatment plan estimates show member pricing, and a report tracks members, recurring revenue and savings. |
| **Forms & consents** | A form builder for consents, policies and intake (paragraphs, checkboxes, initials, yes/no, pick lists, photos of insurance cards and IDs, signatures), with starter extraction, root canal, sedation, HIPAA and financial-policy forms. Several forms go out as one link. Consents tied to procedure codes are suggested from the treatment plan and filled in with the procedures, teeth and dentist. Forms marked auto-send go out before visits when a patient hasn't signed them (or they've lapsed). Each signed form is filed in the chart as a PDF with the exact wording and version the patient signed. |
| **Documents & X-rays** | Upload images, PDFs and DICOM files to the patient record, tag them by type and tooth, and view or download them. Files are encrypted when stored (AES-256-GCM). |
| **Card payments (text-to-pay)** | Sends the patient a secure Stripe Checkout link. When they pay, the payment posts to the ledger automatically. |
| **Day sheet** | End-of-day close-out: production, payments and the deposit broken down by payment method. Printable. |
| **Single sign-on** | Staff can sign in with their work Google Workspace, Microsoft 365 (Entra ID) or other OpenID Connect account (Okta, Auth0, Keycloak and so on). An optional setting switches off passwords for everyone except administrators. |
| **Admin** | Users and roles, providers (NPI, licence, DEA and schedule colour), operatories, fee schedule, practice details and time zone, a full audit log, and a one-click **export of all practice data** (JSON). |

### Security and HIPAA-related safeguards

Before real patient data goes in, see [docs/HIPAA-vendors.md](docs/HIPAA-vendors.md): which outside services need a Business Associate Agreement, and a go-live checklist. The security risk analysis is in [docs/security/hipaa-risk-assessment.md](docs/security/hipaa-risk-assessment.md), and the brief for an outside penetration test in [docs/security/pentest-scope.md](docs/security/pentest-scope.md).
- **Separate data per practice.** Every query is limited to the signed-in user's practice. Tests confirm one practice can't read another's records.
- **Role-based access.** Roles are `admin`, `dentist`, `hygienist`, `assistant`, `front_desk` and `billing`, each with its own permissions (see `server/src/auth.js`).
- **Audit log.** Records every view of a patient record or chart, every change, every login and every failed login, with user, time and IP.
- **Automatic sign-out.** Staff are signed out after a practice-set idle time (5 minutes to 4 hours, default 15), with a one-minute warning. Activity in any tab counts.
- **Two-factor login.** Staff can use authenticator-app codes (TOTP), and a practice can require them for everyone. Admins can reset 2FA for a staff member who loses their phone.
- **Separate sessions.** Staff and patient-portal sessions use separate token audiences, so neither is accepted in place of the other. Imaging bridges use their own revocable keys, of which only a hash is stored.
- **Single sign-on.** OpenID Connect with PKCE. The ID token's signature is checked against the provider's published keys, Only verified email addresses are accepted, and the sign-in is tied to the browser that started it. Staff are pinned to their identity-provider account after first sign-in. Administrators link theirs deliberately while signed in with a password (**Settings → Single sign-on → Link my account**). The client secret is stored encrypted and never returned by the API.
- **Controlled substances.** Signing needs the prescriber's own login and a fresh two-factor code, and every signature is audited.
- **Patient links.** Confirmation, intake and payment links carry random tokens; only a hash of each token is stored. Intake links are single-use and expire after 14 days. Public endpoints are rate-limited, and the booking form has a hidden field to catch bots.
- **Passwords and sessions.** Passwords are hashed with scrypt (minimum 10 characters). Sessions use HMAC-signed tokens that expire after 12 hours. Logins are rate-limited.
- **HTTP protections.** API responses carry `Cache-Control: no-store`, HSTS, `X-Frame-Options: DENY` and `nosniff`.

> Running this software is not by itself HIPAA compliance. Before you store real patient data you still need: a Business Associate Agreement (BAA) with your hosting provider, TLS termination, an encrypted and backed-up database volume, and your own policies and risk assessment.

## Tech stack
- **Server:** Node.js 22+ and Express 5. The database is **PostgreSQL** (recommended for production) or **SQLite** through Node's built-in `node:sqlite` (zero setup, single server). The same code runs on both, and every test runs on both.
- **Scale-out:** several API servers behind a load balancer share live updates, rate limits and background-job locks through **Redis**. Documents can live in S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO), encrypted before upload.
- **Client:** React 19, React Router and Vite, with no UI framework dependencies
- **Tests:** `node:test` integration tests that exercise the real HTTP API, plus an end-to-end browser test of the core day (Playwright, its own server on a fresh database). Some tests run real subprocesses: two API servers sharing one Redis, the imaging-bridge agent, and an SFTP server. Others use fake Stripe and OpenID Connect endpoints. CI runs the whole suite on SQLite and on PostgreSQL.

## Getting started

```bash
npm install
npm run seed      # optional: loads a demo practice with 40 patients
npm run dev       # API on :4000, web app on http://localhost:5173
```

Demo login: `admin@demo.dentalmachine.app` / `demo-password-123`. The seed script also creates `dr.chen@`, `sam@` (hygienist), `frontdesk@` and `billing@` accounts under `demo.dentalmachine.app`, all with the same password, so you can try each role.

To start from scratch, open the app and click **Create an account**. This creates a new practice with a starter fee schedule and three operatories.

```bash
npm test          # API integration tests (SQLite)
TEST_DATABASE_URL=postgres://localhost/dm_test TEST_REDIS_URL=redis://localhost:6379 npm test   # also on PostgreSQL + Redis
npm run build && npm run e2e   # end-to-end in a real browser (Playwright): new patient → insurance → book → check in → chart → check out → claim → ERA → statement
npm run loadtest               # 50,000 patients with years of history; times every main screen and report (--patients N; DATABASE_URL=… for a scratch Postgres)
npm run build     # production build of the web app
```

To try every integration without any accounts, set `EDI_MODE=sandbox ERX=sandbox PAYMENTS=sandbox MAIL_DRIVER=log` before `npm run dev`. That gives you a simulated clearinghouse and payer, pharmacy network, card processor and mail service. **Settings → Integrations** shows what is connected.

## Deploying

### Try it in five minutes (Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ryansmithdds1/dentalmachine)

The button uses `render.yaml`. It creates the app and a Postgres database, loads the demo practice, and runs every integration in sandbox mode (nothing reaches real payers, pharmacies, card processors or patients). Sign in as `admin@demo.dentalmachine.app` / `demo-password-123`. On the free plan the app sleeps when idle, and uploaded files don't survive a restart.

### Your own server

The Docker image serves both the API and the web app on one port. For a **single server** with SQLite:

```bash
docker build -t dentalmachine .
docker run -p 4000:4000 -e JWT_SECRET="$(openssl rand -hex 48)" -v dm-data:/data dentalmachine
```

For **production**, use PostgreSQL, Redis and several app servers (`docker-compose.yml` has this set up):

```bash
JWT_SECRET=... DOCUMENT_ENCRYPTION_KEY=... docker compose up --build --scale app=2
```

| Platform setting | Environment variables |
| --- | --- |
| PostgreSQL | `DATABASE_URL=postgres://…` (tables are created and migrated on start; `PG_POOL_SIZE`, default 10) |
| Several servers | `REDIS_URL` (and optionally `REDIS_PREFIX`). Reminders, clearinghouse polling and autopay then run on one server at a time automatically. |
| Shared document storage | `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, plus `S3_ENDPOINT` for R2/B2/MinIO. Required when you run more than one server. |

### Integrations (all optional)

| Feature | Environment variables |
| --- | --- |
| Links in texts and emails | `APP_URL`: the public web address, e.g. `https://app.yourpractice.com` |
| Who can create a practice | `REGISTRATION=invite` (the default in production): a practice is created only from an invitation link, made with `npm run invite -- [email] [--days 14] [--note "…"]` (`npm run invite -- --list` shows them). Each link works once; with an email, only that address can use it. `REGISTRATION=open` lets anyone sign up. |
| Proxies | `TRUST_PROXY`: which proxies' `X-Forwarded-For` to believe for client addresses (rate limits, audit log). Defaults to one hop on Vercel, otherwise proxies on a private network. |
| Text messages (Twilio) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |
| Email (SendGrid) | `SENDGRID_API_KEY`, `EMAIL_FROM` (optional `EMAIL_FROM_NAME`) |
| Card payments (Stripe) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. In Stripe, point a webhook at `https://<your host>/api/webhooks/stripe` for the `checkout.session.completed` and `checkout.session.expired` events. |
| Document encryption | `DOCUMENT_ENCRYPTION_KEY`: a long random string. Keep it safe; encrypted files can't be read without it. |
| Document storage location | `UPLOAD_DIR` (default `./data/uploads`) |
| Reminder job | Runs every 10 minutes (`REMINDERS=off` disables it). With Redis, only one server sends each batch. |
| Incoming texts | Set `TWILIO_AUTH_TOKEN` and point your Twilio number's *A message comes in* webhook at `https://<your host>/api/webhooks/twilio/sms`. Enter the number under Settings → Practice. |
| Bank (Plaid) | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (`sandbox` or `production`). `PLAID=sandbox` simulates a bank for demos. New lines arrive by Plaid's webhook (`/api/webhooks/plaid`, when `APP_URL` is https) and every 4 hours (`FINANCE_SYNC=off` disables). |
| QuickBooks Online | `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENV` (`sandbox` or `production`). Add `https://<your host>/api/finance/quickbooks/callback` as a redirect URI in the Intuit app. `QBO=sandbox` simulates a company for demos. |
| Delivery reports | Texts: automatic when `APP_URL` is https (each text asks Twilio to report to `/api/webhooks/twilio/status`). Email: in SendGrid turn on the signed Event Webhook pointing at `https://<your host>/api/webhooks/sendgrid` and set `SENDGRID_WEBHOOK_KEY` to its verification key. |
| Clearinghouse | `CLEARINGHOUSE=sftp` with `CH_SFTP_HOST`, `CH_SFTP_USERNAME`, `CH_SFTP_PASSWORD` or `CH_SFTP_PRIVATE_KEY`, and `CH_SFTP_UPLOAD_DIR` / `CH_SFTP_DOWNLOAD_DIR` / `CH_SFTP_ARCHIVE_DIR`. These values come from your clearinghouse's SFTP enrolment. Responses are checked every `CH_POLL_MINUTES` (default 15). For real-time eligibility and claim status, set `CH_REALTIME_URL`, `CH_REALTIME_USERNAME` and `CH_REALTIME_PASSWORD` (the clearinghouse's CAQH CORE endpoint). `EDI_SUBMITTER_ID` and `EDI_RECEIVER_ID` also come from enrolment. `CLEARINGHOUSE=manual` (the default) downloads files for you to upload; `sandbox` simulates the clearinghouse and payer. |
| E-prescribing | `ERX=dosespot` with `ERX_DOSESPOT_CLINIC_ID` and `ERX_DOSESPOT_CLINIC_KEY` from DoseSpot, and optionally `ERX_DOSESPOT_URL` for production. Put each prescriber's DoseSpot user ID under Settings → Providers. DoseSpot handles prescriber identity proofing and EPCS enrolment. `ERX=sandbox` simulates a pharmacy network. |
| Card-on-file autopay | Uses the Stripe keys above. Also subscribe the Stripe webhook to `checkout.session.completed` for setup-mode sessions (saved cards). `PAYMENTS=sandbox` gives test cards without Stripe; `AUTOPAY=off` disables the hourly job. |
| Mailed statements | `MAIL_DRIVER=lob` and `LOB_API_KEY` (`test_` keys never mail anything). `MAIL_DRIVER=log` records letters without sending them. |
| Single sign-on | Set up per practice in **Settings → Practice**. Register `https://<your host>/api/auth/sso/callback` as the redirect URI with your identity provider. |
| Imaging bridges | Set up per workstation in **Settings → Imaging bridges** (see below). |
| Claim attachments | `ATTACHMENTS=http` with `ATTACHMENTS_URL` and `ATTACHMENTS_API_KEY` sends attachments to your attachment service (NEA/Vyne, DentalXChange, or a bridge to one), which returns the control number the claim references (PWK). `sandbox` simulates it (the default with `EDI_MODE=sandbox`); `manual` numbers them for a printed mail/fax cover sheet. |
| Automatic backups | `BACKUP_DIR` (a mounted disk or synced folder) turns on nightly backups of every practice, kept `BACKUP_KEEP` days (default 14). SQLite installs also get a copy of the database file. Documents are included when they're stored on the server's disk; `BACKUP_DOCUMENTS=on` or `off` overrides that. |
| Error monitoring and logs | `SENTRY_DSN` sends unexpected server errors, failed background jobs and browser errors to Sentry or any service that accepts its format (GlitchTip, Bugsink). `SENTRY_ENVIRONMENT` labels them. Reports carry the error, stack, route and request id, never request bodies or patient details. Logs are one line per event: JSON in production (`LOG_FORMAT=json` or `text`), with `LOG_LEVEL` (`debug`, `info`, `warn`, `error`). Every response has an `X-Request-Id`, and a 500 error shows it so staff can quote it. |

| Phone line & AI receptionist | Point your Twilio number's *A call comes in* webhook at `https://<your host>/api/webhooks/twilio/voice/inbound` and its status callback at `/api/webhooks/twilio/call-status`; set the desk phone and when the AI answers in Settings → Phone line. `TWILIO_ACCOUNT_SID` is needed to fetch recordings. Transcripts: `TRANSCRIBE=deepgram` with `DEEPGRAM_API_KEY` (or `sandbox`). |
| AI features | `ANTHROPIC_API_KEY` turns on the assistant, scribe, benefit and EOB reading, claim narratives and appeals, Ask your data, the AI receptionist, call summaries and review replies. X-ray reading: `XRAY_AI=vendor` with `XRAY_AI_URL`, `XRAY_AI_KEY`, `XRAY_AI_NAME`, or `XRAY_AI=claude` / `sandbox`. |
| Google reviews & Book button | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (an OAuth client with the Business Profile APIs; redirect URI `https://<your host>/api/reputation/google/callback`). `GOOGLE_BUSINESS=sandbox` for demos. Synced every 2 hours. |
| Financing lenders | Add each lender's application link in Settings → Practice → Financing. For lender callbacks, give the lender `https://<your host>/api/webhooks/financing/<lender>` and set `<LENDER>_WEBHOOK_SECRET` (HMAC-SHA256 of the body in `X-Signature`). |
| MCP server | `https://<your host>/api/mcp` (Streamable HTTP, JSON-RPC) with an API key from Settings → API & webhooks as a Bearer token; each tool needs its scope on the key. |

Without Twilio or SendGrid configured, messages are recorded in the log but not actually sent. **Settings → Integrations** shows which integrations are connected.

### Switching from another system

In **Settings → Import from another system**, upload an **Open Dental database backup** (the `.sql` dump is read in the browser; only the tables and columns needed are sent) for a full conversion — providers, operatories, patients and families, insurance plans and policies, appointments, treatment, recall, the ledger, claims and payments, notes, communications and perio — or bring in CSV exports from Open Dental, Dentrix, Eaglesoft, Curve or any spreadsheet. Import patients first (with families and, optionally, balances), then insurance, balances, appointments, recalls and treatment. Columns are matched by name and can be changed, and a dry run shows what the first rows would do before anything is saved. Each record remembers its ID in the old system, so importing a corrected file again updates what's there instead of duplicating it. An import can be undone until its records have been used. Balances come over as a single "balance forward" adjustment, and procedure history is imported without posting charges.

### Backups and restore

**Settings → Backups** downloads a practice backup (optionally with documents and x-rays) and runs a test restore that proves the backup comes back whole without changing anything. From the command line:

```bash
node src/backupcli.js export <practice id> backup.json.gz [--documents]
node src/backupcli.js restore backup.json.gz          # onto a new server
node src/backupcli.js restore backup.json.gz --copy   # beside the original, as a separate practice
```

A restore creates a new practice with every ID remapped, so the same file works for disaster recovery and moving servers. On Postgres, also turn on your provider's daily backups and point-in-time recovery (Supabase, Neon, RDS and Render all offer them).

### Changing encryption keys

Documents and x-rays are sealed with `DOCUMENT_ENCRYPTION_KEY`; staff 2FA keys and SSO client secrets with `JWT_SECRET`; backups with `BACKUP_ENCRYPTION_KEY`. To change one (on a schedule, or because it may have leaked):

1. Set the new value, and put the old one in `DOCUMENT_ENCRYPTION_KEY_PREVIOUS`, `JWT_SECRET_PREVIOUS` or `BACKUP_ENCRYPTION_KEY_PREVIOUS` (comma-separated if there are several). Restart. Everything keeps working, and new files use the new key.
2. Run `npm run rotate-keys`. It re-encrypts every file and re-seals every stored secret under the new keys (and encrypts files saved before encryption was turned on). It is safe to run again.
3. When it reports nothing left on old keys, remove `DOCUMENT_ENCRYPTION_KEY_PREVIOUS` and `JWT_SECRET_PREVIOUS`. Keep `BACKUP_ENCRYPTION_KEY_PREVIOUS` until the old backups age out (`BACKUP_KEEP` days) or you no longer need them.

Changing `JWT_SECRET` signs everyone out once.

### Assistant (voice and text)

Staff can say or type what they want from any screen. **Hold F2** (or a foot pedal set to send it), speak, and let go: "book Ryan Smith for a crown prep with Dr. Lee next Tuesday afternoon", "take a $120 card payment", "note: patient reports cold sensitivity on 19", "plan an MOD composite on 30", "chart a missing 1 and 16", "perio on 3: buccal 3 2 4, bleeding on the mesial", or "check her in and seat her". It acts as the signed-in user through the normal API, so permissions, office restrictions, validation and the audit log apply as usual.

- **Fast by design.** Moving around ("open her x-rays", "schedule tomorrow", "start perio") happens instantly in the browser without the AI. Everything else goes to Claude with the patient on screen, their upcoming visits and planned treatment already attached, and look-ups run on the server in the same request — most requests come back in 2–4 seconds.
- **Confirm with one tap.** Changes show as a card: tap F2 (or say "yes") to do it, Esc (or "no") to drop it. Low-risk changes — check-in, seating, confirming, perio readings — happen at once with **Undo**. Say "undo" or click Undo on the toast to take back the last change (payments are voided, bookings cancelled, statuses and perio readings restored).
- **Quiet.** A chime and a line on screen instead of a voice; "read aloud" is an option in the assistant's settings, along with the talk key and **this computer's chair** — set it and "seat her" or "complete the filling" means whoever is in that chair.
- **Phrase log.** Admins see what was said, how long it took and whether it was confirmed, cancelled or undone under Settings → Assistant, to find what to tune.
- Turn it on with `ANTHROPIC_API_KEY` (an Anthropic API key). Optional: `ASSISTANT_MODEL` (default `claude-opus-5-5`), `ASSISTANT_EFFORT` (`low` (default), `medium` or `high` — lower is faster and cheaper), `ASSISTANT=off`.
- **HIPAA:** what staff say and what the assistant looks up goes to Anthropic, so sign Anthropic's BAA before using it with real patients. Voice input uses the browser's speech recognition, which in Chrome may send audio to Google unless it runs on the device; see [docs/HIPAA-vendors.md](docs/HIPAA-vendors.md).
- Replies are read aloud after spoken requests (toggle in the panel).

### Imaging bridge (operatory PCs)

1. In **Settings → Imaging bridges**, add the workstation and download its `bridge-config.json`. The key is shown only once.
2. On that PC, install Node.js 18 or newer. Save `bridge/dental-machine-bridge.mjs` (also downloadable from that page) next to the config file.
3. In the config file, set your imaging program's path and command-line options (your imaging vendor's bridge guide lists them), and the export folders to watch. See `bridge/bridge-config.example.json`. Programs that read the patient from a file are supported through `writeFile`.
4. Run `node dental-machine-bridge.mjs bridge-config.json`, for example as a startup task.
5. Optional, for **direct sensor capture** without imaging software: add a `sensor` section. For Tuxedo and Jazz sensors, `"sensor": { "preset": "tuxedo" }` (or `"jazz"`) is enough once the sensor's TWAIN driver and NAPS2 are installed — step-by-step in [docs/imaging-sensors.md](docs/imaging-sensors.md); **Test sensor** in Settings checks it with one exposure. Otherwise: In `"mode": "command"` the bridge runs an acquire command once per exposure that saves the image to `{output}`. For TWAIN or WIA sensors, the free NAPS2 console does this (`NAPS2.Console.exe -o {output} --driver twain --device "<sensor name>"`); `scanimage` works on Linux, or use your sensor vendor's command-line tool. In `"mode": "folder"` it picks up whatever the sensor driver saves to a folder while a capture is running. The chart then shows **Capture from <sensor>** on that workstation.

It runs on any container host (Fly.io, Render, Railway, AWS ECS, Google Cloud Run with a mounted volume, and so on). Put it behind HTTPS and keep `/data` on persistent, encrypted storage with backups. See `.env.example` for the configuration options.

## Public API and webhooks

Admins create API keys (with only the access they need) and webhook endpoints in **Settings → API & webhooks**.

```
GET  /api/v1/me                      GET  /api/v1/providers | operatories | appointment-types
GET  /api/v1/patients                ?updated_since, ?email, ?phone, ?limit, ?starting_after
GET  /api/v1/patients/:id            POST /api/v1/patients     PATCH /api/v1/patients/:id
GET  /api/v1/availability            ?date=YYYY-MM-DD&provider_id&duration
GET  /api/v1/appointments            ?from&to&patient_id&status   GET /api/v1/appointments/:id
POST /api/v1/appointments            POST /api/v1/appointments/:id/confirm | /cancel
GET  /api/v1/payments                ?since=YYYY-MM-DD
```

Send `Authorization: Bearer dm_live_…`. Lists return `{ data, has_more }`. Webhook events (`appointment.created`, `appointment.updated`, `appointment.cancelled`, `patient.created`, `patient.updated`, `payment.created`) are POSTed as `{ id, type, created, data: { object } }` with a `DM-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">` header, and retried with backoff for about a day.

## API overview

All endpoints are under `/api` and need `Authorization: Bearer <token>`, except the `/auth/*` endpoints. Money values are integer **cents**. Appointment times are wall-clock times in the practice's time zone, written as `YYYY-MM-DD HH:MM`.

| Resource | Endpoints |
| --- | --- |
| Auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/me`, `POST /auth/change-password` |
| Patients | `GET/POST /patients`, `GET/PUT/DELETE /patients/:id` |
| Schedule | `GET/POST /appointments`, `GET/PUT /appointments/:id`, `PATCH /appointments/:id/status`, `GET /availability`, `GET /recalls`, `PUT /recalls/:id` |
| Clinical | `GET /patients/:id/chart`, `POST /patients/:id/conditions`, `PUT /conditions/:id`, `GET/POST /patients/:id/procedures`, `PUT /procedures/:id`, `POST /procedures/:id/complete\|cancel`, `GET/POST /patients/:id/treatment-plans`, `PUT /treatment-plans/:id`, `GET/POST /patients/:id/notes`, `PUT /notes/:id`, `POST /notes/:id/sign`, `GET/POST /patients/:id/perio` |
| Billing | `GET /patients/:id/ledger`, `POST /patients/:id/payments\|adjustments\|refunds`, `GET /patients/:id/statement` |
| Insurance | `GET/POST /carriers`, `PUT /carriers/:id`, `GET/POST /patients/:id/insurance`, `PUT /insurance/:id`, `GET/POST /claims`, `GET /claims/:id`, `POST /claims/:id/submit\|deny\|void\|payment`, `GET /patients/:id/unclaimed-procedures`, `POST /patients/:id/estimate` |
| Settings | `GET/PUT /practice`, `GET/POST/PUT /users`, `/providers`, `/operatories`, `/procedure-codes`, `GET /audit-log` |
| Reports | `GET /dashboard`, `GET /reports/production`, `GET /reports/aging`, `GET /reports/daysheet` |
| Calendar | `GET /schedule?from&to` (appointments, blocked time, hours and production in one call), `GET/POST/PUT/DELETE /blockouts`, `GET /asap`, `GET /events` (live updates stream), `GET/POST/PUT /appointment-types` |
| Family & plans | `GET/POST /patients/:id/family`, `DELETE /patients/:id/family/:memberId`, `POST /patients/:id/family/guarantor`, `GET/POST /patients/:id/payment-plans`, `GET /payment-plans`, `PUT /payment-plans/:id` |
| EDI | `POST /claims/837`, `GET /claims/:id/validate`, `POST /insurance/:id/eligibility`, `GET /eligibility/:id/270`, `POST /eligibility/:id/response\|apply`, `GET /patients/:id/eligibility`, `POST /era/import`, `GET /era` |
| Texting | `GET /conversations`, `GET /conversations/unread`, `GET /patients/:id/conversation`, `POST /patients/:id/conversation/read`, `POST /webhooks/twilio/sms` and `/webhooks/twilio/status` (signed by Twilio), `POST /webhooks/sendgrid` (signed by SendGrid) |
| Finance | `GET /finance/status`, `GET /finance/overview?months=`, `POST /finance/plaid/link-token\|exchange`, `POST /finance/bank/sync`, `GET/PUT /finance/bank/transactions`, `GET /finance/matching`, `POST /finance/matching/auto`, `POST/DELETE /finance/bank/transactions/:id/match`, `GET /finance/quickbooks/connect`, `POST /finance/quickbooks/sync\|push`, `PUT /finance/quickbooks/settings`, `PUT /finance/quickbooks/accounts/:id` |
| Confirmations | `GET /followups/unconfirmed?days=`, `GET /followups/confirmation-stats?from=&to=` |
| Office | `GET/POST/PUT /lab-cases`, `GET/POST/PUT /tasks` |
| Engagement | `GET /messages`, `POST /patients/:id/messages`, `POST /appointments/:id/remind`, `POST /recalls/:id/remind`, `GET /booking-requests`, `POST /booking-requests/:id/accept\|decline`, `POST /patients/:id/form-requests`, `GET /patients/:id/forms`, `GET/POST/PUT /form-templates`, `POST /patients/:id/form-packets`, `GET /patients/:id/consents/suggest` |
| Documents | `GET/POST /patients/:id/documents`, `GET /documents/:id/file`, `DELETE /documents/:id` |
| Payments | `GET /payments/config`, `GET/POST /patients/:id/payment-requests`, `POST /webhooks/stripe` (signed by Stripe) |
| 2FA | `POST /auth/mfa/setup\|enable\|disable` |
| Front desk | `GET /huddle?date`, `GET /appointments/:id/route-slip`, `GET /followups/unscheduled`, `GET /followups/broken`, `GET/POST /patients/:id/followups`, `POST /patients/:id/medical-reviewed`, `GET /search?q` |
| PPO & pre-auth | `GET/POST /fee-schedules`, `PUT /fee-schedules/:id`, `GET/POST /preauths`, `PUT /preauths/:id`, `POST /preauths/:id/837`, `GET /reports/outstanding-claims` |
| Case acceptance & Rx | `GET /treatment-plans/:id`, `POST /treatment-plans/:id/present`, `GET /rx/favorites`, `GET/POST /patients/:id/prescriptions`, `GET /prescriptions/:id` |
| Growth | `GET /analytics?from&to`, `GET /statements/candidates`, `POST /statements/run`, `GET /statements/runs`, `POST /recalls/campaign`, `GET /message-templates/defaults`, `GET /export` |
| Scheduling extras | `POST /appointments` with `repeat: { every, unit: 'week'\|'month', count }`, `PUT /appointments/:id` and `PATCH /appointments/:id/status` with `scope: 'following'`; providers accept `working_hours` |
| Clearinghouse | `POST /claims/submit`, `GET /clearinghouse`, `POST /clearinghouse/poll`, `POST /clearinghouse/responses`, `POST /claims/:id/status-check`, `GET /claims/:id/events` |
| E-prescribing | `GET /erx`, `GET /pharmacies`, `PUT /patients/:id/pharmacy`, `GET /erx/launch`, `POST /patients/:id/prescriptions` with `send`, `schedule` and `otp` |
| Assistant | `GET /assistant` (on or off, and its tools), `POST /assistant/turn` (one step: look-ups run on the server; changes come back for the browser to make), `POST /assistant/log/:id`, `GET /assistant/log` (admins). |
| Imaging | `GET/POST /imaging/agents`, `DELETE /imaging/agents/:id`, `POST /patients/:id/imaging/launch`, `POST /patients/:id/imaging/capture` (optional `slot`, `retake`), `GET /imaging/commands/:id`, `PUT /imaging/commands/:id/target`, `POST /imaging/commands/:id/stop`, `POST /imaging/agents/:id/test-sensor`, `GET /imaging/commands/:id/test-image`, `PUT /documents/:id/adjust`, `GET /imaging/agent-download`. The agent itself uses `/api/bridge/hello\|commands\|captures\|images` and `/api/bridge/commands/:id/progress\|test-image` with its own key. |
| Cards & autopay | `GET/POST /patients/:id/payment-methods`, `POST /patients/:id/card-setup`, `DELETE /payment-methods/:id`, `POST /payment-plans/:id/charge-now`; `PUT /payment-plans/:id` accepts `autopay_method_id` |
| Portal (patient session) | `/api/public/portal/:practice/code\|verify`, then `/api/portal/me`, `/contact`, `/appointments/:id/confirm\|cancel`, `/forms/:id/open`, `/treatment-plans/:id/open`, `/pay` |
| Sign-on & system | `GET /auth/sso/lookup\|start\|callback`, `GET/PUT /practice/sso`, `GET /integrations` |
| Public (no login) | `GET /public/practices/:slug`, `GET /public/practices/:slug/availability`, `POST /public/practices/:slug/booking-requests`, `GET/POST /public/confirm/:token` (confirm, cancel, reschedule), `GET /public/confirm/:token/calendar.ics`, `GET/POST /public/confirm/:token/stop-emails`, `GET/POST /public/forms/:token`, `POST /public/forms/:token/:id`, `GET/POST /public/tp/:token` |

## Roadmap ideas
- Direct REST integrations with individual clearinghouses and payers that don't offer SFTP or CAQH CORE
- A second e-prescribing partner (DrFirst, Veradigm) behind the same interface as DoseSpot
- A Windows installer and auto-update for the imaging bridge (sensor capture runs through the bridge, not the browser itself)
- Read replicas and reporting on a separate database for large groups

Before going live, some work sits outside the code: a BAA with your hosting provider, clearinghouse and payer enrolment (EDI, ERA and EFT), DoseSpot onboarding including EPCS identity proofing for each prescriber, a Stripe account, and a Lob account for mailing.

The CDT codes in the starter fee schedule are for convenience only. Practices need their own ADA CDT licence and should set fees for their market.
