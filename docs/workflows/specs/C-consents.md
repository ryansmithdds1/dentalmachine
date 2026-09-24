# C · Consents, patient education and paperwork on autopilot (C1–C4, E1–E3, P1–P5)

**Budgets.** Consent (or anything due) to the office iPad at the chair: **3 staff actions** (Ctrl/⌘K → "ipad" →
Enter); the patient signs on the iPad with no birth-date step. Forms & consents panel for the active patient: **1**
(Alt+F), then one key per channel (I iPad · T text/email · Q QR code · H this screen). Education shown in the chair:
**2** from the panel (Show). Declined at the chair: **2** + typing the reason. Measured by
`e2e/workflows/C-consents-paperwork.test.mjs`.

## Trigger and who does it
Before treatment that needs consent (extractions, root canals, implants, sedation…) and before every visit's
paperwork (health history, policies, screenings). Front desk and assistants hand the iPad over or send links; the
clinician checks consent before starting and records "patient declined" when that happens; nobody retypes anything.

## Data (one model — built on what was there)
- **Forms:** `form_templates` (consents are `kind = 'consent'`) + new columns `library_key`, `fields_es` (Spanish, same
  keys as English), `procedure_categories`, `witness`, `due_rule` (once / yearly / every_visit / new_patient),
  `legal_review` ("template — review with your attorney"), `education_slugs`.
- **Versions:** `form_template_versions` — every wording ever used (name, English, Spanish, hash), written on create/edit
  (`routes/forms.js` calls `currentVersion`) or the first time a changed wording is shown. Never edited.
