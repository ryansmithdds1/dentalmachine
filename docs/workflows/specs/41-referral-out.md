# 41 · Referral out letter

**Budget: 4 actions.** Built and measured by the referral tracker — [RT-referrals.md](RT-referrals.md), measured by
`e2e/workflows/RT-referrals.test.mjs` (create a critical referral: 3; close it with the specialist's report: 2). Not re-measured in the daily test.

## Measured path
Referrals board (or **Refer…** on the chart / treatment plan) with the patient active: **N** opens the referral,
**Send referral** (click or Ctrl/⌘+Enter) sends it — 2 for a routine referral, 3 when it's marked critical.

## Defaults
The specialist used last for this kind of work; the reason from the planned procedures; the letter by email when
the specialist has an address; a text to the patient.

## Keyboard path
N · Ctrl/⌘+Enter.

## Background automation
Letters send and are tracked (sent → scheduled → seen → report back); overdue ones become follow-ups.
