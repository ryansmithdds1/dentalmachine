# Access Control Policy

**Owner:** [Security lead] · **Reviewed:** yearly

- Access to production systems (hosting, database, storage, backups, logs) is limited to named engineers who
  need it, each with their own account and MFA. No shared accounts.
- Access is requested and approved in writing ([ticket system]); the approval is kept as evidence.
- Access is removed the same day someone leaves or changes role.
- **Quarterly review:** the security lead lists everyone with production, GitHub admin and vendor-console
  access, confirms each is still needed, removes the rest, and records the review.
- Customer data in production is only viewed to resolve a customer's support request, with the customer's
  permission, and the access is logged.
- In the application, practice administrators control their own users, roles, MFA requirement, single
  sign-on and location restrictions; every patient-record access is written to the practice's audit log.
