# HIPAA Security Rule risk analysis

The risk analysis §164.308(a)(1)(ii)(A) requires: where electronic patient information (ePHI) lives in Dental
Machine, what could go wrong with it, what protects it, and what risk remains. **Review it once a year and
after any big change**: a new vendor, new hosting, a new way patients reach the system, or a security
incident.

This covers **the software and how it is hosted**. Each practice using it still needs its own risk analysis
for its office: its computers, Wi-Fi, front-desk habits and paper. Nothing here is legal advice.

| | |
| --- | --- |
| Version | 1.0 |
| Last reviewed | 2026-09-24 |
| Next review | 2027-09 (or sooner: see above) |
| Owner | Security officer (name them before go-live) |
| Method | Adapted from NIST SP 800-30 and the HHS/ONC Security Risk Assessment tool: assets → threats → current controls → likelihood × impact → residual risk and owner |

**Scoring.** Likelihood and impact are each Low / Medium / High. Risk is the higher of the two if either is
High, otherwise Medium if either is Medium. "Residual" is the risk left after the controls listed.

## 1. Where ePHI lives

| Asset | Contents | Where | Protection at rest |
| --- | --- | --- | --- |
| Main database (Postgres; SQLite for one office or development) | Charts, notes, perio, treatment, ledger, insurance, claims, messages, audit log | Managed Postgres (`DATABASE_URL`) | Provider disk encryption; the app additionally encrypts 2FA secrets and SSO client secrets |
| Document storage | X-rays, photos, signed forms, PDFs, call recordings, lab files | S3-compatible bucket or local disk | AES-256-GCM per file with `DOCUMENT_ENCRYPTION_KEY` (rotatable: `npm run rotate-keys`) |
| Backups | Whole-practice exports | `BACKUP_DIR` (disk or synced bucket) | AES-256-GCM with `BACKUP_ENCRYPTION_KEY`; browser downloads leave out password hashes, 2FA secrets, API keys and signing secrets |
| Redis | Rate-limit counters, live-update events (patient ids only), idempotency fingerprints | `REDIS_URL` | Provider encryption; no names or clinical text |
| App memory and logs | Requests in flight | Hosting provider | Logs carry ids, not bodies; error reports are scrubbed of bodies, emails and phone numbers |
| Vendors (see `docs/HIPAA-vendors.md`) | What each needs for one task | Twilio, email, Lob, clearinghouse, DoseSpot, Anthropic, Deepgram, x-ray AI, labs | BAA per vendor; each call logged in Settings → Connection activity without PHI |
| Office PCs running the imaging bridge | Images on their way in | The practice's office | The practice's own controls; the bridge holds only a device key |
| Patient devices | Portal, forms, booking, confirmations | Patients' phones | Short sessions and one-purpose links (below) |

## 2. Who and what can reach it

- **Staff** sign in with a password (scrypt; common and repeated-character passwords refused), optionally
  enforced 2FA (TOTP, codes single-use), or the practice's SSO (OIDC). Sessions are recorded on the server,
  end after the practice's idle timeout (default 15 minutes), and end everywhere on password change, 2FA
  enrolment, 2FA reset and "sign out everywhere". An admin-set password must be changed at next sign-in, and
  the user is emailed when an admin changes their password or resets their 2FA.
- **Roles and offices**: every route checks a permission; sensitive actions (refunds, voids, fee changes,
  finalized notes, exports, permission changes) need the stronger one. A user limited to certain offices
  can't reach other offices' patients through any list, search, report or bulk action.
- **Tenancy**: every record carries `practice_id`, and every id from a request is checked against the
  signed-in practice.
- **Patients** reach the portal with a one-time code sent to their phone or email plus date of birth
  (2-hour sessions, ended by signing out). Forms and treatment-plan links need the date of birth; a few wrong
  tries turn the link off.
- **Machines**: API keys (hashed, scoped, revocable), webhooks from vendors (signatures checked, and
  timestamps where the vendor sends them), the imaging bridge (device key), the MCP server (a scoped key).
- **AI** acts under its own recorded identity. High-risk changes it proposes need a person's yes on screen
  (`aiguard.js`); the AI receptionist can only see or change a caller's visits after checking their name and
  date of birth.

## 3. Risks

### Confidentiality