- **A patient's consent:** `consents` — one per form and treatment context (`appt:12`, `plan:5`, `procs:1,2`; a partial
  unique index keeps it to one live row): needed → sent → signed / declined, or superseded (kept) when a new version
  must be signed. Signed/declined rows carry the exact wording (JSON + SHA-256), version, language, signer and
  relationship (self / parent / guardian / representative), time, via (link / kiosk / handoff / chair), IP, device,
  witness (user, name, signature), the PDF (`document_id`) and the `patient_forms` row. A **database trigger** refuses
  any change to that record afterwards (and to a signed `patient_forms` row's answers, wording or signature).
  `procedures.consent_id` / `consented_at` mark the treatment rows consented.
- **Packets and links:** packets reuse `form_requests` (+ `consent_id`, `kiosk_session_id`); each send, reminder, QR
  code or hand-off is its own `paperwork_links` row (hashed token, channel, purpose, opened time, birth-date failures).
  `paperwork_sends` are the autopilot's claims (`appt:12:initial`, `packet:40:reminder-after:<link>`), so a restart or a
  second server never sends twice.
- **Kiosk:** `forms_kiosks` (an iPad: hashed token, office, operatory; revoked, never deleted) and `kiosk_sessions`
  (one patient's turn: packet or education page, status, page/total, 30-minute life, 10-minute idle).
- **Education:** the existing library (`education.js`, `education_articles` + `topic`, `video_url`, `postop`), office
  pictures/videos in `education_media`, every shown wording in `education_versions`, and the proof in
  `education_deliveries` (who, version, how: shown_chair / shown_ipad / emailed / texted, operatory, kiosk session,
  consent, take-home token, when opened).

## Target
**C1 library.** Settings → Forms & consents lists ten consents (extraction, root canal, crown/bridge, implant, SRP,
sedation, ortho, whitening, informed refusal, financial policy) in English and Spanish. "Add from the library"
installs them once (the app's untouched starter forms are adopted, an edited one keeps its words); each is marked
"template" until the office says its attorney reviewed it.
**C2 auto-attach.** Consents attach from the visit's (or plan's) procedures by code prefix or category (Settings).
Opening a visit's paperwork, sending, the autopilot, or `POST /patients/:id/consents/attach` creates them; a consent
signed on the plan covers the visit; declined ones are asked again. The wording is filled with the patient's name,
procedures (code, description, tooth, fee), teeth, fee total, dentist, risks and alternatives.
**C3 ahead or at the chair.** The autopilot texts/emails a link a few days before (setting), reminds every N hours up
to N times until done, and stops at the visit. At the chair: the command bar or the panel hands the iPad over
(the iPad in the visit's operatory, else the one this person last used, else the only one), shows a QR code, or opens
the forms on this screen (the existing one-time hand-off pass). `<PaperworkBadge>` on schedule cards and
`<VisitPaperwork>` in the visit drawer show signed / not signed live; `GET /appointments/:id/consent-check` says
whether the clinician can start.
**C4 signed → chart.** The PDF (wording, answers, signature, signer and relationship, UTC and office time, via, IP,
device, witness, education given) is filed to Documents (`category consent`, `appointment_id`, `treatment_plan_id`);
procedures are marked consented; the record can't change. A new version needs a new signature (supersede with a reason).
Minors: a parent/guardian signs and is named. Witness: forms that ask for one need a team member's name and signature on
the office iPad. Declined: at the chair (clinical:write, reason required) or by the patient on the iPad (typed name +
signature) — a PDF, the same traceability, and an item in the intake worklist.
**E1–E3 education.** From the panel: Show (full screen on this chair monitor, Esc returns), iPad (kiosk session), Send
home (text/email with a tracked link only). Every one is recorded; opening a take-home link or viewing on the iPad sets
`opened_at`. The consent record and PDF quote it; `GET /patients/:id/education/proof` returns the sentence for the note
("Patient education: Your crown (v1) shown on the iPad in Op 2 by Maria Lopez on … at 10:42 AM.") — the panel copies it.
**P1–P5 paperwork.** `dueForVisit` decides: health history (new, or older than `history_renew_months`), policies
(once / yearly), screenings (every visit), new-patient forms, consents for the booked work. One "Send forms" sends what's
due (or anything chosen) by any channel. Kiosk: loaded for that patient, big EN/ES screens, signature, card photos,
"Are you still there?" after 90 s and cleared after 20 more, thank-you then home after finishing; staff see
"Pat is on form 2 of 5 on Op 1 iPad" through the shared live stream (`useLiveEvents`). Straight into the chart: contact
details apply at once (audited as the patient); the health history waits for the clinician's one-key "what changed"
(intake worklist, `POST /patient-forms/:id/review` — HIGH_RISK `PUT /patients/:id/medical` stays human-only); card
photos go to the insurance read-and-confirm path; every form is a PDF. Exceptions (declined consents, forms that
couldn't be sent, visits within two days with forms still open after reminders) are in `/intake` (A opens the panel, X
"handled", audited).

## Rules kept
Every id is checked against the practice (and the person's offices); the kiosk token reaches only its own open session;
links need the birth date (5 wrong tries turn the link off); texts carry the office name and a link, never treatment;
sends are idempotent (Idempotency-Key, 30-second same-send dedupe, unique claims for the autopilot); signing twice is
refused (410); everything is audited (attach, send, auto_send, reminder, link opened, sign, decline, supersede, view,
kiosk start/end, education shown/sent/opened); nothing is hard-deleted.

## Mounting (not done by this work's author)
`server/src/app.js`: import `consentRoutes` (routes/consents.js), `paperworkRoutes` (routes/paperwork.js),
`paperworkPublicRoutes` (routes/paperworkpublic.js); add `paperworkPublicRoutes({ db, storage, secret })` to the
`/api/public` chain; `api.use(consentRoutes({ db, storage }))` and `api.use(paperworkRoutes({ db, messenger, storage,
config }))`; add `|^\/api\/public\/(papers\/[^/]+|forms-kiosk\/sessions\/\d+)\/(history|forms\/\d+)$` to the big-body
and `formBody` path tests (signatures and card photos). `server/src/index.js`: add `runPaperworkSafely(db, messenger,
{ appUrl })` to the reminders tick. `client/src/App.jsx`: routes `/p/:token` (pages/public/Paperwork.jsx), `/kiosk`
(pages/public/Kiosk.jsx), `/e/:token` (pages/public/EduPage.jsx) and `<PaperworkCommands />` in the shell;
Settings → Forms: `<ConsentSettings />`.

## Acceptance
- `server/test/consents2.test.js` (SQLite and Postgres): library and versions, auto-attach by code and category (once,
  concurrently), autopilot send + reminders once even with two runs at once, at-the-chair kiosk, signed PDF filed +
  immutable + supersede, guardian and witness, declined at the chair and on the iPad, kiosk scope/expiry/revoke,
  education proof, due rules, contact auto-apply and history review, practice isolation, permissions.
- `e2e/workflows/C-consents-paperwork.test.mjs`: 3 staff actions to put the consent on the iPad and it's signed there;
  the kiosk flow in Spanish with live progress, clearing itself when done.
