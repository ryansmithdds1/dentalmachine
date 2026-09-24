// Office intranet (backlog I1–I3): quick links to the websites the team uses, an internal wiki of SOPs and
// how-tos with full version history, announcements, and new-hire onboarding checklists.
//
// Who sees what: every item can be limited to some offices (location_ids) and some roles (roles), both JSON
// lists where NULL means everyone. Reading is open to every signed-in person for what they may see; changing
// anything needs `intranet:manage` (administrators always have it).
//
// Nothing is hard deleted: links, sections, pages, announcements and checklists are archived; every page
// save is a new intranet_page_versions row, and restoring an old version is one more new version.
import { HttpError, can } from './auth.js';
import { restricted } from './officeaccess.js';

export const MANAGE = 'intranet:manage';
export const canManage = (user) => can(user, MANAGE);
export function requireManage(req, _res, next) {
  // Until `intranet:manage` is in PERMISSION_CATALOG (auth.js) only administrators pass; afterwards anyone
  // given it (by role or per person) does.
  return canManage(req.user) ? next() : next(new HttpError(403, 'Only managers can change the office intranet'));
}

export const ROLES = ['admin', 'dentist', 'hygienist', 'assistant', 'front_desk', 'billing'];
export const LINK_CATEGORIES = ['insurance', 'labs', 'supplies', 'payroll', 'other'];

export const nowText = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
export const parseList = (v) => {
  if (v == null || v === '') return null;
  try {
    const list = JSON.parse(v);
    return Array.isArray(list) && list.length ? list : null;
  } catch {
    return null;
  }
};

// A link's address: a real http(s) web address and nothing else. javascript:, data:, file:, vbscript: and
// friends are refused, and so are addresses with a user name or password in them (a phishing trick).
export function cleanUrl(value) {
  const s = String(value ?? '').trim();
  if (!s) throw new HttpError(400, 'Enter the website address');
  if (s.length > 2000) throw new HttpError(400, 'That address is too long');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(s)) throw new HttpError(400, 'A website address can’t contain spaces');
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    throw new HttpError(400, 'That doesn’t look like a website address');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'Only web addresses (https:// or http://) can be saved as links');
  if (u.username || u.password) throw new HttpError(400, 'Don’t put a user name or password in the address');
  if (!u.hostname || !/^[a-z0-9.-]+$/i.test(u.hostname) || !u.hostname.includes('.')) {
    if (u.hostname !== 'localhost') throw new HttpError(400, 'That doesn’t look like a website address');
  }
  return u.href;
}

export function cleanText(value, name, max, { required = false } = {}) {
  const s = value == null ? '' : String(value).trim();
  if (!s) {
    if (required) throw new HttpError(400, `${name} is required`);
    return null;
  }
  if (s.length > max) throw new HttpError(400, `${name} is too long (at most ${max} characters)`);
  return s;
}
// One line (titles, names): control characters become spaces.
// eslint-disable-next-line no-control-regex
export const oneLine = (value, name, max, opts) => cleanText(value == null ? value : String(value).replace(/[\u0000-\u001f\u007f]+/g, ' '), name, max, opts);

export function cleanRoles(value) {
  if (value == null || value === '') return null;
  if (!Array.isArray(value)) throw new HttpError(400, 'roles must be a list');
  const list = [...new Set(value.map(String))];
  const bad = list.find((r) => !ROLES.includes(r));
  if (bad) throw new HttpError(400, `Unknown role: ${bad}`);
  return list.length ? JSON.stringify(list.sort()) : null;
}