| # | Threat | Controls in place | L | I | Residual | Owner / next step |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | One practice sees another's patients | `practice_id` on every row and check on every id; cross-tenant tests; internal review found no cross-practice access | L | H | **Medium** | Include in the outside pen test (tenant-hopping is the top test case) |
| C2 | Staff at one office see another office's patients | Office restrictions enforced on every patient route, list, report, bulk send and practice-wide page; tests | L | M | Low | — |
| C3 | Stolen staff password | scrypt, common-password block, rate limits, 2FA (enforceable per practice), SSO, idle timeout, email to the user when an admin changes their password or 2FA | M | H | **Medium** | Turn on **Require 2FA** for every practice before go-live |
| C4 | Session theft (XSS, shared computer) | Strict CSP, no inline scripts, 15-minute idle timeout, sessions ended on the server (the sign-in token lives in browser storage, so XSS is the main way to steal it) | L | H | Medium | Pen test for XSS in free-text fields (notes, messages, forms) |
| C5 | Guessing public links (confirmations, forms, plans, labs, uploads) | 256-bit random tokens stored hashed; expiry; DOB check on forms and plans; rate limits; each view of a plan or lab link audited | L | M | Low | Confirmation pages show first name and visit time without a DOB (industry norm) — accepted |
| C6 | Caller pretends to be a patient to the AI receptionist | Caller-ID alone gives nothing: first name + DOB required before any visit is read or changed, three tries per call; booking by unverified callers becomes a request for staff | M | M | Medium | Watch receptionist call logs in the first months |
| C7 | A backup file is lost or leaked | Encrypted automatic backups; browser downloads exclude password hashes, 2FA secrets, API keys and signing secrets; downloads are audited and need the export permission | L | H | Medium | Keep `BACKUP_ENCRYPTION_KEY` separate from the backups |
| C8 | Vendor sees more than it needs | Minimum data per call; payment descriptions carry no clinical detail; bank and books get totals only | M | M | Medium | **Sign every BAA** in `docs/HIPAA-vendors.md` before switching each vendor on |
| C9 | Browser speech recognition sends dictation to the browser's maker | Office speech service (Deepgram, under BAA) is used when set; otherwise the screen says the browser is listening | M | M | Medium | Set `TRANSCRIBE=deepgram` with a signed BAA before dictating real notes |
| C10 | Injection (SQL, stored XSS, ReDoS) | Parameterised queries throughout; CSP; no user HTML rendered; linear-time email checks (a backtracking regex was replaced) | L | H | Medium | Pen test |
| C11 | SSRF through webhook or SSO URLs | Addresses must resolve to public IPs; local addresses only on a developer machine | L | M | Low | DNS rebinding between check and use remains possible; outbound calls are short and responses aren't shown to users — accepted |
| C12 | Idempotency replay storing a secret | Sign-in, code, password and token-bearing requests and responses are never stored; fingerprints are HMAC'd and scoped to the user's session | L | H | Low | — |

### Integrity

| # | Threat | Controls in place | L | I | Residual | Owner / next step |
| --- | --- | --- | --- | --- | --- | --- |
| I1 | Silent change to a note, fee, payment or claim | Before/after, who, when, why and source on every important change; append-only audit log (database triggers block edits); signed notes take addenda only; ledger entries are voided or reversed, never edited | L | H | Medium | Someone reviews the audit log monthly |
| I2 | Double posting from double clicks, retries or webhooks | Idempotency keys; unique constraints on payments, postings, claims; conditional updates on single-use actions (funding, form and survey submissions, sign-ins) | L | H | Low | — |
| I3 | AI makes a high-risk change unsupervised | `aiguard.js` returns 428 without a person's approval; server-side AI checked by `requireHuman()`; AI actions carry their own source | L | H | Low | New high-risk endpoints go in `HIGH_RISK` |
| I4 | Admin account takeover changes who can prescribe | Changing a provider's prescriber link or DEA number pauses controlled-substance e-prescribing for 24 hours and emails the admins and the prescriber | L | H | Low | — |
| I5 | Forged vendor callbacks (payments, lenders, Plaid, SendGrid, Twilio) | Signatures verified; timestamps checked where available; references matched exactly; rate limits | L | H | Low | — |
| I6 | Bad import corrupts records | Dry-run preview, counts reconciled source vs imported, import runs as its own actor and can be traced | M | M | Medium | Run every conversion on staging first |

### Availability

