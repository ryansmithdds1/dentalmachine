# BM · Benchmarks and a leaderboard across practices

**Budgets:** seeing how you compare, from Reports → Metrics, **1 action** (the **Benchmarks** tab). A doctor choosing
to be named **1 action** (the "Show my name" box on that tab). The owner joining, from Settings → Benchmarks,
**2 actions** (tick "I agree", **Join benchmarks**); leaving **2** (**Leave benchmarks…**, **Leave and remove our
numbers** — the one confirmation, because deleting shared rows can't be undone). Seeing exactly what was sent
**1 action** per payload (**View payload**). Server rules are pinned by `server/test/benchmarks.test.js`. (No
Playwright workflow test yet: the tab and settings panel aren't mounted until `Metrics.jsx` / `Settings.jsx` add them.)

## Who and where
- **The owner** (administrators) joins or leaves, sets the practice type and the year it opened, chooses whether to
  share labor %, previews tonight's send, sends by hand, and reads every payload that was sent. Joining, leaving,
  settings changes and manual sends are audited (`benchmark.join`, `benchmark.leave`, `benchmark.settings`,
  `benchmark.send`).
- **Each doctor / hygienist** decides whether their own name is shown (`benchmark.name_display`, audited). Only the
  person whose login is linked to the provider can turn it **on**; they or the owner can turn it **off**.
- **Viewing:** `reports:read` sees every provider's numbers and cards; `reports:own` sees only their own (their
  login must be linked to their provider), and no whole-practice rows. Front desk without either: nothing.

## What's shared (BM1–BM2) — `server/src/benchmarkservice/catalog.js`
Per calendar month (this month so far and last month, resent nightly: late postings change last month), per
provider (a random `provider_key` and a four-digit `anon_code`), and for the whole practice:

| Number | For | Comes from (one definition each) |
|---|---|---|
| Treatment diagnosed per new-patient / recall / emergency exam | dentists (recall: hygienists too) | `diagnosisFunnel` (`diagnosis.js`) `by_exam_type[].per_exam` |
| Work completed within 1 / 3 / 5 months per exam | dentists | `examValues` (`metrics.js`), all exam types together |
| Case acceptance | dentists, practice | `computeMetrics` `case_acceptance` |
| Diagnosed work presented / accepted / scheduled / completed | dentists | funnel `of_diagnosed_pct` |
| Production per doctor-hour / hygiene-hour | dentists / hygienists | `production_gross` ÷ business view `visitMinutes` of completed visits |
| Hygiene reappointment | hygienists | `computeMetrics` `hygiene_reappointment` |
| Perio share of hygiene | hygienists | the Hygiene report's rule (perio codes ÷ perio + prophy) |
| No-show & cancel rate | all | `computeMetrics` `broken_rate` |
| Schedule fill | dentists, hygienists | report library `schedule-utilization` |
| Collection rate, new patients per month | practice | `computeMetrics` |
| Reappointment %, current on recall | practice | `recallCounts` (`recallfreq.js`) |
| Labor % of production (optional, off by default) | practice | business view `businessTrends` |

Each value carries its sample size `n`. A value resting on too little is **not sent** (`MIN_SAMPLE`: 5 exams or
findings, 3 plans, 10 visits, 8 hours, 20 recall patients). Money is rounded to whole dollars.

**Never sent:** patient names, ids, dates of birth, contact details, visit or exam dates, procedures, notes, the
practice's name or location beyond its census region. Names of providers only when they chose it. The payload is
built from an allow-list and checked twice: `unexpectedKeys` before sending, and the service refuses any field,
metric or role not in the catalog (400).

The peer-group profile sent with it: `practice_type` (owner), `region` (from the practice's state: Northeast,
Midwest, South, West, other), `size_band` (active dentists: 1, 2–3, 4–6, 7+), `payer_mix` (insurance share of the last
12 months' payments on the ledger: ≥ 50% mostly insurance, ≤ 20% fee-for-service, else mixed), `years_band` (from the
year opened: < 5, 5–15, 15+, not given).

## Plumbing (BM5)
- **Adapter** `createBenchmarkClient` (`server/src/benchmarks.js`): `http` when `BENCHMARK_URL` is set (https only —
  a plain-http URL turns benchmarks off unless `BENCHMARK_ALLOW_HTTP=1` for local testing; every call through
  `loggedFetch`, so it's in Settings → Connection activity); `sandbox` (the default outside production, or
  `BENCHMARKS=sandbox`): the service runs in-process on the app's database with 48 made-up peer practices, logged in
  Connection activity as "Benchmarks (sandbox)"; `off` in production without a URL, or `BENCHMARKS=off`.
- **Signing:** on joining, the practice makes an Ed25519 key pair; the private key is sealed with the app secret
  (`bm_settings.signing_secret`), the service keeps only the public key. Every request is signed over
  `<unix seconds>.<exact body>` (`X-DM-Participant`, `X-DM-Timestamp`, `X-DM-Signature`); the service refuses a
  wrong or missing signature (401), a timestamp more than 10 minutes off (401) and a reused nonce (409).
  `BENCHMARK_ENROLL_TOKEN` (both sides) can make joining need a token handed out with the terms.
- **The nightly job** (`runBenchmarkSends`, hourly check): each joined practice once per practice-local day after
  1am, claimed by a unique index (`bm_sends` nightly per `send_date`), so restarts and a second server can't double
  send. Then last month's comparison is fetched and kept (`bm_settings.last_results`) for the monthly email.
- **What was sent:** every join / submit / leave is a `bm_sends` row with the exact signed text, its SHA-256, the
  destination, the result, the service's receipt and rows accepted. Never edited after it finishes, never deleted.
  **Reconciled:** rows accepted ≠ rows sent raises `benchmark-reconcile`.
- **Failures** become Needs attention items for administrators: `benchmark-send` (resolved by the next good send),
  `benchmark-leave`, `benchmark-results`, `benchmark-reconcile`.
- **Leaving** stops sending at once (`status = leaving`), asks the service to delete every row this practice sent,
  and forgets the key (`left`). If the service can't be reached, the job keeps asking; nothing else is sent.
  Re-joining makes a new random participant and new provider keys, so old and new rows can't be linked.

## The benchmark service — `server/src/benchmarkservice/`
Its own router (`index.js`), logic (`service.js`), tables (`bms_participants`, `bms_rows`, `bms_nonces`,
`bms_receipts`, created by the service itself so it can run on its own database), and entry point (`server.js`:
`BENCHMARK_DATABASE_URL=… PORT=4100 node src/benchmarkservice/server.js`, behind TLS).
- `POST /v1/join`, `/v1/submit` (up to three months; resending a month replaces it), `/v1/benchmarks`, `/v1/leave`.
- **Peer groups (BM3):** the narrowest group of practices matching on practice type, region, size, payer mix and
  years that has **at least N practices** (`BENCHMARK_MIN_PEERS`, default 10, never under 5) with that number that
  month; widened one dimension at a time (years first, then payer mix, size, region, and finally type). Fewer than N
  even across all practices: **nothing is shown** — no percentiles, no leaderboard, no standing.
- **Percentiles:** 25th / 50th / 75th / 90th of performance (for "lower is better" numbers the 90th is the low end),
  linear interpolation. **Standing** = the share of the others you do better than, ties half ("you are at the
  68th percentile for treatment diagnosed per recall exam").
- **Leaderboards (BM4):** per number, role and month, the top 10 of the peer group, best first; "Dr. #4821" (or
  "RDH #…", "Practice #…") with region and practice type only, unless the provider chose to be named. Badges: the
  number's own badge for first (e.g. "Eagle Eye", "Boomerang", "Hour Hero"), runner-up and third, "Top 10%", and a
  **Rising star** (biggest climb in standing since last month, 10 points or more). Your own rows come back marked so
  the app can put your names on them locally.
- **What top performers do differently:** for each number, the median of its related numbers (`RELATED`) among the
  peer group's top quarter, against the group median — numbers only, never guesses.

## Screens
- **Reports → Metrics → Benchmarks** (`client/src/components/metrics/Benchmarks.jsx`): month (last month by default,
  the one before, this month so far), who (dentists, hygienists, whole practice); a card per person — "You are at
  the 68th percentile for …", above the median on X of Y, the two or three biggest opportunities (with the dollars
  it would mean at the 75th percentile where that's countable) and what the top quarter does on the related numbers;
  the percentile table with a spread bar; the leaderboard. The linked doctor's "Show my name" box is here. Not
  joined: what it is, and a link to set it up (owner) or who to ask.
- **Settings → Benchmarks** (`client/src/components/settings/BenchmarkSettings.jsx`): status, peer group (type, year
  opened, labor % switch, the worked-out region / size / payer mix), what's shared and where each number comes from,
  preview of tonight's payload, Send now, join (with the terms) / leave (one confirmation), each provider's display
  (owner can make anonymous), and every payload sent (View payload shows it exactly, with its fingerprint).
- **Monthly email:** `benchmarkDigestBlocks` (`server/src/benchmarkdigest.js`) adds "How you compare with practices
  like yours" from the kept results (owner: every card; a hygienist's digest: her own). Nothing when not joined.

## Before launch
- **Legal review** of the terms shown on joining (`TERMS` in `server/src/routes/benchmarks.js`, version
  `TERMS_VERSION`) and of BAA language: only de-identified aggregates leave, but whether provider-level numbers from
  small practices need a data-use agreement, and how the service operator is bound, is for counsel to confirm.
- Choose and operate the service's host (TLS, its own database, backups) and decide on `BENCHMARK_ENROLL_TOKEN`.
