# 25 · Attach x-rays or narratives to claims

**Budget: 2 actions.** Measured: **2** (Attach 1 suggested → Send 1 to the payer). Tested by
`e2e/workflows/21-22-23-25-28.test.mjs`.

## Trigger and who does it
The billing coordinator sending crowns, root canals, SRP, surgical extractions or implants — payers deny them
without a pre-op film, perio chart or narrative.

## Data needed
The claim's procedures (code, tooth, date of service), the patient's x-rays (tooth, date taken) and perio exams,
and what the validator says payers want (`attachmentHints` in `server/src/attachments.js`).

## Today (from the audit)
~7 actions per attachment: "+ Attachment", pick the kind, pick a document from every file in the chart (not
filtered by tooth or date), Add, repeat, Send. The validator knew what was missing but attached nothing.

## Target
The Attachments card shows **"Payers usually want: X-rays of #30 · Periodontal chart"** with the matching files
listed and the best ones **already ticked**; **Attach n suggested** (or **A**) attaches them all at once (Undo
takes them off while unsent), then **Send n to the payer**.

## What gets automated
`GET /claims/:cid/attachments/suggest` (billing:read):
- **Which kinds** — a kind is needed when adding it would clear one of the validator's warnings (so the validator
  drives it; nothing is duplicated).
- **X-rays** — films of the claim's teeth taken from a year before to 30 days after the date of service; the newest
  film per tooth is ticked; a full-mouth film (no tooth) is offered and ticked only for a tooth with no film;
  films of other teeth and older films are left out.
- **Perio** — perio exams in the same window; the newest is ticked. On attaching, the exam is filed in the chart as
  a PDF perio chart (`documents.source = perio:<id>`, reused next time) and attached as P6.
`POST /claims/:cid/attachments/batch` (billing:write): checks every item first (the patient's own documents and
exams, in this practice), skips anything already attached (a repeat is harmless), audits each
`claim.attachment_add`.
- **Narratives** stay AI-drafted with human approval: "Draft the narrative with AI" fills the box for a person to
  read and edit; the draft now knows which x-rays are on file and attached; it's audited as an AI draft
  (`drafted_by: 'AI'`), and attaching it records the person as approver.

## Edge cases
Nothing on file in the window → a plain note saying what to take (an x-ray of the tooth, a perio chart) or to add a
narrative. Paid/void claims → no suggestions. More than 20 at once → refused.

## Acceptance
- e2e: 2 actions; the film of #30 is attached, not the film of #3.
- `server/test/efficiency3.test.js`: which films are suggested/preselected (tooth, window, full-mouth), perio
  chart filed and attached, validator warnings cleared, repeat adds nothing, other practice's documents and
  claims 404, assistant 403 (no billing), dentist can't attach (no billing:write).