| # | Threat | Controls in place | L | I | Residual | Owner / next step |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Database loss or corruption | Nightly encrypted backups (14 kept), restore drills with record-count checks | L | H | **Medium** | **Turn on point-in-time recovery** in the managed Postgres; record the restore time in the first drill |
| A2 | Hosting outage | Stateless app redeployable from the repository; status page; offline day sheet in the browser | M | M | Medium | Pick a second region/host and rehearse the switch once |
| A3 | Abuse of public endpoints (booking spam, bulk requests) | Per-IP and per-practice rate limits (Redis-backed when serverless), Turnstile on booking, caps on pending requests and body sizes | M | L | Low | Set `TURNSTILE_*` for practices that get spam |
| A4 | Ransomware on office PCs | App data isn't on office PCs; the imaging bridge only sends | M | M | Medium | Practice-side: endpoint protection and offline copies of imaging software data |
| A5 | Lost encryption keys | Keys required at start; rotation tool; README tells you to keep keys separately | L | H | Medium | Store keys in a password manager or secrets vault with two people able to reach them |

## 4. Internal security review, September 2026

Four passes over the code (sign-in and sessions; access control; injection and output handling; public
endpoints and webhooks) plus `npm audit` (0 known vulnerabilities in server, client and root). Nothing let
one practice reach another's data. Found and fixed:

| Area | Finding | Fix |
| --- | --- | --- |
| Duplicate-request protection | Could store sign-in responses (tokens) and request bodies with passwords/codes | Sensitive paths and bodies skipped; token-bearing responses never stored; keyed per session and per portal patient; HMAC fingerprints |
| AI receptionist | Trusted caller ID to read and change visits | Name + DOB verification, three tries; unverified bookings become requests; nothing named before verification |
| Missed-call text-back | Could be driven to text any number repeatedly | US/Canada numbers only, one text per number per day |
| Online booking | Spam and slot-holding | US/Canada phones, optional Turnstile, caps per contact and per practice, unpaid requests hold slots 48 hours |
| Office restrictions | Some lists, bulk sends and practice-wide pages ignored them | Enforced on calls, deposits, collections, statements, recalls, surveys, family, reports, exports and the audit log |
| Lender callbacks | Loose reference matching; possible double funding | Exact matching, optional timestamp signing, single conditional funding |
| Group console | Non-admins could be made owners | Owners must be admins; deactivation and demotion remove access |
| Admin takeover | Admin could set a password and prescribe as someone else | Forced change at next sign-in, email to the user, 24-hour e-Rx pause on prescriber link changes |
| OAuth connects | No state bound to the browser (CSRF) | Single-use state tied to a cookie and an active admin |
| Sign-in | SSO-required message before password check; TOTP race; weak passwords; old sessions after 2FA | Reordered; conditional step update; password policy; 2FA enrolment ends other sessions |
| ReDoS | Backtracking email pattern in several places | One linear-time `validEmail()` |
| Webhooks | Plaid key lookups on attacker-chosen ids; SendGrid replays | Key id format check, cached misses and bounded cache, rate limit; stale SendGrid batches refused |
| Public forms and surveys | Double submit could file twice | Conditional single-use updates |
| Lab and plan links | Views not audited; PDF endpoint unthrottled | Lab views audited; plan views rate-limited |
| Backups | Browser downloads contained password hashes and API key hashes | Left out |
| Uploads | "Text" files could be named `.html` | Must be UTF-8 and are saved as `.txt` (text scans keep `.stl/.obj/.ply`) |
| Portal | Sign-out only forgot the token in the browser | Ends the session on the server |
| Misc. | Status page showed the code version; ICS lone CR; phone attach without history; local URLs allowed on deployed non-production copies; serverless without Redis | All fixed; the server refuses to start serverless without Redis |

## 5. Still to do before real patient data

These can't be done from the code. They're the owner's to arrange:

1. **Outside penetration test** by an independent firm. Give them `docs/security/pentest-scope.md`. Fix
   high and critical findings before go-live; record the rest here with an owner and date.
2. **BAAs** with every vendor you switch on (`docs/HIPAA-vendors.md`), and a BAA template for practices to
   sign with you.
3. **Point-in-time recovery** turned on in the production Postgres, plus the first restore drill recorded
   (target: back up and running in 4 hours, at most 15 minutes of data lost with PITR).
4. **Name the security officer and privacy officer** and fill in the owner fields above.
5. **Workforce training** on the policies in `docs/soc2/` and yearly after that; keep sign-off records.
6. **Require 2FA** for every practice at go-live.

## 6. Review log

| Date | Who | What changed |
| --- | --- | --- |
| 2026-09-24 | Engineering (with AI assistance) | First version after the internal security review |
