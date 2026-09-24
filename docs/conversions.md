# Data conversions

**Settings → Import from another system** converts a whole practice from Open Dental, Dentrix, Eaglesoft or Curve.
The screen walks through five steps: choose the system → upload the export → check (dry run) → import → reconciliation.

| Source | What the office uploads | Code |
| --- | --- | --- |
| Open Dental | The MySQL backup (`.sql`), read in the browser | `server/src/conversion/opendental.js`, `client/src/conversion/sqldump.js` |
| Dentrix | `.zip` of the Office Manager / Data Extract lists (CSV or tab-delimited) | `server/src/conversion/dentrix.js` |
| Eaglesoft | `.zip` of Patterson's data export (one CSV per Eaglesoft table) | `server/src/conversion/eaglesoft.js` |
| Curve | Curve Hero's export `.zip` (JSON or CSV per entity; zips inside are read) | `server/src/conversion/curve.js` |

Dentrix, Eaglesoft and Curve share one pipeline (`server/src/conversion/pipeline.js`, `common.js`). Each vendor
module only says how that system names its files and columns and what its values mean; everything else is common.

## How it works

1. **Read in the browser** (`client/src/conversion/exportzip.js`). The zip is opened with the browser's own
   `DecompressionStream` (no library). CSV / tab / pipe files and JSON are read; nested JSON is flattened
   (`address.line1`), and a list inside a record (a perio chart's teeth) becomes one row per item.
2. **Plan** — `POST /api/imports/convert` with each file's name and headers. The server matches every file to one of
   the standard tables in `common.js` — by the vendor's file names first, then by its columns — and answers with the
   columns it uses. **Only those columns are sent**; SSNs and anything else unknown never leave the computer. Files it
   doesn't recognise are listed on screen as "not a file we read".
3. **Stage** — `POST /api/imports/convert/:id/rows`, in chunks. Rows are held in `conversion_rows` (scratch; deleted
   when the import finishes or is cancelled) as standard fields.
4. **Dry run** — `POST /api/imports/convert/:id/check` (optionally with the office's `mapping`). Every row is read
   exactly as the import would read it, and nothing is written. The answer has, per step, the source count, new,
   updates, left out (with reasons and examples) and problems; the accounts receivable (what the old system showed, what
   can be placed on a family, and what can't); and the **unmapped values** with the choices for each. Staging more rows
   means checking again; the import refuses to start until the latest data has been checked.
5. **Import** — `POST /api/imports/convert/:id/run`, a slice at a time (each call ~15 s, resumable) in this order:
   providers, chairs, patients, families, insurance, appointments, treatment, recall, notes, perio, balances.
   The requests run as the **`import` actor** ("Dentrix conversion #12 (started by …)"), so every record created or
   changed is in the audit log with its before/after.
6. **Reconciliation** — when it finishes, per step: in the source, brought over, left out, and how many records from
   this system are in the database now; and the A/R total against the sum of the balance-forward entries actually
   posted. Anything left out (or a balance that doesn't match) is raised in **Needs attention**.

`POST /api/imports/convert/:id/cancel` drops a conversion before it runs. After it runs, **Undo** in the import
history removes what it created, until those records have been used.

## Standard tables

| Table | Becomes | Notes |
| --- | --- | --- |
| providers | providers | Matched to existing ones by NPI, then name; otherwise created. |
| operatories | operatories | Matched by name. |
| patients | patients | Keyed on the chart number (Dentrix) / patient ID. Dentrix's internal Patient ID also finds the patient. |
| (patients.guarantor) | `patients.guarantor_id` | Followed to the family head; a guarantor not in the export leaves the patient as their own. |
| carriers, plans | lookups for insurance | Eaglesoft `insurance_company` / `employer`; Curve `carriers` / `plans`. |
| insurance | carriers, plans, policies | Primary and secondary dental only; medical/tertiary is listed as left out. |
| appointments | appointments | Length from a minutes column or start/end. Past "scheduled" visits come in completed. |
| codes | lookup for treatment | Eaglesoft `services` (service code → ADA code). |
| procedures | procedures (+ one treatment plan per patient for planned work) | **History without charges.** Conditions, declined, deleted and referred-out work are left out. |
| recalls | recalls | |
| notes | clinical notes | Brought in signed, with "(From Dentrix)" etc. |
| perio | perio exams | One reading per row (type + DB, B, MB, DL, L, ML) or one row per tooth with six values in a cell. |
| balances | one balance forward per family | Aging / responsible-party file (total, or the buckets added up). |
| ledger | — | Only used to add up a family's balance when there is no balance file. Never posted. |

## Balances

The ledger is the source of truth, so history is **not** re-posted: each family gets one "Balance forward"
adjustment on the guarantor equal to what the old system showed. Where it comes from, in order:

1. a balances / aging / responsible-party file (family level);
2. balance columns on the patient file — a family balance on the guarantor's row (Dentrix), or each patient's own
   balance summed per family (Curve);
3. otherwise the ledger export added up by transaction type (charges up, payments/credits down, "signed" types as given).

Balances on accounts that aren't in the patient file (or whose patient isn't brought over) are listed with their
amounts — the A/R total always includes them, so the difference is visible. A corrected re-import **voids** the old
balance forward and posts the new one (never edits it).

## Mapping tables

Each vendor module holds its value tables with comments: patient status, appointment status, procedure status,
ledger transaction type, relationship to subscriber, coverage order and provider type (Eaglesoft also turns old
5-digit service codes like `01110` into `D1110`). A value that isn't in the table is reported in the dry run with
its row count and what happens until someone chooses:

| Kind | Choices | Until chosen |
| --- | --- | --- |
| Provider (an ID not in the provider file and not matching a name) | any of the practice's providers, or none | the patient's provider / first dentist |
| Patient status | active, inactive, archived, skip | active |
| Appointment status | scheduled, confirmed, completed, no show, cancelled, skip | scheduled |
| Procedure status | planned, completed, skip | left out |
| Procedure code (not a CDT `Dnnnn` code) | a CDT code, or skip | kept as the old system's code (inactive, not offered for new work) |
| Ledger transaction type | charge, credit, signed, ignore | left out of the balance |
| Relationship / coverage | self, spouse, child, other / primary, secondary, skip | other / primary |

Choices are validated on the server (a provider must belong to the practice; a code must be `D` + four digits) and
saved with the conversion.

## Re-importing a corrected export

Every record remembers its old ID in `external_ids` (per practice and source). Importing again:

- patients, appointments, providers, chairs, insurance and recall are **updated** (before/after in the audit log);
- planned treatment follows the export (fee, tooth, surfaces, or moved to completed); completed history and signed
  notes are left as they are;
- the family balance forward is replaced (old one voided) only if it changed.

## Adding another system

Write a module like `dentrix.js`: `files` (file-name patterns → standard table), `fields` (its column names per
table, tried before the generic ones), `fileDefaults` if a file implies a value, and the lookup tables. Add it to
`VENDORS` in `pipeline.js` and the picker in `client/src/components/FullConversion.jsx`, and add a fixture test in
`server/test/conversion-vendors.test.js`.
