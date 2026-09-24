# OF1–OF3 · Opportunity finder

**Budget: see a visit's opportunities in ≤ 1 action from the schedule; add one in ≤ 1 more.** The badge on the card
("3 · $184") is one click (or **G** on a focused card) to the visit's list; **Add to today** is one click (or
Enter / A on the focused item). "Not today" is one click (N). Both undo from the toast (Ctrl/⌘Z).

## Trigger and who does it
The hygienist (and assistant, and the doctor at the exam) looking at today's patient: "is this kid due for
sealants? is fluoride covered? have we taken bitewings this year?" The morning huddle, for the day's upside.
The office manager sets the rules once.

## Data needed
Patient age (DOB), procedure history (completed, planned, on this visit), the chart (sealants, restorations,
decay, missing teeth), the latest perio exam (pocket depths), the latest caries risk, recalls, medical alerts and
recent notes (grinding), insurance (plan frequencies, age limits, waiting periods, percentages), office fees.

## Target
- **Settings → Opportunities** (`OpportunityRules`): starter rules in one click — sealants D1351 on unsealed
  permanent molars ages 6–15; fluoride D1206/D1208 every 6 months under 19, every 3 months for high-caries-risk
  adults; FMX D0210 every 5 years; bitewings D0274/D0272 yearly; pano D0330 every 5 years; perio maintenance D4910
  instead of D1110/D1120 after SRP; SRP D4341/D4342 per quadrant with 4 mm+ pockets; Arestin D4381 on 5 mm+ sites;
  night guard D9944 when grinding is noted; unscheduled treatment; overdue recall. Each editable inline; retire,
  never delete.
- **On the card** (`OpportunityBadge`): count · extra production. Column/day totals (`OpportunityTotal`).
- **The visit's list** (`OpportunityPanel`, in the appointment drawer): what, why (plain words: "Age 9 · Unsealed
  molars #2, #15 · Not done here before"), insurance ("Covered · patient pays about $0", "Not covered yet —
  eligible on 2027-03-01", "No insurance · patient pays about $45"), which teeth (toggle), Add to today / Not today.
- **Huddle** (`OpportunityDay`): the day's total, by rule, each visit's list (expand to add/decline), and this
  month's capture (offered → added → done, $).

## What gets automated
Every rule is checked when the visit is looked at — nothing to run. Frequencies use the last completed date of
any of the rule's codes (per tooth / per quadrant where the rule is). Insurance comes from the same estimate as
everywhere else (`estimateCoverage`), priced as of the visit date; "eligible on" is when the plan's frequency
window reopens (or the waiting period ends). Showing a visit's list records the offers; adding and declining
record the outcome; "done" is read from the procedures.

## Safety
- Suggestions only: adding plans the work (status planned, no charge) through the normal procedure fields and
  office fee; completing it still goes through the usual path. A replaced prophy is set aside as cancelled, not
  deleted, and comes back on undo.
- Add is idempotent (one row per visit and rule, claimed atomically): double clicks and retries add once.
- Practice- and office-scoped (visits outside someone's offices are 404). `clinical:read` to see,
  `clinical:write` to add or decline, administrators to change rules. Rule changes are audited with before/after;
  adds/declines/undos are audited against the patient.

## Acceptance
`server/test/opportunities.test.js`: each starter rule by age, history, frequency, chart conditions and perio
depths; insurance frequency limit → "eligible on"; add-to-visit idempotent (two at once); perio maintenance
replaces the prophy and undo restores it; day view totals; capture report; practice/office isolation;
permissions; rules retired not deleted.
