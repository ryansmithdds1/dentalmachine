# Automation pass (W8)

Efficiency Principle 8: *if a task can happen automatically in the background, it should; the UI shows only the
exceptions that need a person.* This pass went through the jobs in `server/src/index.js`, the 54 workflows and the
feature specs, looking for three things: job code that should already cover a step but doesn't (not mounted, off
for no safety reason, silent on failure), manual buttons that could be a background job, and lists a person has to
open and check when the system could raise only the exceptions.

Every automated action added here runs as the automation actor (`cluster.js` `track` / `withActor`), is
idempotent (one open item per dedupe key; counts go up instead of duplicating), is audited (`automation.raise`,
`automation.resolve`, `job.failed`, `job.recovered`, `document.expiry_reminder`), raises a Needs attention item when
it breaks and resolves it on the next good run, and never takes a high-risk action: nothing here posts money,
sends a claim, writes off, refunds, or changes a chart, punch or visit.

## What was done

| Step | Today (before) | What runs on its own now | Safety limits | Status |
|---|---|---|---|---|
| Any background job failing (all 38 jobs in `index.js`) | Logged and sent to error reporting only; an office could go days without reminders, ERA posting or backups and nobody on the team would know (rule 12) | `cluster.js` reports every run to `jobhealth.js`: a failure opens **"Background work stopped with an error: …"** (kind *Background work*, administrator, high) in every practice on the server; the next run that works closes it | The item never copies the error text (it can name another practice's patient); raised at most every 10 min per job; resolve check only runs after a failure or once after start-up | **Done** |
| #44 Forgotten clock-out | Raised only when a manager happened to open Time clock → Today | Hourly `auto-watch` job raises the same item (`timeclock-open:<punch>`, same wording, so no duplicates) for a punch open from an earlier day or > 14 h; resolves it when the punch is closed any way | Read-only: never closes or edits a punch (payroll time is HIGH_RISK); the fix stays in Time clock → Corrections | **Done** |
| #42 End of day: completed work for insured patients not on a claim | A line on the close page someone has to open | **"N completed procedures for insured patients are not on a claim"** (billing) for work done before yesterday, last 30 days; resolves when billed | Never creates or sends a claim (`createClaim` / claims are HIGH_RISK); zero-fee work ignored; voided claims don't count as billed | **Done** |
| #42 / #24 Claims made but not sent | "Ready to send" filter and a close-page line | **"N claims were made but not sent"** (billing) once a draft is over a day old; resolves when sent or voided | Read-only; sending stays B / the claim screen | **Done** |
| #42 / #3 Visits left open | A close-page line | **"N past visits are still open"** (front desk), last 30 days; resolves when each is completed, cancelled or marked no-show | Never completes a visit (that posts charges) or marks a no-show (releases procedures) | **Done** |
| #42 Cash and checks not on a deposit | A close-page line | **"N cash and check payments from before today are not on a deposit"** (billing), only for offices that record deposits at all | Read-only; deposits are HIGH_RISK and stay manual | **Done** |
| #38 Pre-authorization with no answer | Nobody tracked it after sending | **"N pre-authorizations have had no answer for 30+ days"** (billing); resolves when answered | Read-only | **Done** |
| #48 Credit balances waiting for a refund | The Credits & refunds queue, if someone opens it | **"N accounts have held a credit for 30+ days with nothing booked"** (billing), pointing at the queue, which is the ready-to-approve list | Nothing is refunded or moved; a credit with a visit booked is treated as a prepayment | **Done** |
| Office licences and contracts expiring | The renewal to-do was made only when someone opened Office documents | The hourly job makes it (60 days ahead, one per expiry date) | Made once even if the job and a person run it at the same moment (row lock); each to-do is audited | **Done** |
| The new hourly pass itself | — | One practice's failure becomes its own *"The hourly check for loose ends stopped"* item; the other practices are still checked | — | **Done** |

Switch: `AUTO_WATCH=off` turns the hourly pass off (like every other job). Code: `server/src/autowatch.js`,
`server/src/jobhealth.js`, hook in `server/src/cluster.js`, wiring in `server/src/index.js`. Tests:
`server/test/automation-pass.test.js`.

## Already automatic (checked, nothing to add)

| Workflow | Job |
|---|---|
| #13 Confirm, #19 no-show texts, #26 ASAP fill, #30 forms, #43 review requests | `reminders` tick (`runReminders`, `runRecallSequences`, `runFormSends`, `runPaperworkSafely`, `runCampaigns`, `runFillOffers`) |
| #20 Eligibility / IV verification | `eligibility`, `verification` (only with a real-time or sandbox clearinghouse — a manual clearinghouse can't answer in the background) |
| #24 / #33 acknowledgments, rejections, ERAs, secondaries | `clearinghouse-poll`, `eob-autopilot` |
| #35 Lab cases late | `readiness` |
| #36 Huddle, #49 reports | `digests`, `scheduled-reports` |
| #37 Recall / unscheduled treatment | `cadence` |
| #41 Referrals | `referrals` |
| #42 Deposits to the bank | `deposit-watch` |
| #45 Claims due a call, #51 duplicates, #54 books not closed | `monthly-work` |
| #52 Stock at the reorder point | a to-do when stock falls to it (`inventory.js`, event-driven) |
| #53 Approved fee changes | `fee-changes` |
| Chart audit (unsigned notes, missing codes) | `chart-audit` |

## Proposed — needs the owner's decision

| Step | Today | What could run on its own | Why it needs the owner | Status |
|---|---|---|---|---|
| #24 Send clean claims / draft claims for unbilled work | A person presses B at checkout; drafts wait under Ready to send | End of day: draft a claim for each insured visit's completed work and send the ones that pass every check; failures stay drafts (already raised above) | Claims are HIGH_RISK and `createClaim` is guarded by `requireHuman`; submitting to a payer can't be taken back, only corrected or voided. Should be a practice switch, off until the owner turns it on | Proposed |
| #45 Claim status checks | "Check status" button per claim (`POST /claims/:cid/status-check`, 276/277) | For claims due a follow-up call, ask the payer first with a real-time clearinghouse; only the ones still unanswered go on the call list | Real-time 276s usually cost per transaction; the owner picks whether and how often. The route's logic would move into a module the job can share | Proposed |
| #47 Monthly statement run | "Send statements" by hand; the spec says a scheduled run isn't built | On the practice's statement day, prepare the run (who, how much, mail/email/text) as a ready-to-approve batch; one key sends it | `/statements/run` is HIGH_RISK (bills patients); the owner sets the day, the minimum balance and who's held back | Proposed |
| #33 ERA auto-posting and patient billing after insurance | Built, switch off by default (`eob_autopilot` settings) | Clean lines post and balances are billed with no person | Posts money; off by default **for a safety reason** — the owner turns it on | Owner's switch (keep) |
| #37 Recall texts, #30 paperwork autopilot, #43 review requests, surveys after visits | Built, off by default (`recall_auto`, `paperwork_autopilot`, `review_requests`, `auto_after_visit`) | Messages go out on their own | Texting patients needs their consent and the office's wording and sending hours; off by default for a real reason | Owner's switch (keep) |
| Nightly backups | Only when `BACKUP_DIR` is set (production then insists on an encryption key) | Backups on by default | Where patient data is written and who holds the key is a hosting decision. Suggest: production preflight **warns** when `BACKUP_DIR` is unset | Proposed |
| #48 Refunds, #40 write-offs, #12 payments | By hand | — | Money out / write-offs: never automatic; the queue and the item above are the most the system should do | Not automated (by design) |
| #7 Notes, #8 charting, #15 medical history, #21 treatment | By hand; chart audit flags gaps | — | Clinical records and diagnoses: AI and automation only draft or flag | Not automated (by design) |
| #31 Insurance card read, #51 merges, #27 identity | A person confirms | — | Patient identity and insurance changes need a person | Not automated (by design) |
| #52 Placing supply orders | A to-do at the reorder point, ordering outside the app | Order from the supplier automatically | Spends money and needs a supplier integration (none yet) | Proposed (later) |
