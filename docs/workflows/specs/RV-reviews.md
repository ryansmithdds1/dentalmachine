# RV · Ask for a review, route feedback, count shout-outs (backlog RV1–RV3)

**Budgets.** Ask for a review for the patient in front of you: **1 action** (chart → **Ask for review**; or
**Alt+R** on any screen with the patient active; or checkout → **Ask for a review**; or Ctrl/⌘K → `review jane`
→ Enter, 2 actions plus typing the name). The patient: **1 tap** to rate and see where to go next. Follow up
private feedback: **≤ 2** (Reviews → Private feedback → **Contacted** / **Resolved**). Tested in
`e2e/workflows/RV-reviews.test.mjs` (chart and Alt+R: 1 action; one tap routes happy and unhappy ratings) and
`server/test/reviews2.test.js`. Rules and compliance: `docs/reviews.md`.

## Trigger and who does it
Front desk at checkout (or any time the patient is happy on the phone); the owner if they want it automatic after
every completed visit. Owner / office manager (`reviews:manage`) handle private feedback, settings, nicknames,
unclear shout-outs and rewards. Everyone can see the funnel and the shout-out leaderboard.

## Data needed
The patient (active patient, chart, checkout visit, or the name typed). Everything else is known: channel (their
usual), language, the practice's Google link and other sites, the throttle, sending hours, opt-outs.

## Today (before RV)
Only automatic after-visit requests; nothing to ask by hand. Low ratings never saw a public link (review gating);
no funnel beyond sent / answered; feedback was a task title only; no staff recognition.

## Target
- **Ask**: one click/key anywhere; toast "Review request texted to Jane Doe". A second click says it was already
  sent; too soon (throttle) says when it's possible again; opted out says so. Outside sending hours it waits.
- **Patient page**: big stars → happy: thank you, optional words ("Anyone on our team you'd like to thank?"),
  **Copy and post on Google** (and other sites); less than happy: "What went wrong?", **Please call me back**,
  **Send to <office>** → thanks with the office phone. The small public-review link is on every step.
- **Office**: instant post in the private **Patient feedback** team chat + a live alert + one high-priority task;
  the **Reviews & feedback** page (`/reviews`): funnel (sent → opened → rated → went to post / private
  feedback), average rating, Google rating, sources; **Private feedback** inbox (new → contacted → resolved,
  note, undo toast); **Shout-outs** (leaderboard by month, quotes, "which Sam?" picker, unlink with a reason,
  reward notes); **Settings** (Google link, throttle, channel, happy-from, automatic after visits, other sites,
  who's told, follow-up person, points, reward rule, nicknames).

## Keyboard
Alt+R (active patient), Ctrl/⌘K `review <name>` Enter; chart button is in the tab order; stars are buttons
(Tab / Enter) on the patient page.

## Mounting
`server/src/app.js`: `import reviewFunnelRoutes, { reviewPublicRoutes } from './routes/reviewfunnel.js';`,
`app.use('/api/public', reviewPublicRoutes({ db }));` and `api.use(reviewFunnelRoutes({ db, messenger, config }));`.
`client/src/App.jsx`: a lazy `ReviewsDashboard` and `<Route path="/reviews" element={<ReviewsDashboard />} />`.
Until then the e2e test skips.
