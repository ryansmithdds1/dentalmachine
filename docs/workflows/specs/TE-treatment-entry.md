# TE · Treatment entry: bundles, quick buttons, hotkeys and aliases

**Trigger:** the exam, the treatment conversation, the new-patient visit: the dentist says what's needed (a crown
with a buildup, an implant, SRP, a bridge) and it goes on the chart as planned (or done) treatment. **Who:** dentist,
hygienist or assistant charting; the office manager setting up the office's buttons. **Data:** teeth or
quadrants/arch, codes, surfaces, phases, fees, the insurance estimate.

**Today:** chart-by-typing (`08`) handles one kind of work per entry; a crown with buildup and post is three entries,
an implant is three codes looked up one at a time, SRP is four quadrant picks, a bridge is typed tooth by tooth,
and nothing can be customised. Voice charting needs the assistant to pick codes itself.

**Budget:**
- Crown bundle on a tooth: **2 actions** — click the tooth, Alt+1 (the first quick button). Typed alias "14 crb bu" +
  Enter: 2 once in the entry box (+1 to get there: E or any digit).
- New patient bundle: typed "np" + Enter, **2 actions** in the box; or its button's Alt+digit, **1**.
- Any bundle by voice: one sentence and one "yes".

**Redesign:**
- **One engine** (`server/src/chartengine.js`, re-exported to the browser as `chartShorthand.js`): typing, the quick
  buttons, Alt+1…9, bundles and the voice assistant all resolve through the same code, so the same words chart the
  same way. It runs in the browser (instant chips) and on the server (`POST /charting/resolve`, and the chart call
  re-checks every item). Old shorthand is unchanged; entries now take several kinds of work at once ("19 root canal,
  buildup and crown plan"), speech-style fillers ("number 14 … plan it", "3 to 5"), quadrant/arch codes
  ("D4341 UR UL") and a bridge from its ends ("3-5 bridge plan" → retainers on 3 and 5, pontic on 4).
- **Bundles** (`procedure_bundles`): a name, an alias and a recipe — each item a code, a kind of work (the code is
  chosen per tooth by `codeFor`) or a finding; which teeth (the tooth, each tooth, the ends, the teeth between, none,
  unsealed permanent molars from the chart); surfaces (none, same as typed, fixed); a quadrant/arch; optional and on
  by default; a phase. Optional parts are switched with "with post", "no buildup", "srp no LL", or the ± chips in the
  preview. The office's (administrators) and each person's own; retired, never deleted; audited before → after.
- **Starters**, added for every practice and back in one click: Crown (crb: crown ± buildup ± post), Implant (imp:
  fixture → abutment → crown as phases 1–3), New patient (np: comp exam, FMX, adult prophy), New patient child
  (npc), SRP 4 quads (srp), Bridge (brg: from a range), Denture upper/lower (cdu/cdl), Night guard (ng), Sealants on
  every unsealed first/second permanent molar (seal).
- **Quick buttons** (`chart_shortcuts`) above the tooth chart: office then personal, ordered, coloured, with an icon;
  each is a code, a kind of work, a finding or a bundle, with plan / done / existing. The first nine are Alt+1…9 (on
  a Mac ⌥1…9, matched by key position). A button fills the entry box and, when there is nothing to check (no
  errors, no warnings), charts at once with Undo; otherwise the preview waits for Enter. With no tooth selected it
  waits for the tooth ("crb ▮" → type 14, Enter).
- **Aliases** (on bundles and buttons) work typed and spoken: "bu", "crb", "imp", "np", "srp". An alias can't be a
  word the engine already knows (crown, MOD…), and a person's can't clash with the office's.
- **The same preview everywhere:** chips per item (phase, fee), the bundle's optional parts, whole-entry total, the
  insurance estimate (from the estimate endpoint's own code, `estimateFor`; for people with billing:read), and
  warnings — already planned, on a missing tooth, twice in one entry, frequency limits and other plan notes. Errors
  stop charting: an impossible surface for the tooth (I on a molar, O on an incisor), a code not on the practice's
  list, a tooth/surface/quadrant the code needs.
- **Enter charts it all in one step** (`POST /patients/:id/chart-entry`, all or nothing, each item re-checked;
  audited with how it came in: typing, button, voice) and Undo takes it back (planned work cancelled, findings
  voided). The entry box keeps focus, so the next entry is typing + Enter.
- **Voice:** the mic on the entry box ("crown bundle on 14 with buildup, chart it"), and the assistant's `chart_entry`
  tool: its confirmation line is the resolver's preview (items, fees, estimate, warnings); on yes the browser charts
  exactly those items. Completing work by voice still needs the person's yes (428 otherwise).
- **Compare options:** "the patient wants to compare: option one, extraction and bone graft on 19; option two, root
  canal, buildup and crown" → Option A (D7140 + D7953 #19) and Option B (D3330 + D2950 + D2740 #19) side by side,
  each priced; the tooth said once carries across. Enter sends them to `POST /patients/:id/treatment-options` (F6).
- **Cheat sheet:** the ? list shows the Alt buttons and every alias with what it charts.
- **Editor:** Settings → Clinical → Chart shortcuts & bundles: office/mine, reorder, retire/bring back, starters, and
  a live preview of exactly what a button or bundle charts (with fees) on an example tooth.

**Automated:** codes per tooth; bridge retainers/pontics; unsealed molars from the chart; the estimate; seeding the
starters.

**Edge cases:** one bundle per entry (separate with ;); a bundle is planned or done, never "existing"; a bridge needs
3+ teeth on one arch; a mouth-level bundle with a tooth number is refused (not silently ignored); a retired bundle's
buttons show as disabled; codes a starter needs that an older practice lacks (D6057, D0272, D7953) are named in the
preview with where to add them; Alt+digit may be taken by the browser on Linux (tab switching) — the buttons and
aliases still work.

**Acceptance:** `e2e/workflows/TE-treatment-entry.test.mjs` — crown bundle via tooth + Alt+1 in 2 actions and Undo;
"14 crb bu" and "np" in 2 actions each from the box; warnings and refusals; the ? cheat sheet; the editor's live
preview. `server/test/treatmententry.test.js` — engine: old behaviour, aliases, bundles (options, phases, quadrants,
bridge range, unsealed molars), comparisons, checks. `server/test/bundles.test.js` — seeding, CRUD, retire/restore,
audit, practice isolation, permissions, resolver validation and warnings, charting (atomic, idempotent, AI approval),
the assistant's confirmation line.
