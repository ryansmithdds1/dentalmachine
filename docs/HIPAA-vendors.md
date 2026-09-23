# Vendors and Business Associate Agreements

Any outside service that stores, sends or can see patient information (PHI) on the practice's behalf is a
*business associate*, and HIPAA requires a signed Business Associate Agreement (BAA) with it **before** real
patient data goes in. This is the list for Dental Machine, what each one sees, and what to do.

Vendors change their plans and terms. Confirm each BAA with the vendor when you sign up, and keep a signed
copy. Nothing here is legal advice.

## Needs a BAA

| Service | Set by | What it sees | Notes |
| --- | --- | --- | --- |
| **App hosting** (Vercel, Render, AWS, your own server's host) | where you deploy | Everything, in memory and logs | BAAs are usually only on paid or enterprise plans. |
| **Database** (Postgres: Supabase, Neon, RDS, Render…) | `DATABASE_URL` | The whole record | Turn on encrypted, point-in-time backups too. |
| **File storage** (S3, R2, B2, MinIO host) | `S3_*` | X-rays, photos, documents (encrypted by the app when `DOCUMENT_ENCRYPTION_KEY` is set) | Still a business associate even when files are encrypted. |
| **Backups folder** (the disk or synced bucket behind `BACKUP_DIR`) | `BACKUP_DIR` | Full practice backups (encrypted with `BACKUP_ENCRYPTION_KEY`) | Same as file storage. |
| **Redis** (Upstash, Redis Cloud…) | `REDIS_URL` | Rate-limit counters and live-update events; events carry patient ids, not names or clinical details | Get a BAA from a managed provider, or run Redis on your own host. |
| **Text messages** (Twilio) | `TWILIO_*` | Patient phone numbers and message text (reminders, replies) | Twilio signs BAAs for its HIPAA-eligible products; ask for it. |
| **Email** | `SENDGRID_API_KEY` | Patient emails and message text | Check before relying on SendGrid: Twilio's BAA has not covered SendGrid. A HIPAA-eligible email service (e.g. Paubox, or Amazon SES under an AWS BAA) may be needed instead. |
| **Mailed statements** (Lob) | `LOB_API_KEY` | Names, addresses, balances and statement lines | Ask Lob for its HIPAA/BAA option before mailing real statements. |
| **Error monitoring** (Sentry or similar) | `SENTRY_DSN` | Error reports. The app strips request bodies, quoted values, emails and phone numbers, but stack traces and routes can still hint at patients | Get a BAA (Sentry offers one on business plans), self-host it (GlitchTip or Bugsink), or leave `SENTRY_DSN` unset. |
| **Clearinghouse** | `CLEARINGHOUSE`, `CH_*` | Claims, eligibility, remittances | Clearinghouses sign BAAs as standard. |
| **E-prescribing** (DoseSpot) | `ERX_*` | Prescriptions and patient demographics | Standard BAA with DoseSpot. |
| **The assistant** (Anthropic's Claude API) | `ANTHROPIC_API_KEY` | What staff say to it, and what it looks up to answer: patient names, dates of birth, appointments, balances, notes and perio readings being entered | Anthropic signs BAAs for its API; ask for one (and zero data retention) before using the assistant with real patients. Leave the key unset (or `ASSISTANT=off`) until then. |
| **Speech recognition in the browser** (voice input to the assistant) | the staff member's browser | The spoken words | Chrome's built-in recognition sends audio to Google's servers unless it runs on the device. The app asks for on-device recognition where the browser supports it, but can't guarantee it. Until a BAA-covered speech service is added, type instead of speaking for anything identifying, or use a browser with on-device recognition. |
| **Claim attachments** (NEA/Vyne, DentalXChange) | `ATTACHMENTS_*` | X-rays and narratives sent with claims | Standard BAA. |
| **Payment terminals / card processing** (Stripe) | `STRIPE_*` | Name, amount, card | Processing a payment is generally exempt from the BAA requirement (HIPAA §1179), and Stripe does not sign BAAs. Keep clinical detail out of payment descriptions. The app sends the patient's name and email, amounts and plain descriptions ("account payment"; for an online-booking deposit, the visit type, such as "New patient exam"). |

## Usually doesn't need one

| Service | Why |
| --- | --- |
| **Single sign-on** (Google, Microsoft, Okta) | Sees staff identities only, never patient data. |
| **Your own imaging software** on office PCs | Runs inside the practice. The imaging bridge connects it to the app. |
| **Domain and DNS** | Doesn't carry the data. (The TLS certificate and CDN in front of the app is part of hosting.) |

## Before going live

- [ ] A signed BAA with every "needs a BAA" service you have turned on.
- [ ] `NODE_ENV=production`. The server refuses to start without strong keys, encryption and an https address.
- [ ] `REGISTRATION=invite` (the default). Hand out practice sign-ups with `npm run invite`.
- [ ] Keys (`JWT_SECRET`, `DOCUMENT_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY`) are stored somewhere safe besides the server. Losing a key means losing what it encrypted. See *Changing encryption keys* in the README.
- [ ] Each practice has signed its own BAA with you, as the software vendor hosting their data.
- [ ] Someone reviews **Settings → Audit log** regularly, and knows how to answer a patient's records request (**Export record** on the chart).
