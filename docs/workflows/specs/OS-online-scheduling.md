# OS — Online scheduling that beats the others

**Trigger:** someone on the practice's website, Google listing, social page or a link in an ad wants a visit.
**Who:** patients (the booking page, `/book/:slug`, hosted or inside the practice's website); the front desk sees
every booking live and handles only the exceptions; administrators set it up (Settings → Online booking).
**Backlog:** OS1–OS5 in `docs/workflows/backlog.md`. Code: `server/src/onlinesched.js` (rules),
`server/src/routes/onlinesched.js` (public, staff and embed routes), `client/src/pages/public/BookingPage.jsx`,
`client/src/components/OnlineBookings.jsx`, `OnlineBookingAlerts.jsx`, `OnlineSchedSettings.jsx`.

## Target
| Who | Step | Actions |
|---|---|---|
| Patient (new) | Reason → time → name, birth date, phone → Book | **3 taps** (≤ 5 with an office and party size), + 4 typed fields; e2e budget 11 actions / 8 s |
| Patient (emergency) | Reason → time → details + 3 triage answers → Book | 6 taps + 4 typed fields |
| Patient (family of 3) | + "3 people" → back-to-back times → each person's name/birth date | +1 tap |
| Front desk | Know a booking happened, who/what/when, what needs a person | **0** (toast + sound + chat post + list); 1 click "Seen" |
| Front desk | A booking that needs approval | the existing Online requests → Accept (unchanged) |
| Admin | Put booking on the website | paste 1 line (`/embed.js`) |

## The patient's flow (OS2)
1. **Office** (only with several offices; `?location=` on a link skips it).
2. **Reason** — the practice's online visit types, each with its length and who it's for. `?kind=emergency` or
   `?type=<id>` (and `data-dm-book="emergency"` on the website) skips straight to times.
3. **Time** — the next 4 days with openings, up to 6 well-placed times a day, "Show later dates", optional provider,
   "Booking for: Just me / 2 / 3…" for family types. Emergencies see the earliest times first, a 911/ER notice and the
   office phone.
4. **Details** — first name box already focused; name, birth date (MM/DD/YYYY, numeric keypad), mobile, email; the
   type's questions (triage for emergencies: pain 0–10, swelling, injury, fever); insurance collapsed ("+ Add dental
   insurance": company + member ID, or a photo of the card); notes; "Text me if an earlier time opens up" (ASAP).
5. **Confirmed** — booked (or "request received"), each person's time, **Add to calendar** (.ics), **Change or
   cancel** (the existing confirmation page `/c/:token`: confirm, cancel, ask to move), and "we'll call you shortly"
   for urgent emergencies. If the time was just taken: "That time was just taken — here are the nearest open times",
   one tap on a nearby time and Book again.

English/Spanish throughout (`es.js`; visit types and questions have Spanish labels). Mobile-first, 44px targets,
focus moves to each step's heading, labelled inputs, `role=alert` errors, works by keyboard.

## Visit types (OS2) — `online_visit_types`
Seeded on first use from the practice's appointment types, then edited in Settings → Online booking:

| Kind | Default | Rules |
|---|---|---|
| New patient exam & cleaning | 60 min · new patients · families · instant | lead 2 h, 60 days ahead |
| Tooth pain / emergency | 30 min · anyone · instant | lead 30 min, 3 days ahead, triage questions → urgent |
| Cleaning & checkup | 60 min · current patients · families · instant | hygienists; own hygienist first; flagged if before the recall is due; someone who doesn't match a chart waits as a request |
| Consultation (implants, Invisalign, braces, cosmetic) | 30 min · anyone · **request** | topic question |

Each type: name (EN/ES), one-line blurb, kind, appointment type on the schedule, length, buffer after, providers,
offices, earliest (minutes from now), how far ahead, instant vs request, who may book, families, questions (yes/no,
0–10, choices, short text; an "urgent line" per question), deposit + when (never / new patients / no-show-prone times
/ always), card on file + when. Retired, never deleted; every change audited.

**Held emergency time** uses the existing models, not a new one: a perfect-day block (Settings → Perfect day) or a
reserved block on the schedule kept for the emergency appointment type. Online, only emergencies are offered that time
until the block releases; the front desk can still book into it deliberately ("anyway", audited).

## Straight into the schedule (OS3)
- **Open times are real:** `openSlots` (provider/office hours, visits, blockouts, reserved blocks, held requests) with
  the type's buffer, minus perfect-day blocks kept for other types before their release, minus times with no free
  chair (the provider's own chair first). The lead time and "how far ahead" limits apply.
- **Checked again at submit**, inside the booking transaction (Postgres: an advisory lock per practice; SQLite runs
  one transaction at a time), and `validateAppt` checks once more. Two people tapping the same time: one gets it,
  the other gets the nearest open times (409 with `details.nearest`).
- **Instant or request per type.** Instant: `finishBooking` creates the visit (and chart) in the same transaction,
  the chair assigned, the type's procedures planned (so the schedule shows production), recalls linked. Request: a
  pending `booking_requests` row that holds the time until the office accepts it (existing Online requests queue).
- **Patient matching (existing rule, `matchPatient`):** an existing chart only when last name + birth date + phone or
  email match. Near misses get a new chart, a task, `possible_duplicate` on the booking and
  `booking_requests.possible_duplicate_id`. **Never merged automatically.**
- **Insurance:** typed details on a new chart become a policy + "verify" task (existing rule); on an existing chart
  they wait in `insurance_updates` for review. A **card photo** is filed in the chart (encrypted) and waits in
  `insurance_updates` with the photo; it is **read in the background** (AI when on, the sandbox reader on demo servers,
  audited as source `ai`) into that pending update. A person checks it against the photo and enters it (Insurance tab).
  Nothing becomes a policy without a person.
- **Deposit / card on file** (optional per type; one person at a time): Stripe's own pages (card numbers never touch
  the server; the existing webhook completes a deposit booking); `PAYMENTS=sandbox` simulates both. A deposit is a
  payment on the ledger when the visit is booked (existing `finishBooking` rule).
- **Intake forms right after:** new patients get their health history + the practice's auto-send intake forms
  (`createPacket`); everyone else gets forms by the usual 3-days-before job.
- **Idempotent:** each submit carries a key (`online_bookings.submit_key`, unique per practice). The same key again —
  a double tap, a retry, two tabs — returns the same booking (200, `repeat: true`); a new key is made when the time
  changes.

## Never blindsided (OS4)
On every booking, at once:
- **Live event** `online_booking` (ids only) → every signed-in screen fetches the details it may see and shows a
  **toast** (red for urgent) with who, what, when, provider, office, new/existing, insurance status, triage answers and
  "Needs a person: …"; a **soft chime** unless the person turned it off (bell on the Online bookings list; per-user
  pref `onlinebooking.sound`). Same shared live connection (`useLiveEvents`) — no new stream.
- **Front desk chat channel** post (system message, source patient, linked to the patient; urgent emergencies post as
  urgent, so everyone must "Got it").
- **Optional text to an office phone** — no names or health details in it.
- **High-priority task** "call them now" for an urgent emergency.
- **Online requests → Online bookings** (first tab): today / this week / last 30 days, with source, flags, "Seen".
- **Booked online badge** on the schedule card (`appointments.online_booking_id`; the one line for `CalendarGrid.jsx` is under Mounting).
- Failures (confirmation not sent, forms, card read, deposit page, the alert itself) become Needs attention items.

Flags: urgent · possible_duplicate · not_matched · insurance_to_verify · card_to_read · needs_approval ·
before_recall_due · has_upcoming_visit · family · existing_booked_new · deposit_paid · card_on_file.

## Better than the others (OS5)
- **Family in one go** — back-to-back, same provider where possible, one confirmation.
- **ASAP opt-in** — the visit is marked ASAP; the existing fill-offer engine texts them when an earlier time opens.
- **Smart slot choice** — times that start or end against another visit (or the start of the day) score up; times
  that leave a sliver under 30 min score down or are hidden; perfect-day production blocks are protected (offered to
  other types only when fewer than 3 other times exist). Patients see a short, spread-out list per day.
- **Conversion analytics** (Settings → Online booking): page visits → office → reason → time → details → booked /
  requested, "time was just taken", bots stopped, by source, by headline variant, visits booked and $ scheduled
  (planned procedure fees on those visits). **No PHI:** `online_booking_events` holds a random session key, the step,
  visit kind, a source slug and the variant — nothing else, by design and by test.
- **A/B-safe copy** — only the headline varies (per session); times, prices and questions never do.
- **Bot protection** — honeypot (silently dropped, counted), optional Cloudflare Turnstile (off unless both keys are
  set; the call goes through `loggedFetch`), rate limits (reads 120/min, slots 40/min, bookings 20/hour per address,
  events 400/hour), flood limits (60 online bookings/hour per practice, 6/day per phone or email).

## Website integration (OS1)
- **Button (recommended):** `<script src="https://APP/embed.js" data-practice="slug" async></script>` — a tiny
  dependency-free loader: a floating "Book online" button (or `data-inline="true"`), an accessible modal (dialog,
  focus to close, Esc, click outside) with the booking page in an iframe. Options: `data-label`, `data-color`,
  `data-source`, `data-lang`, `data-button="none"` with `data-dm-book` on the site's own buttons
  (`data-dm-book="emergency"`). Passes the host page's UTM tags and host name; fires `dentalmachine:booked` on
  `window` (no personal details) for the site's own analytics.
- **iframe:** `<iframe src="https://APP/book/slug?embed=1&src=website" …>`. `/book/:slug?embed=1` is the only page
  that may be framed (`frame-ancestors` = the practice's listed sites, or any when none are listed).
- **Hosted page:** `/book/slug`, with the practice's logo, color and headline (EN/ES).
- **Google:** paste `…/book/slug?src=google` as the Business Profile booking/appointment link (or use "Add the Book
  button" when Google Business is connected). "Reserve with Google" inside Google needs a Google-approved partner.
- **Sources:** `?src=` (google, facebook, instagram, qr, website…), `utm_source/medium/campaign`, referrer host.

## Parity
Only well-known public capabilities; *(uncertain)* marks what we couldn't confirm.

| Product | What they do | What we do | Where we're better |
|---|---|---|---|
| Open Dental Web Sched | New Patient, Recall, ASAP and Existing Patient web scheduling from the Open Dental schedule (operatory/provider time rules); recall links in reminders; paid eService | New, existing, emergency, hygiene, consults; recall self-booking (RC2); ASAP via fill offers | Emergency triage with urgent routing; perfect-day/production protection; live front-desk alert + chat; card photo read; family back-to-back in one go *(family support in Web Sched uncertain)*; built in, no separate service |
| NexHealth | Online booking widget synced to many PMSs, forms, insurance capture, reminders; Google booking *(Reserve with Google partner — uncertain)* | Booking writes straight into our own schedule in one transaction | No sync lag or double-booking window; duplicates flagged not merged; triage; production-aware slot choice; conversion analytics without PHI |
| LocalMed | Real-time online scheduling for dental practices, website and directory booking *(emergency hold times and Google integration — uncertain)* | Held emergency time via the schedule's own blocks | Same rules as the front desk's schedule; urgent triage → task + chat; ASAP opt-in |
| Zocdoc | Marketplace: patients find and book providers, insurance filter, reviews; per-booking fees for new patients; some PMS sync | Practice-owned page/widget; UTM/source tracking | No per-booking fee or marketplace; direct write-back; existing-patient matching and hygiene with their own hygienist |
| Weave | Communications platform with online scheduling *(request-based vs instant write-back varies — uncertain)*, texting, forms, payments | Instant or request per visit type; texts, forms and card on file in the same system | Per-type approval; triage; family; analytics funnel; one audit trail |
| Dentrix Ascend / Curve | Cloud PMS with online patient booking *(depth of online booking, add-ons and partners vary — uncertain)* | Built into the cloud schedule | Emergency triage, family, ASAP, smart slots, embed loader and analytics out of the box |

## Rules kept
Validated on the server (ids belong to the practice; dates, times, phone, email, birth date, answers, card photo
type/size, sources as short slugs); idempotent submit; audited as source `patient` (card reads as `ai`); practice and
office scoping on every staff route (someone limited to some offices sees only theirs); no PHI in URLs, live events,
analytics or the office text; public routes rate limited; settings changes admin-only and audited with before/after.

## Mounting (app.js / client)
```js
// server/src/app.js — with the other /api/public routers (before app.use('/api', api)):
import onlineSchedPublicRoutes, { onlineSchedRoutes, onlineSchedEmbedRoutes } from './routes/onlinesched.js';
app.use('/api/public', onlineSchedPublicRoutes({ db, messenger, payments, storage, config, fetchImpl }));
// with the other staff routers:
api.use(onlineSchedRoutes({ db, config }));
// before the SPA static files (e.g. just before `app.use('/api', api)`):
app.use(onlineSchedEmbedRoutes({ db }));
```
Schedule card badge (`client/src/components/calendar/CalendarGrid.jsx`, next to the ASAP badge):
`{a.online_booking_id ? <span className="cal-asap" title="Booked online">Online</span> : null}`

Optional: add `^\/api\/public\/os\/[^/]+\/book$` to the 15 MB body regex if card photos larger than ~700 KB (after
in-browser shrinking) should be accepted. Client: nothing to add to `App.jsx` (the page is the existing `/book/:slug`
route, the list is a tab in Online requests, alerts mount inside `Toasts`).

## Tests
`server/test/onlinesched.test.js` (SQLite and Postgres): never offers a taken/blocked/perfect-day-blocked time; smart
ordering; the race at submit; emergency held time, triage → urgent, task and chat post; new vs existing matching and
duplicates flagged; requested vs instant (and accepted from the usual queue); notifications (chat, office text without
names, list with source/UTM, alert text); family back-to-back; idempotent submit; deposit and card on file (sandbox);
card photo filed and read in the background, never a policy; analytics without PHI; practice isolation; embed loader;
honeypot and rate limit. `e2e/workflows/OS-online-booking.test.mjs`: new patient in 3 taps / 10 actions with the
front-desk toast and list; emergency flow with urgent flag and call task; Spanish + embed/iframe.
