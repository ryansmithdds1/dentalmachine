# Testing: the layers and what each one catches

Dental Machine is tested in layers. The lower ones run on every push; the browser layers that take longer run
nightly; one layer checks the live site after every deploy. Nothing here ever writes to production data
(CLAUDE.md rule 16): everything runs against a fresh, seeded local server except the post-deploy smoke test,
which is read-only by construction.

| Layer | Where | When | Catches |
|---|---|---|---|
| Lint | `npm run lint` | every push (CI `test`) | names that aren't defined, unreachable code, hook mistakes |
| Server tests | `server/test/*.test.js` | every push, SQLite **and** Postgres | money, claims, permissions, audit, idempotency, imports… |
| Production-config boot | `server/test/prodboot.test.js` | every push (part of the server tests) | a deploy that refuses to start or can't sign in |
| Load test | `npm run loadtest` | every push (SQLite) | screens and reports that get slow with 5,000 patients |
| Core flow + workflows | `e2e/*.test.mjs`, `e2e/workflows/` | every push (CI `e2e`) | the day's main flow; click budgets per workflow |
| Every-screen sweep | `e2e/sweep/sweep.test.mjs` | every push (CI `sweep`) and nightly (deeper) | broken screens in any role, theme or screen size |
| Chaos (misbehaving browser) | `e2e/chaos/*.test.mjs` | nightly | stuck "Listening…", endless spinners, lost or doubled saves |
| Role journeys | `e2e/journeys/*.test.mjs` | nightly | a whole role's day no longer working end to end |
| Post-deploy smoke | `e2e/smoke/live.test.mjs` | after each deployment, every 3 hours, on demand | a live site that is down, can't sign in or shows broken pages |

Browser tests need a build and Chromium: `npm run build` and `npx playwright install chromium` once.
`CLIENT_DIST=/some/dir` uses a build elsewhere; `E2E_SHOTS=dir` keeps screenshots (and, for journeys, a
Playwright trace — open it with `npx playwright show-trace file.zip`). CI uploads that folder when a job fails.

## Production-config boot (`server/test/prodboot.test.js`)

Why: the live demo once refused to start because the pre-flight checks demanded `REDIS_URL` on Vercel, and no
test booted the server the way Vercel does.

It starts the real serverless entry (`api/index.js`, through `server/test/fixtures/vercel-host.js`) in a child
process with exactly the live project's environment — `VERCEL=1`, `NODE_ENV=production`, `DEMO_SEED=on`,
sandbox/log drivers, `LIVE_UPDATES=off`, `REMINDERS=off`, random secrets, no `REDIS_URL`, no `APP_ENV` — and a
throwaway database (a temporary SQLite file, or a private schema in `TEST_DATABASE_URL` Postgres). It checks:

- `/api/health` answers 200 and every demo role signs in (the demo configuration starts);
- a real-data configuration (`APP_ENV=production`) without Redis **refuses** to start (503, "Refusing to start");
- the same two answers from `productionProblems()` directly.

If the live project's settings change, change `vercelDemoEnv()` in the test to match.

Run: `cd server && node --test test/prodboot.test.js` (add `TEST_DATABASE_URL=postgres://…` for Postgres).

## Every-screen sweep (`e2e/sweep/sweep.test.mjs`)

Opens every page of the staff app as each demo role (admin, dentist, hygienist, front desk, billing), in light
and dark mode, at 1400×900, 1024×1366 and 390×844. On a desktop in light mode and on a phone in dark mode it also
clicks every tab of each page, every Settings section and every tab of a patient's chart (`SWEEP_DEEP=all` —
used nightly — does that everywhere). It fails on:

- page errors (uncaught exceptions) and console errors; the "Something went wrong on this screen" crash card;
- requests answered 4xx/5xx — except 403/404 on a page that isn't in that role's menu (a typed address);
- the page scrolling sideways; "undefined", "NaN", "Invalid Date", "[object Object]" in the visible text;
- "Loading…" still on screen, or requests still running, after `SWEEP_LOADING_SECONDS` (8);
- a blank page; the offline banner; any unexpected `alert`/`confirm` dialog.

