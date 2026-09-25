# Cash handling and deposits — how Dental Machine protects the practice's money

This is for the practice owner. It explains, in plain words, the controls built into **Deposits and cash** and what
each one guards against. Most embezzlement in dental offices is small and steady: cash that never makes it to the
bank, a balance quietly written off after the patient paid in cash, a refund to nobody. These controls make each of
those hard to do and easy to see.

## 1. Every day's money has one deposit, checked against the ledger
- At close, the team builds the day's deposit from what the software says was taken: every check listed on its own
  (who it's from, check number, amount) and the cash counted bill by bill.
- The screen compares the bag with the ledger. When they match you get a green check. When they don't — cash
  short or over, or a payment held back for tomorrow — the person must write **why** before they can submit. You see
  every one of those reasons.
- Card batches and insurance EFTs are not in the bag; they are tracked separately from the card processor and the
  insurance payment files.

## 2. Once submitted, a deposit is locked
- The deposit records who prepared it, the bag or slip number and the time. Nobody can edit it afterwards.
- If something was wrong, a **manager reopens** it with a reason. The original stays on record (marked reopened)
  and a corrected deposit replaces it. You can always see both.
- The slip prints as a PDF, and a photo of the bank-stamped slip can be added from a phone or tablet. Photos are
  stored encrypted, like patient documents, and can't be removed.

## 3. A second person verifies
- The person who prepared a deposit **cannot** verify it. A manager (or you) checks the bag against the slip and
  signs off. The same goes for cash drawers: the person who counted can't verify their own count.

## 4. Every deposit is followed to the bank
- With the bank connected (Finance → Connections), deposits are matched to the bank's deposits automatically.
  Each one moves from **Submitted** to **In the bank** to **Reconciled**.
- If a deposit hasn't reached the bank after a few business days (3 unless you change it), or the bank shows a
  different amount, it appears in **Needs attention** until someone deals with it — and it goes away by itself
  once the bank shows it or a manager records what happened.

## 5. Cash drawers with a float and a blind count
- Each desk that takes cash has a drawer. It's opened with a starting float (normally what was left in it last
  time; a different amount is flagged).
- At close, the drawer is counted **blind**: the person counting does not see how much should be there until after
  they submit their count. That makes "counting to the expected number" impossible.
- Any over or short is recorded with a reason when the second person verifies. Big ones are flagged for you
  (the threshold is $5 unless you change it).

## 6. Numbered cash receipts
- Every cash payment gets the next receipt number for its office. Numbers are never reused or skipped, so a gap
  would stand out; a voided payment keeps its receipt, marked voided, where you can see it.
- Tip: tell patients they should always get a receipt for cash, and post a sign saying so at the desk.

## 7. Cash voids, refunds and discounts need a manager
- Voiding a cash payment, refunding in cash, and giving a discount on an account the same person just took cash
  from all need a manager, and each is recorded with who approved it.
- A payment that's already on a submitted deposit can only be voided by a manager, and the deposit is flagged.

## 8. Separation of duties
- The classic scheme is: take the patient's cash, write the balance off with an "adjustment", and be the one who
  prepares the deposit. When one person took payments on an account, posted an adjustment on that same account and
  prepared the deposit, the deposit shows a warning and it appears in your report. A softer note shows when one
  person took all the cash and prepared the deposit (common in small offices — that's what the second person is for).

## 9. Your Cash integrity report (owner only)
Deposits and cash → **Cash integrity** shows, for any period:
- drawer over/short by person, and week by week;
- cash payments voided and cash refunds, who did them and which manager approved;
- adjustments and write-offs by person;
- deposits that were late to the bank (or still aren't there), and every difference with its reason;
- voided receipts, reopened deposits and float changes;
- separation-of-duties warnings.
Opening the report is itself recorded. Everything above is also in the audit log with who, what, when and why.

## 10. Gift certificates and product sales
- **Products** (toothbrushes, whitening kits) are set up by an administrator in Settings → Products & gift
  certificates, with the practice's sales tax rate. A sale posts a charge on the patient's account (and a separate
  sales-tax line), takes the item out of Supplies stock, and is voided — charge, tax and stock together — never edited.
- **Gift certificates** (Account → Gift certificates) are money paid in advance that belongs to whoever holds the
  certificate. The buyer's payment is on their account (so it reaches the day sheet and the deposit like any payment)
  with an equal "Gift certificate sold" line holding it — their balance doesn't move and it is not their credit, so it
  can't be refunded as a credit. Using one posts a "Gift certificate redeemed" line on the patient's account, never
  more than the certificate holds or than the account owes (a certificate is never cashed out).
- What each certificate still holds is worked out from those lines; the **outstanding** total on the Gift
  certificates page is what the practice owes holders (a liability for your accountant). Expired-but-unused amounts
  are shown separately: check your state's unclaimed-property rules.
- Voiding a certificate (sold by mistake or returned) needs a manager, only works while nothing has been used, and
  reverses the payment — give the money back the way it was paid. A redemption on the wrong account is voided from
  the ledger and the certificate gets the amount back. Every sale, use, look-up, print and void is in the audit log.

## Good habits that the software can't do for you
- Rotate who counts and who verifies; make sure everyone who handles money takes real time off.
- Take the deposit to the bank every day, in a sealed bag, and keep the stamped slip (photograph it here).
- Look at the Cash integrity report at least monthly, and ask about anything you don't understand.
- Give the "manager" permission (verify, reopen, approve) only to people who don't take payments every day, if
  your team is big enough.
