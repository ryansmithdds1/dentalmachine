# Reviews with a feedback screen, and team shout-outs (RV1–RV3)

How the office asks patients for reviews, what the patient sees, where private feedback goes, and how team
members named by patients are counted. Code: `server/src/reviewfunnel.js`, `server/src/shoutouts.js`,
`server/src/routes/reviewfunnel.js`, `client/src/pages/public/ReviewPage.jsx`, `client/src/pages/ReviewsDashboard.jsx`.
Tests: `server/test/reviews2.test.js`, `e2e/workflows/RV-reviews.test.mjs`. Workflow spec: `docs/workflows/specs/RV-reviews.md`.

## Compliance: no review gating (this is the default and cannot be turned off)
Google's review policy forbids "review gating" (asking only happy customers for reviews, or steering unhappy
ones away from posting), and the FTC's rule on consumer reviews (16 CFR Part 465) forbids suppressing negative
reviews. So:

- **Everyone rates first**, on our page, with one tap.
- **Happy ratings** (the practice's "happy from" setting, 4★ by default) get a warm invitation to post on Google
  and any other sites the office lists, with their words copied for pasting.
- **Lower ratings** get a caring "tell us what went wrong" form that goes privately to the owner and office manager.
- **Every patient, at every step** (before rating, after a low rating, after sending feedback) sees a small,
  honest line: "You can also post a public review on Google". The `/go` link works for every rating.
- There is **no setting that hides the public link**. `PUT /reviews/settings` refuses `public_link_for_everyone: false`,
  and the test suite checks the link is present for every rating and every threshold. Don't add such a mode.
- We never offer anything in exchange for a review, and team points come from what patients chose to write —
  not from asking patients to name anyone.

## Asking (RV1)
- **From anywhere**: the chart header ("Ask for review"), the patient bar (**Alt+R**, any screen with a patient
  active), checkout (Finish step), and the command bar (`review jane`, or "Ask for a review — <active patient>").
  One action, no dialog; a toast says what happened.
- **Text or email**: the patient's usual channel (the office can prefer text or email). A child's request goes to
  the parent (the same rule as reminders).
- **Throttle**: at most once every N months per patient (`review_settings.throttle_months`, 6 by default,
  1–24). Requests that never went (failed, blocked by an opt-out, expired) don't count.
- **Idempotent**: a second ask within 10 minutes returns the first request (double clicks, retries); the
  natural key `(practice_id, patient_id, request_day)` stops two concurrent asks from both sending. The app's
  `Idempotency-Key` covers exact replays.
- **Opt-outs**: a patient who turned texts/email off, or an address that replied STOP / unsubscribed, isn't
  asked (422, nothing stored, nothing sent). `sendMessage` checks again at send time.
- **Quiet hours**: outside the practice's sending hours a request is `queued` and goes out when hours open
  (dropped as `expired` after 3 days).
- **Automatic after a visit**: off by default (`practices.review_requests`); when on, completed visits (today and
  yesterday) get one request each, within sending hours, subject to the throttle and opt-outs.
- **Audited**: `review.request` (who, source, channel, outcome); the row's changes are recorded before/after.

## The patient's page (RV2) — `/r/:token`
Big tappable stars, English and Spanish (the patient's language on file, or the toggle). Funnel steps are
stored on `review_feedback`: `sent_at`/`send_status`, `opened_at`, `rated_at`/`rating`, `posted_click_at`/`posted_site`
(clicks through our `/go` redirect), `feedback_at` (private feedback). Links expire after 30 days; only a hash of
the token is stored.

**Private feedback** (rating below "happy from"): on the rating, and again when they write, the office is told
at once — a live event, and a post in the private team-chat group **Patient feedback** (with the patient linked;
urgent for 1–2★ or a call-back request). One **follow-up task** (high priority, due today) is kept up to date,
assigned to the follow-up person if set. Who is told: the people picked in settings, otherwise every
administrator and anyone given **Reviews: manage** (`reviews:manage`). If the chat post fails it becomes a Needs
attention item (the task and inbox still have it). The inbox tracks **new → contacted → resolved** with a note;
resolving closes the task. Every step is audited (source `patient` for the patient's steps).

## Team shout-outs (RV3)
Names in the patient's words (happy or not) and in synced Google reviews are matched to **active staff**:
first name, "first last", "Dr./Doctor <last>" for dentists, and **nicknames** the office adds ("Annie" → Anna
Smith). Rules, chosen to be fair:
- A name fitting several people ("Sam") is **needs a match** — no points until the owner picks (or says none).
  If the full name is also in the text, it's settled automatically.
- First names that are everyday words (Will, Joy, May…) count only when capitalised.
- Each person counts once per piece of feedback; re-checking never double counts.
- Named in a **low rating**: kept for coaching with 0 points, visible only to the owner/manager.
- **Points** per mention are a setting (10 by default), fixed when found. The **leaderboard** is by month; the
  owner can note a **reward** per person per month and a standing reward rule.
- The owner can **confirm** or **unlink** any match (unlinking needs a reason; the row is kept). All audited.

## Data
`review_feedback` (one row per request, extended with the funnel and follow-up columns), `review_settings`
(one per practice), `staff_nicknames` (configuration), `review_shoutouts`, `review_rewards`;
`reviews.mentions_checked_at`. The happy threshold, the automatic switch and the Google link stay on
`practices` (`review_threshold`, `review_requests`, `review_url`).