**Where the pages come from.** Nobody keeps a list: `e2e/lib/routes.mjs` reads the router (`<Route path>` in
`client/src`, nested routers included) and the menu (`client/src/nav/navConfig.js`, or App.jsx's nav array),
fills `:id` routes with ids from the demo practice, and prints the ones it couldn't fill. What a role's menu
offers comes from the menu definition (`navFor`) with the person's permissions, or from the links drawn on
screen. A new page is swept automatically.

**The allowlist** is `ALLOW` at the top of the test; each entry says why. Two kinds:

- acceptable by design — the "Diagnosed" chip hides itself on a 403; Phones → Alerts asks the server whether
  you receive phone alerts (403 = you don't, and the tab says so); the time-clock kiosk needs a kiosk key (401)
  in a staff browser; printable documents are paper-width on a phone;
- `known: true` — real bugs found by the first sweep that haven't been fixed yet (sideways scrolling on phones
  on Billing → Eligibility, Ask your data, Time clock manager tabs, Reviews settings, Phones → Why they didn't
  book, and Business at tablet width). **Remove an entry when its page is fixed.**

Run everything: `npm run e2e:sweep` (about 15–20 minutes with 4 workers). A slice while you work:
`SWEEP_ROLES=billing SWEEP_VIEWPORTS=phone SWEEP_THEMES=dark SWEEP_VERBOSE=1 npm run e2e:sweep`.
With `E2E_SHOTS` it writes `sweep-report.json` (every finding, what was tolerated and why, the routes).

## Chaos: a misbehaving browser (`e2e/chaos/`)

Fakes injected with `addInitScript` (`e2e/chaos/fakes.mjs`) make browser features misbehave the way real ones
do, and each test checks the screen recovers — no endless spinner or "Listening", a clear message, and the
person can carry on:

- `speech.test.mjs` — speech recognition that ignores `stop()` and keeps hearing, fails to start (no
  microphone, network) or is denied: note dictation, perio voice charting, lab check-in "hold to talk", the AI
  scribe. (The assistant's mic: `e2e/assistant-mic.test.mjs`. Phone-call live transcription runs on the server,
  so there's no browser recognizer to misbehave.)
- `media.test.mjs` — camera/microphone denied, or never answering: the intraoral camera, dictation through the
  office's speech service, the whole-visit recorder, the lab slip scanner; and an x-ray sensor capture that the
  imaging bridge never picks up.
- `browser-apis.test.mjs` — a cancelled file chooser, printing, a refused clipboard.
- `network.test.mjs` — the connection dropping mid-save *after* the server saved (the answer is lost: the change
  is kept and resent, and idempotency keeps it to one note / one payment); card payments offline; a slow server
  and double-clicks on Post payment, note save and claim Approve (one of each); the session expiring mid-work
  (back to sign-in, no crash). Keeping an unsaved note across an expired session is a `todo`: it would mean
  keeping clinical text in the browser after sign-out, which is an owner decision.

Run: `npm run e2e:chaos`.

## Role journeys (`e2e/journeys/`)

One nightly test per role, driven through the screens on a fresh seeded server and checked on the server:

- **Front desk** — new patient with insurance, book, confirm, check in, take a payment, reschedule, cancel.
- **Dentist** — open today's patient from the schedule, chart, build and present a plan (signed here), note and sign.
- **Hygienist** — full-mouth perio on the keyboard, save, book the recall visit.
- **Billing** — approve a claim from Ready to approve, the sandbox ERA posted through the insurance autopilot,
  send statements, close the day with a deposit.
- **Owner** — metrics, every report tab, every business tab.

Run: `npm run e2e:journeys` (or one: `node --test e2e/journeys/billing.test.mjs`). A failed step leaves
`journey-<role>-<step>.png` and `journey-<role>-trace.zip` in `E2E_SHOTS`.

## Post-deploy smoke test (`e2e/smoke/live.test.mjs`) — read-only

Signs in as each demo role, opens every page in that person's menu, a schedule day, a patient's chart (each tab)
and the Billing tabs, and fails on any 5xx (or 401), page or console error, the offline banner / "can't be saved
offline", a crash screen, a blank page or an endless "Loading…".

**It cannot change data.** Every request other than GET/HEAD/OPTIONS is intercepted in the browser. Sign-in is let
through (it records a login, as any sign-in does). A short list of writes the app makes by itself just by showing a
screen (Messages marks the open conversation read; browser error reports) is *held* in the browser — never sent,
never answered. Anything else is blocked and fails the test with the request listed.

- From here: `npm run smoke -- https://dentalmachine-server.vercel.app`
- Behind a TLS-inspecting proxy: `SMOKE_TRUST_CA=/path/to/proxy-ca.pem` (trusts only that CA's key).
- In GitHub Actions (`.github/workflows/post-deploy.yml`): on every successful `deployment_status` (the Vercel
  GitHub integration posts these for production and preview deployments; the URL comes from
  `environment_url`), every 3 hours against the live site, and from the Actions tab with any URL.
  Preview deployments behind Vercel Deployment Protection need the repository secret
  `VERCEL_AUTOMATION_BYPASS_SECRET` (Vercel → Project → Settings → Deployment Protection → Protection Bypass for
  Automation).

Sign-in attempts are rate-limited per address (20 per 15 minutes); one run uses five.

## CI and nightly

- `.github/workflows/ci.yml` — `test` (lint, server tests incl. prodboot on SQLite and Postgres, build, load
  test), `e2e` (core flow + workflows), `sweep`.
- `.github/workflows/nightly.yml` — sweep (`SWEEP_DEEP=all`), chaos and journeys in parallel; screenshots,
  reports and traces uploaded as artifacts on failure.
- `.github/workflows/post-deploy.yml` — the smoke test above.
