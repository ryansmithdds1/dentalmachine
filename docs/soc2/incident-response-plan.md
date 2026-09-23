# Incident Response Plan

**Owner:** [Security lead] · **Tested:** yearly tabletop exercise

## 1. Detect and report
Alerts (error reporting, uptime monitor, status page), customer reports or staff observations go to
[security@company] and the on-call engineer immediately.

## 2. Triage (within 1 hour)
Classify severity: **SEV1** data exposure or full outage; **SEV2** partial outage or suspected unauthorized
access; **SEV3** everything else. Open an incident record with a timeline.

## 3. Contain and fix
Revoke compromised credentials and API keys, rotate secrets (`npm run rotate-keys` for encryption keys,
JWT_SECRET for sessions), block offending IPs, restore from backup if data was altered.

## 4. Assess for a HIPAA breach
Use the audit log to determine what PHI was accessed, by whom and for which practices. Apply the HIPAA
four-factor risk assessment. If it is a breach, notify affected practices (the covered entities) **without
unreasonable delay and within 60 days**, with what they need to notify patients and HHS.

## 5. Communicate
Update the status page for outages. Tell affected customers what happened, what data was involved and what
we did.

## 6. Learn
Blameless review within 5 business days; track fixes to completion; update this plan.
