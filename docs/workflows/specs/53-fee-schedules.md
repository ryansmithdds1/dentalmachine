# 53 · Fee schedule updates

Covered by [FS-fees](FS-fees.md). **Budget: 4 actions** for a yearly % increase (audit). **Measured: 2** (R, *Schedule
for Jan 1*) and **2** to approve a payer's new schedule — `e2e/workflows/FS-fees.test.mjs`, not repeated in
`45-54-monthly.test.mjs`. That test skips its screen steps until the Fee updates screen is mounted in Settings
(shared file); the server rules are tested either way.