// Offices must be the practice's own.
export async function cleanLocations(db, practiceId, value) {
  if (value == null || value === '') return null;
  if (!Array.isArray(value)) throw new HttpError(400, 'location_ids must be a list');
  const ids = [...new Set(value.map(Number))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new HttpError(400, 'location_ids must be office ids');
  if (!ids.length) return null;
  const found = await db.all(`SELECT id FROM locations WHERE practice_id = ? AND id IN (${ids.map(() => '?').join(',')})`, practiceId, ...ids);
  if (found.length !== ids.length) throw new HttpError(400, 'One of those offices isn’t part of this practice');
  return JSON.stringify(ids.sort((a, b) => a - b));
}

// May this person see this item? Roles first (administrators see every role's items), then offices: the
// office the screen is working in, else the person's own offices; someone at every office sees them all.
export function canSee(item, user, locationId) {
  const roles = parseList(item.roles);
  if (roles && user.role !== 'admin' && !roles.includes(user.role)) return false;
  const locs = parseList(item.location_ids);
  if (!locs) return true;
  if (locationId) return locs.includes(Number(locationId));
  if (restricted(user)) return user.location_ids.some((id) => locs.includes(id));
  return true;
}
// For reports (who hasn't acknowledged): would this team member see it at any of their offices?
export function wouldSee(item, member) {
  const roles = parseList(item.roles);
  if (roles && member.role !== 'admin' && !roles.includes(member.role)) return false;
  const locs = parseList(item.location_ids);
  const theirs = parseList(member.location_ids);
  return !locs || !theirs || theirs.some((id) => locs.includes(Number(id)));
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A short piece of the body around the first match, as plain text (Markdown marks removed).
export function snippet(body, q, width = 140) {
  const plain = String(body || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim();
  const at = plain.toLowerCase().indexOf(String(q).toLowerCase());
  if (at < 0) return plain.slice(0, width);
  const start = Math.max(0, at - 40);
  return `${start ? '…' : ''}${plain.slice(start, start + width)}${start + width < plain.length ? '…' : ''}`;
}

// Suggested links for a dental office. Suggestions only — nothing is created until an administrator adds
// one. Many carriers have regional provider portals, so the saved address can be changed afterwards.
export const STARTER_LINKS = [
  { key: 'delta-dental', title: 'Delta Dental', url: 'https://www.deltadental.com/', category: 'insurance', note: 'Delta Dental portals differ by state — change it to your region’s provider portal' },
  { key: 'metlife', title: 'MetLife Dental', url: 'https://metdental.com/', category: 'insurance' },
  { key: 'cigna', title: 'Cigna for HCP', url: 'https://cignaforhcp.cigna.com/', category: 'insurance' },
  { key: 'aetna', title: 'Aetna Dental', url: 'https://www.aetna.com/health-care-professionals.html', category: 'insurance' },
  { key: 'uhc', title: 'UnitedHealthcare Dental', url: 'https://www.uhcprovider.com/', category: 'insurance' },
  { key: 'guardian', title: 'Guardian', url: 'https://www.guardiananytime.com/', category: 'insurance' },
  { key: 'availity', title: 'Availity', url: 'https://www.availity.com/', category: 'insurance' },
  { key: 'henry-schein', title: 'Henry Schein', url: 'https://www.henryschein.com/', category: 'supplies' },
  { key: 'patterson', title: 'Patterson Dental', url: 'https://www.pattersondental.com/', category: 'supplies' },
  { key: 'benco', title: 'Benco Dental', url: 'https://shop.benco.com/', category: 'supplies' },
  { key: 'darby', title: 'Darby Dental', url: 'https://www.darbydental.com/', category: 'supplies' },
  { key: 'glidewell', title: 'Glidewell', url: 'https://glidewelldental.com/', category: 'labs' },
  { key: 'gusto', title: 'Gusto', url: 'https://app.gusto.com/', category: 'payroll' },
  { key: 'adp', title: 'ADP Workforce Now', url: 'https://workforcenow.adp.com/', category: 'payroll' },
  { key: 'paychex', title: 'Paychex Flex', url: 'https://myapps.paychex.com/', category: 'payroll' },
];

const TEMPLATE_NOTE = '> **Template — adapt this to your office.** Change the steps, names and numbers to match how you work, then remove this note.';

// Starter SOP pages. Offered, never created on their own; each is clearly marked as a template to adapt.
export const PAGE_TEMPLATES = [
  {
    key: 'opening-closing', title: 'Opening and closing checklist', section: 'Daily operations', ack: false, review: 365,
    body: `${TEMPLATE_NOTE}

## Opening (first person in)
- [ ] Turn off the alarm and unlock the front door at **7:30**
- [ ] Turn on the compressor, vacuum and water lines; run the waterline flush
- [ ] Start the autoclave test cycle and record the result in the sterilization log
- [ ] Turn on computers, x-ray sensors and the phone system; check messages
- [ ] Check today's schedule for gaps and unconfirmed patients
- [ ] Stock each operatory (gloves, masks, bibs, barriers)

## Closing (last person out)
- [ ] Every operatory cleaned and disinfected, barriers removed
- [ ] Instruments processed; nothing left in the ultrasonic
- [ ] Autoclave and compressor off; vacuum and water off
- [ ] Day closed out in Dental Machine (payments posted, deposit prepared)
- [ ] Computers locked or logged off, lights off, alarm set, doors locked

**Questions?** Ask the office manager.`,
  },
  {
    key: 'medical-emergency', title: 'Emergency: medical emergency in the chair', section: 'Emergencies', ack: true, review: 180,
    body: `${TEMPLATE_NOTE}

Follow your team's current BLS/CPR training and your emergency drug kit's instructions. This page is a reminder of **who does what**, not medical guidance.

## Right away
1. **Stop treatment** and remove anything from the patient's mouth.
2. **Call out for help** — say "Medical emergency in operatory __".
3. Position the patient (usually supine; upright if short of breath) and check responsiveness and breathing.
4. If unresponsive or not breathing normally: **call 911**, start CPR and **bring the AED**.

## Roles
| Who | Does |
|---|---|
| Dentist | Leads, assesses the patient, decides on medications |
| Assistant #1 | Brings the **emergency kit, oxygen and AED** |
| Front desk | **Calls 911**, meets EMS at the door, keeps the waiting room calm |
| Assistant #2 | Records times, vital signs and anything given |

## Where things are
- Emergency kit and oxygen: ____________
- AED: ____________

## Afterwards
- [ ] Write a clinical note with times, vitals and what was given
- [ ] Restock the emergency kit and check oxygen level
- [ ] Tell the office manager; review what went well at the next huddle`,
  },
  {
    key: 'sterilization', title: 'Sterilization and instrument processing', section: 'Clinical', ack: true, review: 365,
    body: `${TEMPLATE_NOTE}

## Every instrument, every time
1. **Transport** used instruments in a closed, labeled container.
2. **Clean** — ultrasonic or washer; never hand-scrub without heavy-duty gloves.
3. **Rinse and dry**, then inspect for debris and damage.
4. **Package** in pouches or wrapped cassettes with an internal indicator; label the date and sterilizer.
5. **Sterilize** following the manufacturer's cycle.
6. **Check** external and internal indicators before storing.
7. **Store** in a clean, dry, closed area; first in, first out.

## Monitoring
- [ ] Weekly spore (biological) test — record the result in the log
- [ ] Every load: check the physical readouts (time, temperature, pressure)
- [ ] A failed spore test: take the sterilizer out of use and tell the office manager right away

## Personal protection
Heavy-duty gloves, mask, eye protection and gown whenever handling contaminated instruments.`,
  },
  {
    key: 'new-patient-call', title: 'New patient call script', section: 'Front desk', ack: false, review: 365,
    body: `${TEMPLATE_NOTE}

## Greeting
"Thank you for calling **[Office name]**, this is **[your name]**. How can I help you today?"

## Get to know them
- "May I have your first and last name, and the best number to reach you?"
- "How did you hear about us?"
- "What's the main reason you'd like to come in?" (pain → offer the soonest emergency time)

## Insurance
- "Do you have dental insurance?" — carrier, subscriber name and date of birth, member ID
- "We'll check your benefits before your visit and let you know what to expect."

## Book it
- Offer **two times**: "I have Tuesday at 9 or Thursday at 2 — which works better?"
- Confirm the time, the address and parking.
- "I'll text you a link to fill in your forms before you come in."

## Close
"We look forward to seeing you, **[name]**. Is there anything else I can help with?"`,
  },
  {
    key: 'payment-dispute', title: 'Handling a payment dispute', section: 'Billing', ack: false, review: 365,
    body: `${TEMPLATE_NOTE}

## When a patient questions a bill
1. **Listen** and thank them for calling; don't argue about the amount on the first call.
2. Open their **ledger** and walk through the charges, insurance payments and adjustments line by line.
3. Check the **EOB**: was the claim paid, denied or still pending? Is there a write-off missing?
4. If it's our mistake: correct it the right way (reverse or adjust — never delete) and tell them what changed.
5. If insurance underpaid: offer to resubmit or appeal, and put the balance on hold while we do.
6. If they still disagree: take a note of what they said and pass it to the office manager within **1 business day**.

## Card disputes (chargebacks)
- [ ] Tell the office manager the same day
- [ ] Gather the signed treatment plan, consent, the visit note and the receipt
- [ ] Respond to the processor before the deadline on the notice

## Never
- Never promise a write-off without the office manager's OK.
- Never discuss the account with anyone but the patient or guarantor.`,
  },
];
