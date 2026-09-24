# DSO / group of practices: central billing, lookup, reports, role templates

A group (`organizations`, `org_members`, `practices.organization_id`) is several practices under one owner
or DSO. `routes/org.js` covers joining, the rollup and copying setup. This page covers the central billing
office on top of it (`server/src/orgbilling.js` and `server/src/routes/orgbilling.js`, which `org.js` mounts)
and the Group page (`client/src/pages/Group.jsx` and `client/src/components/group/`).

## Who sees what

| Group role | Rollup and reports (totals) | Billing queues and patient lookup | Role templates, billing team |
|---|---|---|---|
| Viewer | yes | no | no |
| Viewer on the **billing team** (`org_members.billing = 1`) | yes | yes, if they also have `billing:read` in their own practice | no |
| Owner (must be an administrator) | yes | yes | yes |

- **Seeing is not the same as acting.** The queues and the lookup are read-only summaries across the group's
  practices. To work an item (post a payment, fix a claim, refund a credit), the person opens it **in its own
  practice**, signed in there, with that practice's normal permissions. Rows at any other practice come back
  with `can_open: false` and no link, and the screen shows them as read-only. Every staff account belongs to
  one practice, so there is no silent "act as another practice".
- The server works out the member practices itself (`groupAccess`), and every query filters by
  `practice_id IN (…)` over that list, with joins repeating the practice match. A `practice_id` filter from
  the client must be one of them (otherwise 404). Practices that leave the group drop out right away, and so
  do their people.
- People held to some offices (`users.location_ids`) can't use central billing, because it covers every office.
- Only owners can put someone on the billing team (`PUT /org/members/:uid {billing}`, audited before and after).

## Billing queues: `GET /org/billing/queue?queue=…&practice_id=&assigned=all|me|unassigned&min_age=`

| Queue | Rows | Amount | Age from |
|---|---|---|---|
| `outstanding` | claims submitted or partly paid | insurance still expected (estimate − paid) | submitted |
| `denied` | denied claims | the amount at stake | the last clearinghouse or payer update |
| `unsent` | draft claims | the estimate | created |
| `era` | ERA lines that were `unmatched` or `needs_review`, until the ERA's Needs attention item is resolved | the amount paid on the line | payment date |
| `credits` | patients whose ledger `SUM(amount)` is below zero | the credit | the last ledger entry |

Each row has a practice, patient, amount, age, details and who's working it. `GET /org/billing/summary` gives
the counts, amounts and claim age bands for each practice (the overview tiles). Balances always come from the
ledger. Nothing is stored.

**Assignment:** `POST /org/billing/assign {keys, user_id|null}`. Keys are `claim:<id>`, `era:<import id>:<line>`
and `credit:<patient id>`. The item's practice is looked up on the server and must be in the group. The
assignee must be on the billing team. Repeating the same assignment changes nothing. Each call is audited in
every practice it touches (`org.billing_assign`). The data is kept in `org_assignments`, one row per item per
group, which is only for routing work.

## Patient lookup: `GET /org/billing/lookup?name=&dob=&phone=`
You need two of name, date of birth and phone, or a first and last name, or a full phone number. This is so
the search finds one person, not a list to browse. It returns practice, name, date of birth, phone, balance
(from the ledger), open claims and last visit, all read-only. It writes an audit entry in the searcher's
practice (the fields used and the number of results) plus one `org.patient_lookup` entry for each patient
shown, in **that patient's practice**, with `patient_id` set. That way each practice's own log shows who in
the group looked at its patients.

## Reports: `GET /org/reports?from=&to=&practice_id=` and `/org/reports.csv`
Each practice's figures side by side:

- production, collections and collection %
- A/R aging (current, 31–60, 61–90, 90+, total, as of the end date)
- new patients
- treatment presented and accepted, and case acceptance %
- hygiene visits, reappointed, and reappointment %

The figures come from the practices' own code: `practice_numbers`, `agingReport`, and the reappointment rule
from `growth.js`. Group totals are sums of the practice figures. Rates are recomputed from the summed parts,
never averaged. Any group member can see the reports, because they're totals only. The CSV export is audited
(`org.report_export`).

## Role templates (owners)
`/org/role-templates` stores a name, a base role (never admin) and permissions from `PERMISSION_CATALOG`. To
apply one, use `POST /org/role-templates/:id/apply {user_ids, reason}`. It checks that everyone is active, at a
member practice and not an administrator. Then, in each practice, it creates (or updates) a custom role linked
by `custom_roles.org_template_id`, sets each person's role and custom role, clears their per-person overrides
and ends their sessions. Every change is audited in the person's practice with before and after and the reason
(`org.role_template_apply`, `role.create`/`role.update`).

Editing a template's permissions carries the change to every linked role. Templates are retired
(`POST …/retire`), never deleted. Applying or editing a template is refused (428) for the assistant or other AI
unless a person approved it (`requireHuman`). It is a candidate for `HIGH_RISK` in `aiguard.js`.

## Tests
`server/test/orgbilling.test.js` covers a group of two practices plus one outside practice: queues and filters,
403s, assignment, lookup auditing, report totals checked against ledger sums, and role templates.
`e2e/workflows/dso.test.mjs` covers the Group page: tiles, J/K/Enter in the queue, M to assign, lookup and
reports.
