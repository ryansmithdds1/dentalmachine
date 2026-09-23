# Dental Machine

Cloud practice management software for dental offices: scheduling, patient records, clinical charting, treatment planning, billing, insurance claims and reporting. Several practices can share one deployment, and each practice's data is kept separate.

## Features

| Area | What it does |
| --- | --- |
| **Scheduling** | A fast calendar with day view (by chair or by provider), week view, and a list view that phones use automatically.<br>• **Mouse:** drag an appointment to move it, including to another chair, provider or day. Drag its bottom edge to change its length, or drag across empty time to book or block it.<br>• **Phone:** tap *Move*, then tap the new time.<br>• **Speed:** changes show instantly, roll back if the server rejects them, and every move has Undo. Every open screen updates live, including when a patient confirms by text or link. Neighbouring days are loaded in the background so moving between dates is instant.<br>• **On the grid:** office hours, blocked time (lunch, meetings, holidays; can repeat weekly), a current-time line, appointment types with colours and preset procedures, scheduled production against the daily goal, confirmation status, medical-alert flags and an ASAP list.<br>• **Rules:** no double-booking of a provider, chair or patient. Booking into blocked time asks for confirmation. Keyboard shortcuts: ←/→ change day, T today, D/W/A switch view, N new appointment. |
| **Patients** | Demographics, medical alerts, allergies and medications. Search by name, phone, email, DOB or ID. Patients are archived rather than deleted, so records are kept. |
| **Family accounts** | A guarantor (head of household) with linked family members. The family view shows each member's balance, next visit and recall. Family statements go to the guarantor. You can change the guarantor, and new members copy the household's contact details. |
| **Payment plans** | Weekly, every-two-weeks or monthly installments with a down payment. Shows the installment schedule and tracks past-due amounts. Payments can be applied to a plan, which closes itself when paid off. A practice-wide list shows plans that are past due. |
| **Clinical charting** | Interactive tooth chart with five surfaces per tooth (Universal numbering 1–32, primary teeth A–T). Records conditions (caries, missing, crown, RCT, implant and more), planned work and completed work. |
| **Perio charting** | Six probing depths per tooth, with bleeding on probing. Depths of 4mm and 5mm+ are highlighted. Exam history is kept. |
| **Treatment plans** | Multi-procedure plans with an insurance vs. patient estimate for each line. Estimates apply the deductible, coverage tier and remaining annual maximum. Plans can be marked accepted or declined, and close automatically when all work is done. |
| **Clinical notes** | Note templates. Signed notes can't be edited; corrections go in a new note. Signing requires a clinical role. |
| **Ledger & billing** | Completing a procedure posts the charge automatically. Handles payments, adjustments and refunds, shows a running balance, and prints patient statements. |
| **Insurance** | Carriers and primary/secondary policies. Claims are built from completed procedures and move through draft → submitted → paid, partially paid or denied (or void). EOB entry posts the insurance payment and write-off to the ledger, and the deductible met updates automatically. |
| **Electronic insurance (EDI)** | • **Claims:** sent as ANSI X12 5010 **837D** batches, with checks before sending (NPI, tax ID, payer ID, DOB and so on).<br>• **Eligibility:** **270/271** checks show active coverage, annual maximum and amount remaining, deductible and coverage percentages. Verified benefits can be applied to the policy.<br>• **Remittance:** importing an **835 ERA** posts payments, contractual write-offs and denials to the matching claims automatically, with plain-English reason codes. The same file can't be posted twice. |
| **Two-way texting** | An inbox for patient replies, with unread badges that update live and quick replies. **C** confirms the next appointment, **STOP**/**START** manage opt-out. Incoming texts are verified with Twilio's signature. |
| **Lab cases & tasks** | Lab cases are tracked by due date, with an alert when the seat appointment is before the case is due back. There's also a team to-do list with priorities, assignees and a patient link. |
| **Recall** | Completing a prophy or perio maintenance sets the next recall due date. The recall list tracks who has been contacted. |
| **Reports** | Dashboard, production and collections by day, provider, category and procedure, and A/R aging (0–30 / 31–60 / 61–90 / 90+). |
| **Reminders & messaging** | Texts or emails reminders automatically (24, 48 or 72 hours ahead). Each reminder has a link the patient taps to confirm or cancel, which updates the schedule. Staff can also send one-off messages and recall reminders. Every message is logged, and patients can opt out of texts or email. |
| **Online booking** | Each practice gets a mobile-friendly booking page (`/book/<name>`) showing real open times on weekdays. Requests land in the **Online requests** queue. Accepting one matches an existing patient or creates a new one, books the appointment and sends a confirmation. |
| **Digital intake forms** | Staff text or email a single-use link, or open it on a tablet in the office. The patient fills in their medical history and contact details and signs on screen. The answers update the chart's alerts, allergies and medications, and the signed form is kept on the record. |
| **Documents & X-rays** | Upload images, PDFs and DICOM files to the patient record, tag them by type and tooth, and view or download them. Files are encrypted when stored (AES-256-GCM). |
| **Card payments (text-to-pay)** | Sends the patient a secure Stripe Checkout link. When they pay, the payment posts to the ledger automatically. |
| **Day sheet** | End-of-day close-out: production, payments and the deposit broken down by payment method. Printable. |
| **Admin** | Users and roles, providers (NPI and schedule colour), operatories, fee schedule, practice details and time zone, and a full audit log. |

### Security and HIPAA-related safeguards
- **Separate data per practice.** Every query is limited to the signed-in user's practice. Tests confirm one practice can't read another's records.
- **Role-based access.** Roles are `admin`, `dentist`, `hygienist`, `assistant`, `front_desk` and `billing`, each with its own permissions (see `server/src/auth.js`).
- **Audit log.** Records every view of a patient record or chart, every change, every login and every failed login, with user, time and IP.
- **Two-factor login.** Staff can use authenticator-app codes (TOTP), and a practice can require them for everyone. Admins can reset 2FA for a staff member who loses their phone.
- **Patient links.** Confirmation, intake and payment links carry random tokens; only a hash of each token is stored. Intake links are single-use and expire after 14 days. Public endpoints are rate-limited, and the booking form has a hidden field to catch bots.
- **Passwords and sessions.** Passwords are hashed with scrypt (minimum 10 characters). Sessions use HMAC-signed tokens that expire after 12 hours. Logins are rate-limited.
- **HTTP protections.** API responses carry `Cache-Control: no-store`, HSTS, `X-Frame-Options: DENY` and `nosniff`.

> Running this software is not by itself HIPAA compliance. Before you store real patient data you still need: a Business Associate Agreement (BAA) with your hosting provider, TLS termination, an encrypted and backed-up database volume, and your own policies and risk assessment.

## Tech stack
- **Server:** Node.js 22+, Express 5, SQLite through Node's built-in `node:sqlite` (no native modules to compile)
- **Client:** React 19, React Router and Vite, with no UI framework dependencies
- **Tests:** `node:test` integration tests that exercise the real HTTP API

## Getting started

```bash
npm install
npm run seed      # optional: loads a demo practice with 40 patients
npm run dev       # API on :4000, web app on http://localhost:5173
```

Demo login: `admin@demo.dentalmachine.app` / `demo-password-123`. The seed script also creates `dr.chen@`, `sam@` (hygienist), `frontdesk@` and `billing@` accounts under `demo.dentalmachine.app`, all with the same password, so you can try each role.

To start from scratch, open the app and click **Create an account**. This creates a new practice with a starter fee schedule and three operatories.

```bash
npm test          # API integration tests
npm run build     # production build of the web app
```

## Deploying

The Docker image serves both the API and the web app on one port:

```bash
docker build -t dentalmachine .
docker run -p 4000:4000 -e JWT_SECRET="$(openssl rand -hex 48)" -v dm-data:/data dentalmachine
```

### Integrations (all optional)

| Feature | Environment variables |
| --- | --- |
| Links in texts and emails | `APP_URL`: the public web address, e.g. `https://app.yourpractice.com` |
| Text messages (Twilio) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |
| Email (SendGrid) | `SENDGRID_API_KEY`, `EMAIL_FROM` |
| Card payments (Stripe) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. In Stripe, point a webhook at `https://<your host>/api/webhooks/stripe` for the `checkout.session.completed` and `checkout.session.expired` events. |
| Document encryption | `DOCUMENT_ENCRYPTION_KEY`: a long random string. Keep it safe; encrypted files can't be read without it. |
| Document storage location | `UPLOAD_DIR` (default `./data/uploads`) |
| Reminder job | Runs every 10 minutes. Set `REMINDERS=off` on every server except one if you run more than one. |
| Incoming texts | Set `TWILIO_AUTH_TOKEN` and point your Twilio number's *A message comes in* webhook at `https://<your host>/api/webhooks/twilio/sms`. Enter the number under Settings → Practice. |
| Electronic insurance (EDI) | `EDI_MODE=manual` (the default): claim and eligibility files are generated for you to upload to your clearinghouse portal, and you import the responses (271/835). `EDI_MODE=sandbox`: simulated eligibility responses for demos and training. Optional `EDI_SUBMITTER_ID` and `EDI_RECEIVER_ID` come from your clearinghouse enrolment. |

Without Twilio or SendGrid configured, messages are recorded in the log but not actually sent. The **Settings → Practice** page shows which integrations are connected.

It runs on any container host (Fly.io, Render, Railway, AWS ECS, Google Cloud Run with a mounted volume, and so on). Put it behind HTTPS and keep `/data` on persistent, encrypted storage with backups. See `.env.example` for the configuration options.

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
| Texting | `GET /conversations`, `GET /conversations/unread`, `GET /patients/:id/conversation`, `POST /patients/:id/conversation/read`, `POST /webhooks/twilio/sms` (signed by Twilio) |
| Office | `GET/POST/PUT /lab-cases`, `GET/POST/PUT /tasks` |
| Engagement | `GET /messages`, `POST /patients/:id/messages`, `POST /appointments/:id/remind`, `POST /recalls/:id/remind`, `GET /booking-requests`, `POST /booking-requests/:id/accept\|decline`, `POST /patients/:id/form-requests`, `GET /patients/:id/forms` |
| Documents | `GET/POST /patients/:id/documents`, `GET /documents/:id/file`, `DELETE /documents/:id` |
| Payments | `GET /payments/config`, `GET/POST /patients/:id/payment-requests`, `POST /webhooks/stripe` (signed by Stripe) |
| 2FA | `POST /auth/mfa/setup\|enable\|disable` |
| Public (no login) | `GET /public/practices/:slug`, `GET /public/practices/:slug/availability`, `POST /public/practices/:slug/booking-requests`, `GET/POST /public/confirm/:token`, `GET/POST /public/forms/:token` |

## Roadmap ideas
- Direct connection to a specific clearinghouse (DentalXChange, Change Healthcare, Vyne and so on) for automatic claim submission and real-time eligibility. The EDI files are already generated; this adds the connection.
- Imaging bridges (Dexis, Sidexis, Carestream) and e-prescribing
- Recurring appointment series and provider-specific working hours
- Statement batches by mail, and automatic card-on-file charges for payment plans
- Postgres support and multi-server live updates (Redis) for larger groups, and SSO for staff logins

The CDT codes in the starter fee schedule are for convenience only. Practices need their own ADA CDT licence and should set fees for their market.
