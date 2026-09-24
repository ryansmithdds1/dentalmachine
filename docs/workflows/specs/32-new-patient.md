# 32 · New patient setup

**Budget: 8 actions** for a new chart with its primary insurance. Measured: **5** (Ctrl/⌘K → "new patient" →
Enter → type the line → Enter). Tested by `e2e/workflows/32-44-daily.test.mjs` (#32); the line parser by
`server/test/daily.test.js`.

## Measured path
From any screen: Ctrl/⌘K, "new patient", Enter opens **New patient** with the cursor in one line. Type it the way the
caller says it — `Jane Doe 3/14/1985 512-555-0100 jane@example.com Delta W123456789` — and Enter. The chart opens.
A caller or texter not on file (workflow 5) starts the form with their number already in it.

## Before (audit row 32)
16–20 actions over 2 modals and 2 screens: the ~25-field patient form, then the Insurance tab and its policy form.

## Defaults
- `newPatientLine.js` splits the line: name ("Doe, Jane" too), birth date (any US or ISO form; impossible or
  future dates are left blank, never guessed), mobile, email, a carrier the practice already has (full name,
  name without "Dental", or a unique first word), and the member ID next to it.
- Every field it fills is shown below the line and can be changed; what the person types in a field wins.
- The policy is primary, the patient is the subscriber, the subscriber's birth date is theirs.
- "All fields (address, provider, medical…)" switches to the full form in the same dialog with what's typed.

## Keyboard path
Ctrl/⌘K · type · Enter · type · Enter. Tab reaches every field; Esc closes.

## Background automation
- The duplicate check runs before saving; possible matches appear inline (open the existing chart, or save anyway).
- Eligibility and benefits are checked with the carrier right after saving (workflow 20); a failure is a toast,
  and the chart's Insurance tab shows the answer when it's back.

## Safety
Both records go through the normal routes (`POST /patients`, `POST /patients/:id/insurance`): validated, audited,
practice-scoped. If the policy fails, the chart is kept and the Insurance tab opens with the reason.
