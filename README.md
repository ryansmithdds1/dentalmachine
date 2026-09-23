# Dental Machine

Cloud practice management software for dental offices: scheduling, patient records, clinical charting, treatment planning, billing, insurance claims and reporting. Several practices can share one deployment, and each practice's data is kept separate.

## Features

| Area | What it does |
| --- | --- |
| **Scheduling** | Day view by operatory or provider. Blocks double-booking of a provider, operatory or patient. Finds open times. Tracks appointment status from scheduled through confirmed, checked in, seated and completed (or no-show/cancelled). Planned treatment can be attached to a visit. |
| **Patients** | Demographics, medical alerts, allergies and medications. Search by name, phone, email, DOB or ID. Patients are archived rather than deleted, so records are kept. |
| **Clinical charting** | Interactive tooth chart with five surfaces per tooth (Universal numbering 1–32, primary teeth A–T). Records conditions (caries, missing, crown, RCT, implant and more), planned work and completed work. |
| **Perio charting** | Six probing depths per tooth, with bleeding on probing. Depths of 4mm and 5mm+ are highlighted. Exam history is kept. |
| **Treatment plans** | Multi-procedure plans with an insurance vs. patient estimate for each line. Estimates apply the deductible, coverage tier and remaining annual maximum. Plans can be marked accepted or declined, and close automatically when all work is done. |
| **Clinical notes** | Note templates. Signed notes can't be edited; corrections go in a new note. Signing requires a clinical role. |
| **Ledger & billing** | Completing a procedure posts the charge automatically. Handles payments, adjustments and refunds, shows a running balance, and prints patient statements. |
| **Insurance** | Carriers and primary/secondary policies. Claims are built from completed procedures and move through draft → submitted → paid, partially paid or denied (or void). EOB entry posts the insurance payment and write-off to the ledger, and the deductible met updates automatically. |
| **Recall** | Completing a prophy or perio maintenance sets the next recall due date. The recall list tracks who has been contacted. |
| **Reports** | Dashboard, production and collections by day, provider, category and procedure, and A/R aging (0–30 / 31–60 / 61–90 / 90+). |
| **Admin** | Users and roles, providers (NPI and schedule colour), operatories, fee schedule, practice details and time zone, and a full audit log. |

### Security and HIPAA-related safeguards
- **Separate data per practice.** Every query is limited to the signed-in user's practice. Tests confirm one practice can't read another's records.
- **Role-based access.** Roles are `admin`, `dentist`, `hygienist`, `assistant`, `front_desk` and `billing`, each with its own permissions (see `server/src/auth.js`).
- **Audit log.** Records every view of a patient record or chart, every change, every login and every failed login, with user, time and IP.
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
| Reports | `GET /dashboard`, `GET /reports/production`, `GET /reports/aging` |

## Roadmap ideas
- Electronic claim submission (837D) and eligibility checks (270/271) through a clearinghouse
- Card payments (Stripe) and online patient payments
- Appointment reminders by SMS or email, and online booking
- Digital intake forms and signatures, plus imaging and document upload
- Postgres support for larger groups, and MFA or SSO for staff logins

The CDT codes in the starter fee schedule are for convenience only. Practices need their own ADA CDT licence and should set fees for their market.
