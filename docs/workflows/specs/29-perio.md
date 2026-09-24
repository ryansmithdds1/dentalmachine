# 29 · Perio charting

**Trigger:** a hygiene visit with a periodontal exam (yearly, or every visit for perio maintenance patients).
**Who:** the hygienist, often alone (hands on the probe). **Data:** six depths per tooth, gingival margins,
bleeding, suppuration, plaque, furcation, mobility; the last exam to compare.

**Today (audit):** ~170–190 depth keystrokes (they auto-advance), a click to switch to gingival margins, then bleeding
by choosing a marker and clicking each site — ~20+ mouse clicks for bleeding alone. Voice existed but bleeding by
keyboard didn't.

**Budget:** one action per reading and per marker; nothing needs the mouse.

**Redesign:**
- **B, U, P** mark bleeding, suppuration or plaque on the site just probed (the way it's called out as the probe comes
  out); **Shift+B** (or a capital) marks that whole side of the tooth. **G / D** jump between the margin and depth rows.
  Voice keeps working ("bleeding", "bleeding all", "margins", "tooth 14").
- **The drawing** uses the same anatomical teeth as the chart, with the CEJ, the gum line (blue), the pocket bottoms
  (red) and the pocket between them shaded to scale (3.2 units per mm), bleeding/pus/plaque dots where found,
  furcation triangles filled by grade, mobility, and the compared exam's pocket line dashed so change stands out.
- **The grid** is a heat map: 4 mm amber, 5–6 red, 7+ solid red; bleeding and pus are coloured corners; 2 mm+
  change against the compared exam is underlined red or green.

**Automated:** digits move on by themselves (a 1 waits for a second digit); the summary (bleeding %, pockets ≥ 4/5,
CAL ≥ 5, deepest) and change vs the last exam are computed as you go.

**Edge cases:** missing teeth are skipped; gingival overgrowth is typed with a leading minus; a marker with nothing
probed yet goes on the focused site; view-only users see the drawing and grid without inputs.

**Acceptance:** `e2e/workflows/29-perio.test.mjs` — six readings and two markers in ≤ 9 actions (1 click + 8 keys),
saved exactly (B on the site just probed, Shift+B on the whole side), pockets drawn.
