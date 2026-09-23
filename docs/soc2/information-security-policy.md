# Information Security Policy

**Owner:** [Security lead] · **Approved by:** [CEO] · **Reviewed:** yearly

## Purpose
Protect the confidentiality, integrity and availability of customer data — including patients' protected
health information (PHI) — processed by Dental Machine.

## Scope
All employees and contractors, all systems that store or process customer data (production hosting,
databases, file storage, backups, source code, laptops) and all vendors who touch customer data.

## Principles
- **Least privilege.** Access is granted for a job need and removed when it ends (see Access Control Policy).
- **Encryption.** Data is encrypted in transit (TLS 1.2+) and at rest (database, file storage, backups).
- **No PHI where it isn't needed.** Never copy customer data to laptops, email, tickets, chat or test
  environments. Use the demo data or the sandbox modes for testing and support.
- **Logging.** Access to customer data is logged and logs are kept at least 6 years (HIPAA).
- **Vendors.** Only approved vendors with a signed BAA may receive PHI (see Vendor Management Policy).
- **Devices.** Company laptops use full-disk encryption, a screen lock of 5 minutes or less, automatic
  updates and endpoint protection.
- **Passwords and MFA.** A password manager for all company accounts; MFA on every system that offers it.

## Responsibilities
Every person reports suspected incidents immediately to [security@company]. The security lead maintains
the risk register, runs the yearly risk assessment and training, and reviews this policy yearly.

## Enforcement
Violations may result in removal of access and disciplinary action.
