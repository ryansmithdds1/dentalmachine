# LB — Lab case (and parts) check-in, and "is everything ready for this visit?"

**Trigger:** a box arrives from the lab ("the crown for Maria Lopez is in"), an implant order arrives, or the morning
huddle asks "is everything here for this week's seats and surgeries?". The owner's problem: cases don't show up when
they should, and nobody finds out until the patient is in the chair.
**Who:** anyone with `clinical:read` sees readiness (schedule icon, huddle card, check-in list, lab stats). Checking
work in, linking cases and managing parts needs `clinical:write`. Parts templates and the "days ahead" window are
changed by an administrator only (audited, before → after).
**Data:** `server/src/labcheck.js` (rules, parser, stats, schema lines) and `server/src/routes/labcheckin.js`;
tests `server/test/labcheckin.test.js`, `e2e/workflows/LB-labcheckin.test.mjs`. Screen: `/lab-checkin`
(`client/src/pages/LabCheckin.jsx`); schedule icon `components/readiness/ReadinessBadge.jsx`; huddle card
`ReadinessHuddle.jsx`; lab stats `LabStatsCard.jsx` (on To-do & labs).

## Click budgets
### Check in a due case with a photo, "Looks good" = 3 actions
| Step | Keys | Actions |
|---|---|---|
| Open Check in lab work (huddle card "Check in", To-do & labs "Check in a case", or the icon on a schedule card) | click | (navigation) |
| Pick the case from "Lab cases due this week" (the active patient's case is already picked) | click, or `F` name Enter | 1 (0 if already picked) |
| Photo of the case / slip (phone camera opens directly) | click the camera tile, or `C` | 1 |
| Looks good — every checklist item ticked, recorded, visit turns green | click, or `G` | 1 |

Pinned by `e2e/workflows/LB-labcheckin.test.mjs` (budget 3 actions, 8 s) and the keyboard-only run (`F` name
Enter `G` = 4 actions, no mouse).

### Other paths
| Path | Actions |
|---|---|
| Scan the slip's QR code (`S`, point the camera; a USB scanner types the code + Enter) | 2 |
| Voice: hold the mic, say "Lab case is in for Maria Lopez — crown number 30, shade A2, looks good", let go → the case is picked and the checklist filled; tap Looks good to confirm | 2 |
| Problem: "Something's wrong" (`P`), type what's wrong, pick Remake / Adjust / Missing parts / Other, Record | 4 |
| After a problem: Send the (editable) note to the lab | 1 |
| After a problem: Move the visit (opens the schedule on that day) | 1 |
| Link a case to a visit by hand (visit detail "Pick the lab case") | 1 |
| Mark a lab procedure "not needed" (made in the office) with a reason | 2 |

## LB1 — every lab visit is linked to its case
- A procedure on a visit **needs a lab** when its code is a crown (D27xx), inlay/onlay (D25xx–D26xx), veneer
  (D2962), bridge pontic/retainer (D62xx, D67xx), implant crown/retainer (D6058–D6077, D6082–D6088, D6094, D6097),
  denture/partial/reline/interim (D51xx, D52xx, D575x–D576x, D581x–D582x), implant denture (D611x, D6194) or night
  guard (D9944–D9946). Fillings, implant placement, cleanings do not.
- **Auto-link** (idempotent, recorded as automation "Visit readiness" with the reason in plain words): the case
  made for that procedure, else the patient's **only** open case for that tooth (or, for dentures / guards with no
  tooth, the only open case of that kind and arch). A case that names the visit as its seat appointment is linked
  too. Two cases that fit → nothing is guessed: the visit shows "Pick the lab case" with the choices. No case →
  "No lab case yet" (a to-do in the huddle window). "Not needed" (e.g. milled in the office) takes a reason.
- A case linked to another upcoming visit isn't offered; moving it needs `move: true` (a yes on screen).
- **Schedule card icon** (one per visit, lab + parts together): ready (green check) · arrived, needs its check ·
  waiting (at the lab / ordered) · late (past its date, or promised back on/after the visit) · missing (not sent /
  not ordered / not linked) · problem. Hover lists each item. Clicking it opens the check-in with that patient.
  Loaded once per screen with `GET /visit-readiness?date=&to=` (up to 14 days), refreshed on live `readiness`
  and `lab_checkin` events.
- **Huddle:** "Lab cases & parts — next N days" (setting `days_ahead`, default 3) lists visits that aren't ready. Each
  item that isn't here makes **one** to-do (claimed on the row, so double runs or two servers make one): "Call the
  lab (Glidewell): Maria Lopez's Zirconia crown #30 is late (due …) — visit Tue Sep 29", "No lab case for …",
  "Order 1 × Healing abutment for …", "Check on the order: …". High priority when late / missing or the visit is
  within a day. Checking the item in closes its to-do. The hourly job `runReadinessJob(db)` does the same for
  every practice.

## LB2 — check-in
- The list: open cases due within 7 days (or tied to a visit in that window), cases that arrived unchecked or
  failed a check, and parts on order for visits in the window. Search by patient / case / lab.
- The slip's QR code is `DM-LAB-<case id>` (printed on the lab slip). It's a reference, not a key: it only finds
  a case for someone signed in to this practice. The lab's own portal link scanned off their paperwork works too.
