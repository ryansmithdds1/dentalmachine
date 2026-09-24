# PT — Patient portal 2.0 and "Pay my bill" from the website

**Trigger:** a patient wants to know what they owe and why, or to pay — from a statement, a text, the practice's
website or the portal.
**Who:** patients (the portal `/portal/:key`, and the bill-pay page `/billpay/:slug` with no account login); billing
sees only the exceptions (Needs attention); administrators paste one line on the website.
**Backlog:** PT1–PT4 in `docs/workflows/backlog.md`. Code: `server/src/billpay.js` (codes, account numbers, taking
and posting payments, plan rules), `server/src/routes/portalaccount.js` (portal account + billing),
`server/src/routes/billpay.js` (public bill-pay, `/billpay.js`, staff helpers), `client/src/pages/public/PortalAccount.jsx`,
`BillPay.jsx`, `billing-i18n.js`, `billpay.css`. Tests: `server/test/portal-pay.test.js`, `e2e/workflows/PT-portal.test.mjs`.

## Target
| Who | Step | Actions |
|---|---|---|
| Patient, from the website | "Pay my bill" → statement code → Enter → Pay | **≤ 4 actions** (e2e budget 4 actions / 15 s, sandbox card) |
| Patient, from the statement QR code or a text link (`?code=`) | Pay | **1 tap** (+ the card processor's page with Stripe) |
| Patient, signed in to the portal | Pay the amount due with a saved card | 2 taps (Pay → Pay $X) |
| Billing | Know an online payment failed | 0 — a Needs attention item (billing), closed by itself when the patient's next payment works |
| Billing | Post an online payment | 0 — posted automatically, once, from the processor's answer |
| Admin | Put "Pay my bill" on the website | paste 1 line (`/billpay.js`) or a plain link |

## PT1 — the account at a glance (portal)
`GET /api/portal/account` — worked out from the ledger every time (nothing stored):
- **You owe now** = household ledger balance − what insurance is still expected to pay − in-network write-offs still to
  post (`pendingInsurance`, the same numbers as statements and the staff ledger). Plain words: "Your account balance is
  $X. We're still waiting on your insurance for $Y, so what you owe now is $Z", or all paid up, or a credit.
- **Charges and payments by visit:** each visit's lines (charged, insurance paid, in-network discount, adjustments,
  you paid, waiting on insurance, left for you) from `explainBalance` (`routes/billing.js`, the staff "Why do I owe
  this?" — extracted unchanged into a function). The open amounts less unapplied credit plus "other" always equal the
  ledger balance (tested).
- **Your family** (guarantor only): each member's portion, what's with insurance, next and last visit; tap a member for
  their visits (`/account/members/:id` — 404 for anyone but the guarantor or the member themself).
- **Upcoming visits** stay in the portal's existing section (confirm / move / cancel).
- **Treatment plans with costs:** each planned procedure's fee, insurance estimate and your estimate.
- **Statements** (sent statements: date, amount, how) + download the current statement; **receipts** (PDF, or email it).
- Someone who isn't the guarantor sees only themselves; payments still go to the family's account.

## PT2 — paying
`POST /api/portal/billing/pay` (Idempotency-Key required by the screens; one key per attempt).
- **Amount:** the amount due (default) or another amount, from $0.50 to the household ledger balance.
- **How:** a saved card (charged now, off-session); a new card — Stripe's hosted page shows **Apple Pay / Google Pay /
  Link** automatically on devices that have them; a **bank account (ACH, `us_bank_account`)** when `PAYMENTS_ACH=on`
  (or `config.stripeAch`) — it clears in a few days, posts when Stripe says paid, and a bounce
  (`checkout.session.async_payment_failed`) becomes a billing item. Sandbox: the published test numbers only
  (card 4242… approves, …0002 declines; bank 000123456789 clears, 000111111116 is refused).
- **Save the card** (guarantor only): Stripe keeps it on the patient's Customer (`setup_future_usage=off_session`); we
  keep brand/last 4/expiry and the processor ids in `payment_methods`, never the number. Add (Stripe's setup page),
  remove (marked removed, detached at Stripe; autopay that used it stops and the office gets a task).
- **Payment plan + autopay** (guarantor, no active plan): the choices come from the owner's financial options
  (`practices.fin_options`, F5: `in_office` months, max months, minimum amount, minimum down payment) or the defaults
  (3/6/12 months, $500 minimum, 20% down). Only interest-free plans without a setup fee are set up online; anything else
  says "call the office". The down payment is charged now to the chosen saved card (a decline sets up nothing); the plan
  (`payment_plans`) starts after `first_payment_days` with autopay on that card (the existing `runAutopay`). Autopay on/off.
- **Receipts:** emailed when the patient ticks "Email me a receipt" (default on), or automatically when the practice has
  automatic receipts on.
- **Posting (money rules):** every online payment is a `payment_requests` row first; `postOnlinePayment` flips it to
  paid and posts one `payment` ledger entry in the same transaction, with the processor's payment id as the reference.
  The Stripe webhook, the patient coming back from Stripe (`/billing/return`, which asks Stripe) and a sandbox or saved
  card charge all go through it — a replayed webhook or a double click posts nothing more (tested). Daily reconciliation
  is unchanged: Checkout and off-session charges carry `metadata.practice_id`, and the ledger reference is the `pi_…` id.
- **Failures** (declined, bank refused, processor down): the patient sees a kind message ("That payment wasn't approved
  (reason). You haven't been charged…" / "We couldn't finish the payment just now…", EN/ES); billing gets one Needs
  attention item per account (`online-pay:<guarantor>`), counted up on repeats, resolved automatically by the next
  payment that works.

## PT3 — "Pay my bill" from the website
- **Website:** `<script src="https://APP/billpay.js" data-practice="slug" async></script>` adds a "Pay my bill" button
  (`data-label`, `data-color`, `data-inline`, `data-lang`, `data-button="none"` + any `data-dm-pay` element). It opens the
  page in a new tab (same tab on phones) — payment pages are never framed inside another site (Stripe's page and Apple
  Pay need the top window). A plain link to `/billpay/slug` works too. Staff: `GET /api/billpay/settings` gives the
  snippet and what's missing (slug, portal on, payments connected).
- **Statement code:** one per account (the guarantor), 10 characters without look-alikes (`K7QM4-XPD2R`, 31^10
  combinations), in `billpay_codes`; printed on the staff print statement (with a QR code to `/billpay/slug?code=…`) and
  on mailed statements (`statementHtml`), available to staff (`GET /api/patients/:id/billpay-code`, audited) and
  replaceable (`POST …/billpay-code/rotate`, audited — the old code stops working).
- **Find the bill:** the code, or last name + date of birth + ZIP or phone (a dependent's details find the family
  account). The answer is **only the amount due** (and whether a code can be texted/emailed) — no name, address, visit
  or balance. Not found / more than one account → a plain message and the office phone.
- **Protection:** 10 lookups per 15 minutes per address; 8 name lookups per hour per last name per practice; a
  honeypot field; Cloudflare Turnstile when `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` are set (off otherwise); the
  found bill is a 30-minute signed token scoped to the practice; payments from this page are capped at the amount due.
- **Pay:** same as PT2 (no saving cards here). **See details:** a one-time code by text or email to what's on file
  (5 per hour, 5 tries per code, 10 wrong guesses per hour) opens the full portal.
- Every step is audited as the patient (`billpay.lookup`, `billpay.lookup_miss`, `billpay.payment`, `portal.login`…).

## PT4 — smooth and safe
Mobile-first (one column, 44px+ targets, numeric keypads, no horizontal scroll — checked at 390 px in e2e), English and
Spanish (`billing-i18n.js`, the patient's language on file), labelled fields, `role=status` confirmations, keyboard
reachable (radio groups, buttons, details/summary). No stacked modals (inline pay form); no "Are you sure?" (paying is
the confirmation); smart defaults (the amount due, the saved card, "Email me a receipt").

## Wiring (until mounted)
`app.js` (routers) — before `portalRoutes`: `app.use('/api/portal', portalAccountRoutes({ db, secret, config, payments, messenger }))`;
with the public routers: `billpayPublicRoutes({ db, secret, payments, messenger, config, fetchImpl })` under `/api/public`;
next to `onlineSchedEmbedRoutes`: `app.use(billpayEmbedRoutes())`; in the signed-in router: `api.use(billpayStaffRoutes({ db, config, payments }))`.
`App.jsx`: `const BillPay = lazy(() => import('./pages/public/BillPay.jsx'));` and `<Route path="/billpay/:slug" element={<BillPay />} />`.
`db.js`: `BILLPAY_TABLES` from `billpay.js` at the end of SCHEMA. Until then `server/test/ptmount.js` / `e2e/lib/portal-app.mjs`
add them for tests, and the client e2e build adds the route in memory:
`cd client && ../node_modules/.bin/vite build --configLoader native --config /tmp/claude-0/vite.portal.config.mjs`.
