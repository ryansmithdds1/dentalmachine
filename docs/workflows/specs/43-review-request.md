# 43 · Review request after the visit

**Budget: 0 (automatic); 1 to ask by hand.** Built and measured by [RV-reviews.md](RV-reviews.md) —
`e2e/workflows/RV-reviews.test.mjs` (from the chart: 1; Alt+R from the schedule: 1; a happy rating → invitation: 1).
Not re-measured in the daily test.

## Measured path
Nothing after a visit once review requests are on. By hand: Alt+R for the active patient, or Ctrl/⌘K "review name".

## Defaults
The practice's review link; text if there's a mobile number, else email; throttled per patient and opt-out aware.

## Background automation
Requests go out after checkout; low ratings go to the office first, high ones to the public review page.

## Fixed in this batch
The reputation page counted requests with `kind = 'review_request'`, but they are saved as `kind = 'review'`, so
"requests sent" was always 0 (`server/src/routes/reputation.js`; tested in `server/test/daily.test.js`).
