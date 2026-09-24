# 50 · Schedule templates and provider hours

**Budget: 4 actions** (audit). Templates ("perfect day" blocks) are covered by [S2-perfect-day](S2-perfect-day.md)
and its test (`S5-S2-production.test.mjs`). Measured here: **a provider's day off — 3** (click From, type the date,
Enter; "Off all day" is the default) — `e2e/workflows/45-54-monthly.test.mjs` (#50).

## Blocked by a shared file (Settings.jsx)
Typing a date into **From** makes **To** jump to the first partial date typed (e.g. typing the month gives today's day
in that month) and stay there, so a one-day change becomes a multi-day range. The test skips until this line in
`client/src/pages/Settings.jsx` (`TimeOff`, the From input) is changed so To follows From while it was one day:

    onChange={(e) => setForm({ ...form, from: e.target.value, to: !form.to || form.to === form.from || form.to < e.target.value ? e.target.value : form.to })}

## Not changed (Settings.jsx is shared)
Weekly working hours are still edited in the provider's form (Settings → Providers; audit: 5 + 2 per day). Time off
is under Settings → Providers → "Time off & special hours". Visits already booked in the time are listed at once.
