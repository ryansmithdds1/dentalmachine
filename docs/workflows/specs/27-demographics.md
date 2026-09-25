# 27 · Update demographics or contact info

**Budget: 3 actions** for one change. Measured: **3** for a new mobile number on the chart (E, type, Enter), **3** for
a new address from any screen (Ctrl/⌘K, "address 12 Oak St, Round Rock, TX 78664", Enter) and **3** by mouse on the
chart (click the address, type, Enter). Tested by `e2e/workflows/24-26-27.test.mjs`.

## Trigger and who does it
A patient calls or checks in with a new phone number, email or address (often a whole family moving); front desk
with `patients:write`. Billing staff can read but not change charts (403).

## Data needed
The patient (`GET /patients/:id`), `PUT /patients/:id` for single fields, and `PUT /patients/:id/address`
(`routes/family.js`) for an address, which also finds the household members who lived at the old address.

## Today (audit row 27, measured in the code)
**6** — Edit 1, find the field in a 30-field form 1, clear and type 1–2, Save 1, close 1. The address had four
fields (street, city, state, ZIP). A household's move meant repeating it for every chart. No inline edit, no
command-bar route, no undo.

## Target
| Start | Steps | Actions (measured) |
|---|---|---|
| Chart overview, mobile | **E**, type, Enter | **3** |
| Chart overview, address | **Shift+A** (or click it), type one line, Enter | **3** |
| Chart overview, any detail by mouse | click the value, type, Enter | **3** |
| Any screen, active patient | Ctrl/⌘K, "phone 512 555 0142" / "email …" / "address …" / "home phone …", Enter | **3** |
| Several details | Tab saves and moves to the next detail | +2 each |

Each detail on the Contact card is edited where it's shown — no window. Enter saves at once (optimistic), the toast
has **Undo** (Ctrl/⌘Z); Esc leaves it as it was; clicking away keeps what was typed (saved, with Undo). The command
bar previews the result before Enter ("Nia's mobile → (512) 555-0142 · Enter saves, Undo on the note").

## Smart defaults
- **Phone numbers** are tidied into (512) 555-0142 from any usual format (512.555.0142, +1 512 555 0142); a typo is
  caught before anything is saved.
- **The address is one line** — "12 Oak St, Round Rock, TX 78664" is split into street, city, state and ZIP; a street
  alone changes just the street.
- **The household moves too** — a new address also goes to everyone in the family file who lived at the same old
  address (matched ignoring case and spacing); members living elsewhere (a grown child at college) stay put.
- **New family members** start with the household's address.
- **A new number/email** clears the "can't get texts" / "bounced" flag, so reminders start going there again.

## Keyboard-only path
E (mobile) or Shift+A (address) on the chart, then Tab from one detail to the next; from anywhere, Ctrl/⌘K with
"phone …", "email …", "address …" for the active patient — the patient never has to be searched for again.

## Background automation
Household members are found and updated by the server in the same transaction; reminders switch back to texts
or email once a flagged number or address is replaced. Patients can also change their own details in the portal.

## Safety (CLAUDE.md)
- **Recorded with before/after** — single fields go through `update()` and the `patient.update` audit row carries the
  change; every chart an address change touches gets its own `patient.address` audit row with before, after and
  `household_of`. Undo sends the old values back through the same routes (recorded again), never edits history.
- **Validated on the server** — two-letter state, 5-digit ZIP (or ZIP+4), length limits, a real email; the patient must
  belong to the practice (404) and the office the person can see; `patients:write` (403 otherwise).
- **Idempotent** — sending the same address again changes and records nothing; an unchanged value isn't sent at all.
- An address with no old address never sweeps every address-less chart in the family along.

## Edge cases
- `household: false` changes one chart only (Undo uses it); `members: [ids]` narrows who moves.
- Not a phone number / not an email: an error toast, nothing saved, the field stays open to fix.
- The full Edit form is still there for rarely changed fields (name, birthday, guarantor, custom fields).

## Acceptance
- e2e: mobile 3 actions, saved as (512) 555-0142, Undo restores it, a typo isn't saved; address from the command bar
  3 actions and the child moves too, Undo restores both; address by mouse 3 actions, no modal; no dialogs.
- `server/test/efficiency-w3.test.js`: the household at the old address moves (not members living elsewhere), one audit
  row per chart with before/after, undo, `household: false` / `members`, repeat is a no-op; validation 400s, other
  practice 404, billing 403, signed out 401; phone/email change keeps before/after and clears the bad-number flag.


## Phase 2, batch 2A: more of the chart changes in place
The Contact card also holds the **office alert** (click, type, Enter — **3 actions**; the person who typed it isn't
shown the pop-up), the **usual dentist** and **usual hygienist** (click, pick — **1 action**, saved at once), all
with Undo and before/after in the change log. The **name** and **birth date** on the chart header are corrected
in place too (click, type, Enter — **3 actions**, Undo). A **family member** is added on one line on the Family tab
("Kit 6/6/2016" — the guarantor's last name unless another is typed; child under 26, spouse otherwise; **3
actions**). Tested by `e2e/workflows/2A-inline.test.mjs` and `server/test/inline2a.test.js`.
