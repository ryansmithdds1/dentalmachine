# I · Office intranet (links, office manual, announcements, onboarding)

**Budget: open a link from anywhere ≤ 2 actions** (Ctrl/⌘K → Enter, after typing part of its name — e.g.
"delta" → "Open Delta Dental portal"). Open an office manual page from anywhere: Ctrl/⌘K → type → Enter.
Acknowledge a page or announcement: 1 action. Tested by `server/test/intranet.test.js` (server rules) — a
Playwright workflow test is still to be added in `e2e/workflows/`.

## Trigger and who does it
Everyone, many times a day: the front desk opening an insurance portal, an assistant checking the
sterilization steps, a new hire working through their first week. Office managers keep it up to date.

## Data needed
Links: title, address (http/https only), category (Insurance portals, Labs, Supplies, Payroll, Other), pinned,
order, and optionally which offices and roles see it. Pages: title, Markdown text, section, images/PDFs, a review
reminder, optional sign-off, offices/roles. Announcements: title, message, show-until date, optional sign-off.
Onboarding: a checklist (items can link to pages) given to a person, with a finish-by date.

## Target
- **Command bar** (`components/intranet/IntranetCommands.jsx`, always mounted): every link the person may see is a
  command ("Open Cigna for HCP portal"), every page is "Office manual: <title>", plus Office intranet, Office links,
  Search the office manual, and for managers New page / New announcement / Add a link.
- **Intranet home** (`/intranet`): pinned announcements with "I've read this", pinned link tiles (the site's own
  favicon, loaded by the browser; a category icon when there is none), office manual sections, recently updated,
  "Needs your acknowledgement", your onboarding progress, and for managers "Due for review".
- **Links** (`/intranet/links`): by category; `/` finds a link, Enter opens the first match. Managers add (the title
  fills in from the address; the category defaults to the last one used), pin, reorder, edit and archive with Undo.
  **Suggested sites** (Delta Dental, MetLife, Cigna, Aetna, UHC, Guardian, Availity, Henry Schein, Patterson, Benco,
  Darby, Glidewell, Gusto, ADP, Paychex) are added one click each — never created on their own.
- **Office manual** (`/intranet/pages`, `/intranet/pages/:id`): `/` searches titles and text (↑/↓, Enter), **E**
  edits, **H** shows history. The editor is Markdown with a toolbar (heading, bold, italic, lists, checklist, link,
  table, note, image/PDF upload) and a live preview; **Ctrl/⌘S** saves, Esc leaves (unsaved text is kept in this
  browser and offered back). Every save is a new version; History shows what changed (line diff) and Restore makes
  the old text the newest version (Undo available). **Starter templates** (opening/closing checklist, medical
  emergency in the chair, sterilization, new patient call script, handling a payment dispute) are added in one
  click and start with a "Template — adapt this to your office" note.
- **Onboarding** (`/intranet/onboarding`): the new hire ticks items (linked pages open in one click); managers build
  checklists, assign them to a person, and see everyone's progress.

## What gets automated
- Review reminders: `review_due` is set from "review every" and moved on by "Still correct — mark reviewed".
  Managers see pages due in the next 14 days (and overdue ones) on the intranet home.
- Completing the last onboarding item completes the onboarding; unticking reopens it.
- Live updates (`publish` type `intranet`, ids only) refresh open intranet screens.

## Rules (server: `server/src/intranet.js`, `server/src/routes/intranet.js`)
- Everyone reads what's meant for them: an item limited to offices shows for the office the screen is working in
  (else the person's own offices); an item limited to roles shows for those roles (administrators see all roles).
- Changing anything needs `intranet:manage` (administrators always). Every id is checked against the practice;
  offices must be the practice's own.
- Addresses: only `http:`/`https:`; `javascript:`, `data:`, `vbscript:`, `file:` and addresses with a user name or
  password are refused. External links open with `target=_blank rel="noopener noreferrer"`.
- Page text is rendered by `components/intranet/md.js` into elements, never as HTML: tags show as text, links only
  go to http(s)/mailto/tel/another page/a file on the page, images only come from the page's attachments.
- Attachments (PNG, JPEG, GIF, WebP, PDF — checked by content) are stored like patient documents: encrypted, under
  the practice's folder, served with a sandboxing CSP, only to people who may see the page.
- Nothing is hard deleted: links, sections, pages, announcements, checklists and attachments are archived and can
  be brought back; versions and acknowledgements are never removed. Saves carry `base_version`: if someone else
  saved in between, the save is refused (409) rather than overwriting.
- Acknowledgements are one per person per version (a double click is one). "Ask everyone to read it again" moves
  the sign-off to the new version. The report lists who has and who hasn't, among active people who can see it.
- Audited: link/section/page/announcement/checklist create, update, archive, restore; page save (before/after),
  restore, reviewed; acknowledgements; attachment upload/archive; onboarding assign, tick/untick, complete, cancel.

## Edge cases
Starter links and templates added twice return the existing one. A section with pages can't be archived. Archived
pages can't be edited until brought back. Search treats `%` and `_` literally. Removing a checklist item archives
it; ticks already made on it are kept.

## Acceptance
- `server/test/intranet.test.js`: practice isolation, office/role visibility, URL validation, version history and
  restore, stale saves refused, archive not delete, acknowledgement report, permission checks, attachments
  (encrypted, scoped), templates, onboarding progress, and the Markdown renderer against XSS payloads.
