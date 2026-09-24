# BL · Billing that runs itself, and never goes silent (backlog BL1–BL5)

**Budgets:** set up a payment plan or recurring charge with the card on file, agreed on screen, in **≤ 4** staff
actions (Set up payments → Show the terms → type the name → Agreed) · send it to agree by text link in **≤ 4**
(Set up payments → Show the terms → By link → Send) · the patient updates a card from the link in **2** (type card /
Stripe page → Save) and agrees to a set-up in **≤ 4** (add card → type name → tick → Agree) · retry a declined payment
or text the update-card link in **2** from Billing autopilot → Declined · stop retries in **3** (type why → Stop) ·
add an offered fee to an account in **2** (choose → Add) · waive a fee in **3** (Waive → reason → Enter) · check a
day with the processor again in **1**. Every step works from the keyboard (Tab / Enter; the tabs are in Ctrl/⌘K as
"Billing autopilot: …"). Money, dunning, fees and isolation are tested by `server/test/billingauto.test.js`
(SQLite and Postgres); the click budgets get an `e2e/workflows/BL-billing.test.mjs` once the page is mounted.

## Where things live
- Server: `server/src/billingauto.js` (all the rules), `server/src/routes/billingauto.js` (staff routes and the
  patient's links). Existing modules call into it: plan autopay (`payments.js runAutopay`), memberships
  (`memberships.js`), ortho (`ortho.js`), online payments (`billpay.js takePayment/postOnlinePayment`), the Stripe
  webhook (`routes/payments.js`) and receipts (`receipts.js`).
- Client: `pages/BillingAutopilot.jsx` (the office's screen), `components/billing/SetUpPayments.jsx` (the side
  panel), `components/billing/BillingActivity.jsx` (on the patient's account), `pages/public/BillingLink.jsx` (the
  patient's link), and the fee disclosure in the shared portal / Pay my bill form (`PortalAccount.jsx PayForm`).
- Tables (`db.js`): `billing_settings`, `billing_fees`, `billing_fee_charges`, `billing_authorizations`,
  `recurring_charges`, `billing_attempts`, `billing_dunning`, `billing_links`, `billing_notices`, `billing_disputes`,
  `billing_recon_days`; columns `payment_methods.funding`, `payment_requests.fee_amount / fee_kind`.

## BL1 · Set up payments (one step)
From the ledger, checkout, an accepted treatment plan or the account panel: **Set up payments** opens a side panel.
- Choose: payment plan (total — default what's owed after insurance —, down payment, months, day of the month),
  recurring charge (an amount each month, never more than the account owes, optional number of payments or end
  date), or autopay for an existing membership / ortho contract.
- Choose the card on file (tokenized at the processor; we keep brand, last 4, expiry and credit/debit only).
- **Show the terms**: `POST /billing/setup/preview` returns the exact words, the schedule, the set-up fees, the late /
  returned-payment fees that can apply, the surcharge (if any) and the retry schedule, with a fingerprint.
- The patient agrees **on screen** (the name typed; the down payment is charged first — a decline sets nothing up) or
  **by link** (text/email; the plan starts when they add a card and agree). `POST /billing/setup` refuses anything
  whose fingerprint differs from what was shown (409) and is idempotent (the same terms again → the same result).
- The signed authorization keeps the words, their hash, who agreed, how (screen / link), when, IP and device; it is
  never edited — stopping automatic payments revokes it with a reason (`POST /billing/authorizations/:id/revoke`).
- **One list**: Billing autopilot → Automatic payments (`GET /billing/active`): every payment plan, membership,
  ortho contract and recurring charge with the next date and amount, the card (flagged when it's expiring), whether
  a signed OK is on file, and its status (ok / past due / retrying / paused); plus the set-ups waiting for the patient.

## BL2 · Automatic and posted
- Each charge runs on its date through `trackedCharge` (a `billing_attempts` row per idempotency key: visible on the
  account). The ledger payment is keyed by the processor's charge id (`postPaymentOnce` / the runners' checks), so a
  retry, a lost answer or a webhook replay posts it once. Receipts go out as for any autopay (`autoReceipt`).
- **Daily check** (hourly job, once per practice-day, `reconcileDay`): yesterday's card charges at the processor vs
  the ledger (`reconcile.js`) and the processor's payouts (every charge paid out must be on a ledger; a payout must
  add up when the processor account is this practice's alone). Each difference becomes a Needs attention item
  (billing); checking the day again resolves what now matches. Sandbox has no processor to compare with.

## BL3 · Never silent (dunning)
A declined automatic charge (plan, membership, ortho month, recurring):
1. posts nothing; 2. opens `billing_dunning` and a Needs attention item for billing (`dunning:<type>:<id>`);
3. texts/emails the patient a secure **update your card** link (`/billing-link/:token`, 30 days, only its hash kept);
4. is retried on the practice's schedule (default days **3, 7, 14** after the first decline; Settings) — never in
   between, unless the card is changed; 5. after the last try it **pauses** (plan autopay paused, recurring paused),
   the item turns high priority with next steps (call script, send a statement, collections after 30 days), the team
   gets one task, and the patient is told again.
- A new card from the link (or staff choosing another card, `POST /billing/replace-card`) replaces the old card on
  everything that used it and retries straight away; success closes the dunning and resolves the item. Paid at the
  desk (membership "settle", nothing due on the plan) or the plan ending also closes it.
- Staff: Retry now, Text the link again, Restart retries, Stop retries (with a reason) — Billing autopilot → Declined.
- **Expiring cards**: cards used for automatic payments that expire within 30 days (setting) get one update-card
  request per card and expiry (`billing_notices`); the list is on the Expiring cards tab.
- **Disputes** (`charge.dispute.created`): the payment is reversed on the ledger (a reversing entry, `reverses_id`),
  a high-priority item says what to send and by when; won → the payment is restored; lost → the reversal stands and
  the office's returned-payment fee applies if it's automatic. **Refunds made at the processor** (not from here)
  post once as refunds (`refund_of_id`) with an item to check them. Each once, by the processor's id.
- Every step is on the patient's account (`GET /patients/:id/billing-activity`, `BillingActivity.jsx`).

## BL4 · Merchant services
One adapter (`payments.js`): Stripe (with sandbox mode) is the only processor for now (owner's choice); the others
dental offices use are listed as "coming later" so adding one is a new adapter. Card readers, text-to-pay and online
payments use the same adapter. New adapter calls: `listPayouts` (daily check), `cardSetupUrl` metadata (the patient's
link), `funding` on saved cards; refunds made from here are marked so the webhook doesn't post them twice.

## BL5 · Passing card costs on, and office fees
**Card costs** (administrator, Billing autopilot → Card costs & retries):
- Off, a **surcharge on credit cards** (%), or a flat **convenience fee** for paying online.
- Surcharge: never on debit or prepaid cards (unknown funding counts as debit), never on bank payments, at most the
  card brands' 3%, the state's cap (CO 2%), and never more than the office's own processing cost (entered). Refused
  in states that ban it (CA, CT, MA, ME, OK, PR — the list is in `billingauto.js STATE_RULES`; confirm with your
  processor). Requires confirming the processor was told (card brands: 30 days' notice).
- Convenience fee: online payments only (portal, Pay my bill), never automatic payments or at the desk.
- **Disclosed before payment**: the portal and Pay my bill show the rule; the server answers a payment with a fee
  with 409 + the exact fee and words until the page sends back the fee it showed (`fee_ack`). Automatic charges add a
  surcharge only if the patient's signed authorization disclosed it (and only on a credit card).
- **On the receipt**: the fee is its own ledger line (`Card surcharge` / `Convenience fee`, same processor id); the
  receipt PDF and message say "Includes card surcharge $x".
**Office fees** (administrator): name, fixed $ or % of what's collectible (half-up, in basis points), when it applies
(plan set-up, late plan payment after grace days, returned payment, missed appointment, each statement, or by hand),
automatic or offered, minimum, cap, times a year per patient, waivable or not. Each posts once per occasion as its
own ledger line (`adjustment`, `Office fee`), shown in the set-up terms before the patient agrees. The basis for a %
fee: the plan total (set-up), the late installment (late fee), the returned payment, the statement amount, else the
account's balance after insurance. Waiving needs a manager (deposits:manage) or administrator and a reason, and is a
reversing entry, audited; a fee marked not waivable can only be reversed by an administrator.

## Rules kept
Ledger only (integer cents), posting keyed by processor ids / unique keys, reverse don't edit, permissions
(billing:read to see, billing:write to set up / retry / add an offered fee, manager to waive, administrator for
settings and fees), AI can't take money actions (`requireHuman` in every money function; routes for `HIGH_RISK`),
outside calls through the adapter's `loggedFetch`, sandbox mode, practice isolation (every id checked against the
practice), SQLite and Postgres.
