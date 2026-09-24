# XR · X-ray AI as a second set of eyes

**Budgets:** reviewing one AI finding from the day's list **≤ 1 action** — measured **1** (**A** accepts and charts it,
**D** dismisses it; **J/K** move between findings; the next one is selected by itself). Opening the day's list **≤ 2**
(command bar → "X-ray AI review"). Seeing what's waiting on a patient **0** (the card is on the Chart tab whenever
there is something). Showing the patient their confirmed findings on the chair screen **≤ 1** (**P**, or "Show the
patient"; **←/→** between images, **Esc** gives the screen back). Toggling the overlay / its confidence in the viewer
**1** each (**X** / **N**). Undo of an accept or dismiss **1** (the toast's Undo, or Ctrl/Cmd+Z while it shows).
Server rules are tested by `server/test/xrayai.test.js`.

Every finding everywhere carries the label **"AI suggestion — the dentist decides"**. Nothing is ever charted
automatically.

## Who and where
- **Dentists and hygienists** (`clinical:sign`) accept or dismiss findings: the Chart tab's "AI second look on x-rays"
  card, the day's list (**X-ray AI review**, `/xray-review`), and the AI panel in the image viewer.
- **Assistants** (`clinical:write`) can ask for an AI read of an x-ray and run the second look now, but not decide.
- **Everyone with `clinical:read`** sees the findings, the review lists and the chair screen.
- **The assistant (AI)** may ask for a read (a suggestion). Accepting or dismissing a finding it proposes needs the
  person's yes on screen (`X-Human-Approved`) or it gets **428**; the person is recorded as the approver.

## The engines (XR1) — `server/src/xrayvendors.js`
Only FDA-cleared detection services find disease: **Pearl Second Opinion**, **Overjet**, **VideaHealth**, each behind
its own adapter (request, polling, response mapping, tooth numbering incl. FDI → Universal). A general-purpose model
(`XRAY_AI=claude`) is refused. None of the three publishes a public API reference: the shapes follow each vendor's
public description and must be checked against the partner spec (one object per vendor) before going live.

| Setting | Meaning |
|---|---|
| `XRAY_AI=pearl \| overjet \| videahealth` + `XRAY_AI_KEY` (+ `XRAY_AI_URL`) | That vendor. No key → off, with the reason shown. |
| `XRAY_AI=vendor` + `XRAY_AI_NAME=Pearl…` | The older setting, mapped to the named vendor. |
| `XRAY_AI=sandbox` (+ `XRAY_AI_SANDBOX_VENDOR`) | The vendor's API played locally with made-up findings (default Pearl). Labelled "sandbox", never "FDA-cleared". |

What leaves the office: the image bytes, the content type and a random per-read reference — never the patient's
name, birth date or our ids. Every call goes through `loggedFetch` (Settings → Connection activity: host, path,
status, time, the vendor's request id; no bodies).

## Data model — `server/src/db.js`
| Table / column | What it is |
|---|---|
| `xray_findings` | One per AI finding: `kind`, `tooth`, `surfaces`, `confidence`, `box` (fractions of the image), `measurement_mm`, `note` (the short plain reason, e.g. "Pearl Second Opinion: progressed caries (87%)"), `engine`. New: `vendor_ref`, `cleared`, `review_reason`, `review_source`, `approved_by`. `status` suggested → accepted / rejected (dismissed). Never deleted once decided. |
| `tooth_conditions.xray_finding_id` | New: the finding that is the reason this condition was charted. |
| `xray_ai_reads` | New: each time an image was sent — why (`read_for`: upload / manual / second_look), ok or not, findings, the vendor's reference, error, who asked, time taken. Reconciles sent vs read vs failed (`GET /xray-ai/reads`). |
| `documents.ai_engine`, `ai_vendor_ref` | New: which engine read the image and its reference. |

## The review list (XR2)
- **Chart comparison** (`compareWithChart`, `server/src/xrayai.js`): each suggested finding is compared with the chart
  by tooth and surface — a matching condition (caries/watch; abscess for periapical; filling/crown for existing work…),
  planned work that treats it, or work completed on/after the x-ray. The sentence reads **"AI saw possible caries on
  #19 D; not charted"**, "… already on the chart", or "… tooth not identified — check the image".
- **Per patient** (`GET /patients/:id/xray-review`) on the Chart tab; **per day** (`GET /xray-review?date=`) for the
  patients on the schedule. Tabs: Not charted (default) · Already on the chart · No tooth number · All.
- **Accept** (`PATCH /ai-findings/:id {status:'accepted'}`): charts a condition with the finding as the reason (the
  note names the engine and the dentist); if the chart already has it, the finding is linked instead of charting it
  twice. **Dismiss** (`{status:'dismissed', reason?}`): kept with who, when and why. **Undo** (`{status:'suggested'}`):
  the condition the accept created is voided (kept) with the reason. Repeats (double click, retry) change nothing.
- **Second look** (`runSecondLook`, job hourly + "Second look now"): today's patients' x-rays from the last year that
  the AI hasn't read are read before the visit — when the practice has "Read new x-rays automatically" on. A read that
  failed in the last hour waits for a later run; a vendor that's down stops the run for that practice.

## The patient (XR3)
- **Chair screen** (`GET /patients/:id/xray-chair`, **P**): the images with **only dentist-accepted findings**, in plain
  words ("A cavity (decay) · Tooth 19 — back side"), no AI scores. Each showing is audited (`xray_ai.chair_view`).
- **Treatment presentation**: the patient's plan link (`/tp/:token`) lists "What your x-rays showed" — accepted
  findings on the plan's teeth, no ids. Staff: `GET /treatment-plans/:id/xray-findings`.

## Safeguards
| What could go wrong | Safeguard |
|---|---|
| The AI charts a diagnosis | Findings are only ever `suggested`; charting happens only on a person's accept (`clinical:sign`); the assistant gets 428 without `X-Human-Approved`. |
| A decision can't be traced | `xray_ai.accepted / dismissed / reopened` audit entries: before → after, who, the approver, the AI's reason; the AI's read itself is audited with source `ai`. |
| The vendor is down or refuses the key | One Needs attention item per practice (`xray-ai:vendor`, admins for a key problem), counted up, resolved by the next read that works. An image the vendor refuses is its own item (`xray-ai:<document>`). |
| A patient sees an unconfirmed finding | The chair screen and plan link read only `status = 'accepted'`. |
| Double submit | Accept/dismiss change the row only from the state read; one condition per finding. |
| Another practice's data | Every id is checked against the caller's practice and office access. |

## Keyboard
| Key | Where | Does |
|---|---|---|
| J / K | review list | next / previous finding |
| A / D | review list | accept (chart it) / dismiss |
| V / C | review list | show the x-ray / its confidence |
| P | review list | chair screen for that patient |
| R | Chart tab | start reviewing (the list's keys work once it has focus, so a stray key never decides) |
| X / N | image viewer | AI overlay / confidence on it |
