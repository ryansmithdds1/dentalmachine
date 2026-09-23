# Vendor Management Policy

**Owner:** [Security lead] · **Reviewed:** yearly

- Before a vendor receives customer data: confirm the need, review its security (SOC 2 report or
  questionnaire), and sign a Business Associate Agreement if it may receive PHI. `docs/HIPAA-vendors.md`
  lists the vendors Dental Machine can connect and which need a BAA.
- Keep a vendor register: name, purpose, data shared, BAA date, SOC 2 report date, owner.
- Review each vendor yearly (new SOC 2 report, any incidents, still needed).
- Send each vendor only what its task needs (for example, the AI features send the facts for one note or
  claim, not whole records; bank and accounting connections carry no patient data).
- When a vendor is dropped, revoke its keys and confirm deletion of our data.