- Photos go up as they're taken: stored like every chart image (encrypted at rest, virus-checked, type checked
  from the bytes — images only), filed in the patient's chart as a `photo` tagged "lab check-in", on the visit
  and the tooth.
- Checklist (all six must be answered; "Looks good" answers them all yes): right patient and tooth · matches the Rx
  · shade · margins and contacts · no cracks or chips · all parts and models. For parts: right patient · right
  brand/platform/size · sterile pack sealed · in date · no damage · everything ordered is here.
- Recorded as a `lab_checkins` row (append-only: a re-check is a new row) with who, when, how (screen / scan /
  voice + transcript), the checklist, photos, and a snapshot of the lab, sent, promised and received dates. The
  case becomes `received` with `check_status` checked or problem; the visit's link is made if missing. Audited
  `lab_checkin.ok` / `lab_checkin.problem` with before/after. A repeat with the same key returns the first check.

## LB3 — by voice
- Hold to talk (the button, or `V` to start/stop). Speech goes through the office's speech service when one is set
  up (`/dictation/transcribe`, the same one notes use; sandbox in tests) or the browser's recognition. The words are
  read by a deterministic parser — no AI: patient name (words after "for"), teeth ("number 30", "tooth #3", "#14",
  "teeth 3 through 5", number words), kind (crown, bridge, denture, partial, night guard, implant crown, veneer,
  inlay), arch (upper / lower), shade (A1–D4, BL, 3D-Master), part (fixture/implant, healing abutment, abutment,
  screw, scan body, graft, membrane, aligners, retainer, sedation kit; brand; platform; "4.3 by 10") and the
  verdict ("looks good" … vs "margin is open", "contact is light", "chipped", "wrong shade", "missing the model",
  "doesn't fit" — a problem said anywhere wins; "no cracks" is not a crack).
- The words are matched to the open cases and parts (name, tooth, kind, arch, part details). **Nothing is saved**:
  the case is picked and the checklist filled only when one candidate clearly wins; otherwise the choices are
  shown. A shade that differs from the Rx is flagged and its box left unticked. The person confirms with the same
  "Looks good" / "Record the problem" button.
- For the assistant: `LAB_CHECKIN_TOOL` / `labCheckinReader` (read-only prefill) are exported for its registry;
  it can never record a check — `POST /lab-checkin` from the assistant without the on-screen yes is refused (428).

## LB4 — problems
- A failed check makes a **high-priority to-do for the doctor** (the case's provider, else the visit's) and sends
  a live `lab_checkin` event naming the doctor's user id (ids only, never names).
- The screen then shows an editable **note to the lab** (remake or adjust, what's wrong, the visit date, "photos
  are on the case link") and **Send to the lab**: a person's click emails the lab with a fresh private case link
  (our problem photos are added to it), sets the case to "returned for adjustment" (with an optional new due date)
  and is audited. Sent once. A failed email becomes a Needs attention item (Clinical).
- **Move the visit** opens the schedule on that day (when the visit hasn't started).
- **Lab stats** (`GET /lab-checkin/stats?from=&to=`, default last 6 months; card on To-do & labs): per lab —
  cases back / sent, average turnaround (sent → back) vs average promised (sent → first promised date), late %
  (back after the first promised date), remake % (cases with a check that asked for a remake), cases still out
  past their date.

## LB5 — parts and materials
- `visit_requirements` rows of kind `part`: to order → ordered → arrived → checked / set aside (or problem, or not
  needed with a reason). **Templates per procedure code** prefill them when the procedure is on a visit (defaults:
  D6010 implant → fixture + healing abutment + bone graft; D6056/D6057 abutment + screw; implant crowns → abutment +
  screw + scan body; D7953 graft + membrane; D4266/7 membrane; D8090 aligners; D8680 retainers; D9239/D9243 IV
  sedation kit). An administrator edits them (Settings API `PUT /visit-readiness/settings`), and can tie a template
  part to a stock item.
- **Stock:** a part tied to an inventory item is **set aside** when the shelf has enough that isn't already set
  aside for another upcoming visit (a reservation counted from these rows — the shelf count isn't touched);
  otherwise it stays **to order** (on `GET /visit-requirements/to-order` with on hand / reserved / free, and a
  to-do in the huddle window). An ordered part that is checked in is received into stock (`inventory_moves`
  "received", for the visit) and stays set aside. Using it up is left to the existing supply usage on completion.

## Safety
- Server-side validation of every id (practice and office scope), date, tooth, size, quantity, checklist and
  problem kind; photos must be this patient's; parts' sizes in mm.
- Nothing is deleted: links and parts are cancelled with a reason; checks are append-only; the case's history is in
  the audit log (before/after via `recorded()` / `change()`).
- Office limits: someone limited to other offices doesn't see these visits, their cases or their checks (404).
- AI: prefill only; recording a check or sending a remake needs a person (428 otherwise).

## Decisions for the owner
- Who may check work in: `clinical:write` (assistants, hygienists, dentists, admin). Front desk sees the icons and
  the list but can't record the quality check. Change if the front desk should do it.
- "Late" includes a case **promised back on or after the visit day** (it can't be checked in time).
- The slip QR carries the case number, not the lab's private link.
- Problem photos are shared with the lab on the case link.
