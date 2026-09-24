# Insurance autopilot — what posts by itself, and what never does

For the owner. The screen is **Insurance autopilot** (in the sidebar, or Ctrl/⌘K → "insurance").

## The one rule
An insurance payment posts by itself only when **every cent adds up**:

> what insurance paid + the PPO write-off + what the patient owes = what we billed

…for a claim we actually sent, for the procedures on it, with no denial, no money taken back, no overpayment, and —
if the plan has a PPO fee schedule in the system — the insurance allowed exactly what your fee schedule says.
If anything is off by even a cent, it waits for a person on the worklist, with the reason in plain words.

## What posts by itself
- **Electronic payments (ERAs)** that follow the rule — **only after you turn auto-posting on** (Settings). It starts
  **off**. Before you turn it on, the Settings tab shows what it *would* have posted over the last 30 days and whether
  its numbers matched what your team posted. Until then, clean payments wait in one "Post all" button.
- When one posts: the payment and the PPO write-off go on the patient's ledger (never edited — anything undone is
  reversed with a new entry), the claim closes, the secondary claim is drafted if there is one, and the history says
  "posted by the Insurance autopilot".
- **Billing the patient** — only after you turn it on (Settings): when a claim closes and the patient still owes at
  least your minimum, they get a text or email with a pay link (after the days you choose), reminders after 7 and 14
  days, and a paper statement in the mail if they haven't opened the link. It stops the moment they pay. Patients on
  a payment plan are never billed this way — their autopay charges as agreed. You can hold anyone (Billing patients tab →
  Hold a patient); a patient held from all messages on their chart (deceased, moved, don't contact) isn't billed either.

## What never posts by itself
- **Paper EOBs.** You scan or photograph them; the AI reads them into the same lines; **a person** presses "Looks
  right — post". The AI never posts money.
- **Denials** — you choose: bill the patient, appeal, correct and resend. (Denials the practice is responsible for,
  like a missed filing deadline, are never sent to the patient.)
- **Underpayments** (less than your PPO fee schedule), **overpayments** (you get a refund task), **payments taken
  back** by the insurance, **partial payments**, **lines that match no claim**, **odd adjustments**, interest and
  recoupments on the check.
- **Secondary claims** — drafted automatically, sent with one key (the primary's EOB goes with it).
- **Changing these switches** — only an administrator, and the assistant can't do it without your OK.

## Every day
The **Reconciliation** tab shows, day by day: what the insurance companies sent → what posted → what's waiting →
what reached the bank (when the bank feed is connected), and for closed claims: billed → paid → written off → the
patient's part → billed to the patient. Anything that doesn't line up becomes a **Needs attention** item and clears
itself when it's fixed.

## If something is wrong
Nothing is ever deleted. A posting can be reversed from the claim (Reopen) or from the worklist when the insurance
takes money back; every posting, decision and setting change is in the audit trail with who (or which automation) did
it and when.
