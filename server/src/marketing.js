// ---- Marketing ROI, end to end (MK1–MK2, docs/marketing.md, docs/workflows/specs/MK-marketing.md) ----
// Where every lead and new patient came from, and what they went on to produce.
//
// MK1 attribution. Evidence of where someone came from is a *touch* (marketing_touches), recorded once each
// (touch_key) from what the system already knows:
//   - an online booking: its promo code, patient referral code (?rp=), utm_campaign / utm_source / ?src= tags;
//   - a call: the call-tracking line it rang (tracking_numbers → calls.source), and whether it was a new caller;
//   - the chart: "How did you hear about us?" (patients.referral_source, from the patient form, intake paperwork
//     or the booking page; a promo code typed there counts as the promo), the referring doctor (referred_by_id),
//     and patient-to-patient referrals (journey_referrals).
// A patient's first touch and last touch are the earliest and latest touches up to their first visit (the
// metrics.js new-patient rule); patients.marketing_first_touch_id / marketing_last_touch_id point at them.
// A person can correct them (a 'staff' touch, pinned so the automatic rules leave it alone) — audited with a
// reason, and reversible ("back to automatic").
//
// MK2 ROI. New patients are the metrics.js definition (first completed visit in the range). Their production and
// collections come from the ledger (SUM(amount), integer cents, voided entries and reversals left out) within 30,
// 90, 180 and 365 days of that visit and to date. Costs (marketing_costs, voided ones left out) are spread evenly
// over their days, so a quarter's spend lands in its months. ROI, cost per lead / new patient, payback months and
// lifetime value follow from those — each formula is written down in docs/marketing.md.
//
// Capture runs by itself (the marketing job: new records hourly, a full pass and a backfill for charts made with
// no source nightly) and just before the dashboard or a chart's attribution is shown, so nothing waits for it.
import { randomBytes } from 'node:crypto';
import { HttpError, can } from './auth.js';
import { audit, update, utcRange, practiceNow, localNow, isRealDate, toCsv } from './util.js';
import { withActor } from './actor.js';
import { patientScope, restricted } from './officeaccess.js';
import { ensureJourneySchema } from './journeys.js';

export const CHANNELS = ['google_ads', 'facebook', 'instagram', 'google_business', 'website_organic', 'referral_patient', 'referral_doctor', 'insurance_directory', 'mailer', 'event', 'walk_in', 'other'];
export const CHANNEL_LABELS = {
  google_ads: 'Google Ads', facebook: 'Facebook', instagram: 'Instagram', google_business: 'Google Business Profile', website_organic: 'Website / search',
  referral_patient: 'Patient referral', referral_doctor: 'Doctor referral', insurance_directory: 'Insurance directory', mailer: 'Mailer', event: 'Event', walk_in: 'Walk-in', other: 'Other',
};
export const METHODS = ['utm', 'tracking_number', 'promo_code', 'referral', 'staff', 'online_booking', 'call'];
export const METHOD_LABELS = {
  utm: 'Link tags (UTM)', tracking_number: 'Call-tracking number', promo_code: 'Promo code', referral: 'Referral', staff: 'Told us (staff / intake)',
  online_booking: 'Online booking (no tags)', call: 'Called the main number',
};
export const WINDOWS = [30, 90, 180, 365];
const PAYBACK_MAX_MONTHS = 36;
const NOT_RECORDED = 'Not recorded';

// The sources every practice starts with (renamed, retired or added to on the Marketing screen). Keys are the
// words that mean the source in a utm_source, ?src=, tracking line name or a "how did you hear" answer.
export const DEFAULT_SOURCES = [
  { channel: 'google_ads', name: 'Google Ads', keys: 'google-ads,googleads,adwords,gads,google-cpc,ppc' },
  { channel: 'facebook', name: 'Facebook', keys: 'facebook,fb,meta' },
  { channel: 'instagram', name: 'Instagram', keys: 'instagram,ig' },
  { channel: 'google_business', name: 'Google Business Profile', keys: 'gbp,gmb,google-business,google-maps,maps,google-business-profile' },
  { channel: 'website_organic', name: 'Website / search', keys: 'website,web,site,direct,google,bing,yahoo,duckduckgo,organic,search,internet' },
  { channel: 'referral_doctor', name: 'Doctor referral', keys: 'doctor,dentist,physician,specialist,doctor-referral' },
  { channel: 'referral_patient', name: 'Patient referral', keys: 'friend,family,patient-referral,referral,word-of-mouth,existing-patient,friend-or-family' },
  { channel: 'insurance_directory', name: 'Insurance directory', keys: 'insurance,insurance-directory,directory,delta,cigna,aetna,metlife,guardian,zocdoc' },
  { channel: 'mailer', name: 'Mailer', keys: 'mailer,postcard,mail,direct-mail,flyer' },
  { channel: 'event', name: 'Community event', keys: 'event,fair,school,health-fair,community' },
  { channel: 'walk_in', name: 'Walk-in / drove by', keys: 'walk-in,walkin,drove-by,drive-by,sign,signage,walked-in' },
  { channel: 'other', name: 'Other', keys: 'other,yelp,tv,radio,newspaper' },
];
// "How did you hear" answers that don't say where someone came from.
const NOT_A_SOURCE = new Set(['', 'online-booking', 'not-recorded', 'unknown', 'none', 'n-a', 'na']);
const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'paid', 'paid-search', 'paidsearch', 'ads', 'ad', 'sem', 'display']);

// ---- Small helpers ----
export const slug = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const keyList = (s) => String(s || '').split(',').map((k) => slug(k)).filter(Boolean);
const has = (text, key) => `-${text}-`.includes(`-${key}-`);
const num = (v) => Number(v || 0);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);
const LIVE = (a = 'l') => `${a}.voided_at IS NULL AND ${a}.reverses_id IS NULL`;
const IN = (list) => list.map(() => '?').join(',');
const tail10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
export const cleanPromo = (v) => (/^[A-Za-z0-9_-]{2,20}$/.test(String(v ?? '').trim()) ? String(v).trim().toUpperCase() : null);
export const cleanUtm = (v) => (/^[a-z0-9][a-z0-9_.-]{0,39}$/i.test(String(v ?? '').trim()) ? String(v).trim().toLowerCase() : null);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
async function chunks(ids, fn, size = 500) {
  for (let i = 0; i < ids.length; i += size) await fn(ids.slice(i, i + size));
}
const tzOf = async (db, pid) => (await db.get('SELECT timezone FROM practices WHERE id = ?', pid))?.timezone || 'America/New_York';
// A UTC 'YYYY-MM-DD HH:MM:SS' stamp as the practice's local date.
const localDate = (tz, utc) => localNow(tz, new Date(`${String(utc).replace(' ', 'T').slice(0, 19)}Z`)).slice(0, 10);

// ---- Sources and campaigns ----
const ensured = new WeakMap();
export async function ensureSources(db, pid) {
  if (!ensured.has(db)) ensured.set(db, new Set());
  if (ensured.get(db).has(pid)) return;
  if (!(await db.get('SELECT id FROM marketing_sources WHERE practice_id = ? LIMIT 1', pid))) {
    for (const s of DEFAULT_SOURCES) {
      await db.run('INSERT INTO marketing_sources (practice_id, channel, name, match_keys) VALUES (?, ?, ?, ?) ON CONFLICT (practice_id, name) DO NOTHING', pid, s.channel, s.name, s.keys);
    }
  }
  ensured.get(db).add(pid);
}

async function loadCatalog(db, pid) {
  await ensureSources(db, pid);
  const sources = await db.all('SELECT * FROM marketing_sources WHERE practice_id = ? ORDER BY id', pid);
  const campaigns = await db.all('SELECT * FROM marketing_campaigns WHERE practice_id = ? ORDER BY id', pid);
  const tracking = await db.all('SELECT id, number, source FROM tracking_numbers WHERE practice_id = ?', pid);
  return { sources, campaigns, tracking };
}

// Channel order for matching free text: the more specific first ("doctor referral" is a doctor, not a patient).
const MATCH_ORDER = ['referral_doctor', 'referral_patient', 'google_ads', 'google_business', 'facebook', 'instagram', 'insurance_directory', 'mailer', 'event', 'walk_in', 'website_organic', 'other'];
const byOrder = (a, b) => MATCH_ORDER.indexOf(a.channel) - MATCH_ORDER.indexOf(b.channel) || a.id - b.id;

// The practice's source for a piece of text (a "how did you hear" answer, a tracking line name, a utm_source).
// Exact name first, then the source's own keys; retired sources still match history.
export function matchText(catalog, text) {
  const t = slug(text);
  if (NOT_A_SOURCE.has(t)) return null;
  const list = [...catalog.sources].sort((a, b) => (b.active - a.active) || byOrder(a, b));
  const exact = list.find((s) => slug(s.name) === t);
  if (exact) return exact;
  for (const s of list) if (keyList(s.match_keys).some((k) => k === t)) return s;
  for (const s of list) if (keyList(s.match_keys).some((k) => has(t, k))) return s;
  return null;
}
const channelSource = (catalog, channel) => catalog.sources.filter((s) => s.channel === channel).sort((a, b) => (b.active - a.active) || a.id - b.id)[0] || null;
const campaignOn = (c, day) => (!c.starts_on || day >= c.starts_on) && (!c.ends_on || day <= c.ends_on);

// Where an online booking came from. Most precise evidence wins: a promo code, a patient's referral code, the
// campaign tag, then the source tags; with no tags at all they still found the booking page (the website).
export function resolveBooking(catalog, b, day) {
  const detail = [b.utm_source && `utm_source=${b.utm_source}`, b.utm_medium && `utm_medium=${b.utm_medium}`, b.utm_campaign && `utm_campaign=${b.utm_campaign}`,
    b.src && b.src !== b.utm_source && !['direct', 'referral'].includes(b.src) && `src=${b.src}`, b.referrer_host && `from ${b.referrer_host}`, b.promo_code && `promo ${b.promo_code}`].filter(Boolean).join(', ') || null;
  const promo = cleanPromo(b.promo_code);
  const byPromo = promo && catalog.campaigns.find((c) => c.promo_code === promo);
  if (byPromo) return { source_id: byPromo.source_id, campaign_id: byPromo.id, method: 'promo_code', detail };
  if (b.referrer_patient_id) return { source_id: channelSource(catalog, 'referral_patient')?.id ?? null, campaign_id: null, method: 'referral', detail };
  const utmCampaign = cleanUtm(b.utm_campaign);
  const byTag = utmCampaign && catalog.campaigns.find((c) => c.utm_campaign === utmCampaign);
  if (byTag) return { source_id: byTag.source_id, campaign_id: byTag.id, method: 'utm', detail };
  const tag = cleanUtm(b.utm_source) || (['direct', 'referral'].includes(b.src) ? null : cleanUtm(b.src));
  if (tag) {
    const medium = slug(b.utm_medium);
    let s = null;
    if (/^google/.test(tag) && PAID_MEDIUMS.has(medium)) s = channelSource(catalog, 'google_ads');
    s = s || matchText(catalog, tag) || channelSource(catalog, 'other');
    return { source_id: s?.id ?? null, campaign_id: null, method: 'utm', detail };
  }
  if (b.referrer_host) {
    const host = b.referrer_host.toLowerCase().split('.').filter((x) => !['www', 'm', 'l', 'com', 'org', 'net', 'co'].includes(x)).join('-');
    const s = matchText(catalog, host) || channelSource(catalog, 'other');
    return { source_id: s?.id ?? null, campaign_id: null, method: 'utm', detail };
  }
  return { source_id: channelSource(catalog, 'website_organic')?.id ?? null, campaign_id: null, method: 'online_booking', detail };
}

// A call: the tracking line it rang (and the campaign using that line on the day), else the main number.
export function resolveCall(catalog, call, day) {
  const line = catalog.tracking.find((t) => tail10(t.number) && tail10(t.number) === tail10(call.to_number));
  const camp = line && catalog.campaigns.find((c) => c.tracking_number_id === line.id && campaignOn(c, day));
  if (camp) return { source_id: camp.source_id, campaign_id: camp.id, method: 'tracking_number', detail: `Tracking line: ${line.source}` };
  const name = call.source || line?.source;
  if (name) return { source_id: null, campaign_id: null, method: 'tracking_number', detail: `Tracking line: ${name}`, line: name };
  return { source_id: null, campaign_id: null, method: 'call', detail: null };
}

// A tracking line nobody has matched to a source yet becomes one (named after the line), so its calls are counted.
async function sourceForLine(db, pid, catalog, name) {
  const found = matchText(catalog, name);
  if (found) return found;
  const guess = DEFAULT_SOURCES.find((d) => keyList(d.keys).some((k) => has(slug(name), k)))?.channel || 'other';
  await db.run('INSERT INTO marketing_sources (practice_id, channel, name, match_keys) VALUES (?, ?, ?, ?) ON CONFLICT (practice_id, name) DO NOTHING', pid, guess, String(name).slice(0, 80), slug(name));
  const row = await db.get('SELECT * FROM marketing_sources WHERE practice_id = ? AND name = ?', pid, String(name).slice(0, 80));
  if (row && !catalog.sources.some((s) => s.id === row.id)) catalog.sources.push(row);
  await audit(db, null, 'marketing.source_added', 'marketing_sources', row?.id ?? null, { name: row?.name, channel: guess, from: 'call-tracking line' }, { source: 'automation', actor: 'Marketing capture' });
  return row;
}

// A "how did you hear about us" answer: a promo code, then a source by name or words.
export function resolveAnswer(catalog, text) {
  const promo = cleanPromo(text);
  const byPromo = promo && catalog.campaigns.find((c) => c.promo_code === promo);
  if (byPromo) return { source_id: byPromo.source_id, campaign_id: byPromo.id, method: 'promo_code' };
  const camp = catalog.campaigns.find((c) => slug(c.name) === slug(text));
  if (camp) return { source_id: camp.source_id, campaign_id: camp.id, method: 'staff' };
  const s = matchText(catalog, text);
  return s ? { source_id: s.id, campaign_id: null, method: 'staff' } : null;
}

// ---- Touches ----
// Recorded once per key; returns true when it was new. A later look at the same record only fills in the
// patient (a caller attached to a chart, a request accepted) — the evidence itself never changes.
async function addTouch(db, pid, t) {
  const r = await db.run(
    `INSERT INTO marketing_touches (practice_id, patient_id, touch_key, method, source_id, campaign_id, lead, lead_kind, entity, entity_id, detail, occurred_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (practice_id, touch_key) DO NOTHING`,
    pid, t.patient_id ?? null, t.key, t.method, t.source_id ?? null, t.campaign_id ?? null, t.lead ? 1 : 0, t.lead_kind ?? null, t.entity ?? null, t.entity_id ?? null,
    t.detail ? String(t.detail).slice(0, 300) : null, t.occurred_at, t.created_by ?? null,
  );
  if (r.changes) return true;
  if (t.patient_id) await db.run('UPDATE marketing_touches SET patient_id = ? WHERE practice_id = ? AND touch_key = ? AND patient_id IS NULL', t.patient_id, pid, t.key);
  return false;
}

async function cursor(db, pid, name) {
  await db.run('INSERT INTO marketing_sync_state (practice_id, name) VALUES (?, ?) ON CONFLICT (practice_id, name) DO NOTHING', pid, name);
  return db.get('SELECT * FROM marketing_sync_state WHERE practice_id = ? AND name = ?', pid, name);
}
const moveCursor = (db, pid, name, lastId) => db.run('UPDATE marketing_sync_state SET last_id = ? WHERE practice_id = ? AND name = ? AND last_id < ?', lastId, pid, name, lastId);

// Reads what's new since last time (everything when full) into touches, then refreshes the attribution of every
// patient whose touches changed. Returns { touches, patients }.
export function syncPractice(db, pid, opts = {}) {
  // What capture changes is the system's doing, whoever's screen asked for fresh numbers.
  return withActor({ source: 'automation', actor: 'Marketing capture', practiceId: pid }, () => capture(db, pid, opts));
}
async function capture(db, pid, { full = false } = {}) {
  const catalog = await loadCatalog(db, pid);
  const tz = await tzOf(db, pid);
  const touched = new Set();
  let added = 0;
  const note = (pt, isNew) => { if (pt) touched.add(pt); if (isNew) added++; };

  // Online bookings (and the older request form): one touch per person asking for a visit. Requests the AI
  // receptionist takes on a call aren't online (the call is the lead).
  const cb = await cursor(db, pid, 'booking_requests');
  const bookings = await db.all(
    `SELECT br.id, br.patient_id, br.new_patient, br.created_at, br.source AS br_source, ob.id AS ob_id, ob.source, ob.utm_source, ob.utm_medium, ob.utm_campaign, ob.referrer_host, ob.promo_code, ob.referral_code
     FROM real_booking_requests br LEFT JOIN online_bookings ob ON ob.id = br.online_booking_id
     WHERE br.practice_id = ? AND br.id > ? AND (br.online_booking_id IS NOT NULL OR br.ip IS NOT NULL OR br.source IS NOT NULL) ORDER BY br.id LIMIT 5000`, pid, full ? 0 : cb.last_id,
  );
  for (const b of bookings) {
    const code = b.referral_code ? await db.get('SELECT patient_id FROM marketing_referral_codes WHERE practice_id = ? AND code = ?', pid, b.referral_code) : null;
    const referrer = code && code.patient_id !== b.patient_id ? code.patient_id : null;
    const r = resolveBooking(catalog, { src: b.source || b.br_source, utm_source: b.utm_source, utm_medium: b.utm_medium, utm_campaign: b.utm_campaign, referrer_host: b.referrer_host, promo_code: b.promo_code, referrer_patient_id: referrer }, localDate(tz, b.created_at));
    note(b.patient_id, await addTouch(db, pid, { key: `booking:${b.id}`, patient_id: b.patient_id, ...r, lead: Number(b.new_patient) === 1, lead_kind: 'online', entity: 'booking_requests', entity_id: b.id, occurred_at: b.created_at }));
    if (referrer && b.patient_id) await linkPatientReferral(db, pid, referrer, b.patient_id);
  }
  if (bookings.length) await moveCursor(db, pid, 'booking_requests', bookings.at(-1).id);

  // Calls in: to a tracking line (a touch even from someone we know) or from a new caller (a lead). A caller who
  // rings three times is one lead: only their first call from that number counts.
  const cc = await cursor(db, pid, 'calls');
  const calls = await db.all(
    `SELECT id, patient_id, from_number, to_number, source, new_caller, created_at FROM real_calls calls
     WHERE practice_id = ? AND direction = 'inbound' AND id > ? ORDER BY id LIMIT 5000`, pid, full ? 0 : cc.last_id,
  );
  for (const c of calls) {
    const r = resolveCall(catalog, c, localDate(tz, c.created_at));
    if (r.method === 'call' && !Number(c.new_caller)) continue;
    if (r.line && !r.source_id) r.source_id = (await sourceForLine(db, pid, catalog, r.line))?.id ?? null;
    const repeat = Number(c.new_caller) && c.from_number
      ? await db.get("SELECT id FROM real_calls calls WHERE practice_id = ? AND direction = 'inbound' AND from_number = ? AND id < ? LIMIT 1", pid, c.from_number, c.id) : null;
    note(c.patient_id, await addTouch(db, pid, { key: `call:${c.id}`, patient_id: c.patient_id, source_id: r.source_id, campaign_id: r.campaign_id, method: r.method, detail: r.detail, lead: Number(c.new_caller) === 1 && !repeat, lead_kind: 'call', entity: 'calls', entity_id: c.id, occurred_at: c.created_at }));
  }
  if (calls.length) await moveCursor(db, pid, 'calls', calls.at(-1).id);

  // The chart: what they told us, the referring doctor. A changed answer replaces the touch it made (the chart's
  // own history shows the edit); dated when the chart was made.
  // Charts made since last time, and any made in the last three days (the answer is often typed in a little later);
  // everything on the nightly full pass.
  const cp = await cursor(db, pid, 'patients');
  const recent = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  const pts = await db.all(
    `SELECT p.id, p.referral_source, p.referred_by_id, p.created_at, rc.name AS doctor FROM real_patients p LEFT JOIN referral_contacts rc ON rc.id = p.referred_by_id
     WHERE p.practice_id = ? AND (p.id > ? OR p.created_at >= ?) AND p.merged_into_id IS NULL AND (p.referral_source IS NOT NULL OR p.referred_by_id IS NOT NULL) ORDER BY p.id LIMIT 20000`,
    pid, full ? 0 : cp.last_id, full ? '0000' : recent,
  );
  for (const p of pts) {
    const r = p.referral_source ? resolveAnswer(catalog, p.referral_source) : null;
    if (r) {
      const had = await db.get('SELECT * FROM marketing_touches WHERE practice_id = ? AND touch_key = ?', pid, `answer:${p.id}`);
      if (had && (had.source_id !== r.source_id || had.campaign_id !== r.campaign_id)) {
        await db.run('UPDATE marketing_touches SET source_id = ?, campaign_id = ?, method = ?, detail = ? WHERE id = ?', r.source_id, r.campaign_id ?? null, r.method, String(p.referral_source).slice(0, 100), had.id);
        await audit(db, null, 'marketing.touch_change', 'marketing_touches', had.id, { why: 'the “how did you hear about us” answer on the chart changed' }, {
          patientId: p.id, before: { source_id: had.source_id, campaign_id: had.campaign_id, method: had.method }, after: { source_id: r.source_id, campaign_id: r.campaign_id ?? null, method: r.method },
        });
        touched.add(p.id);
      } else if (!had) note(p.id, await addTouch(db, pid, { key: `answer:${p.id}`, patient_id: p.id, ...r, detail: String(p.referral_source).slice(0, 100), entity: 'patients', entity_id: p.id, occurred_at: p.created_at }));
    }
    if (p.referred_by_id) {
      const s = channelSource(catalog, 'referral_doctor');
      note(p.id, await addTouch(db, pid, { key: `doctor:${p.id}`, patient_id: p.id, source_id: s?.id ?? null, method: 'referral', detail: p.doctor ? `Referred by ${p.doctor}` : null, entity: 'referral_contacts', entity_id: p.referred_by_id, occurred_at: p.created_at }));
    }
  }
  const newest = await db.get('SELECT MAX(id) AS id FROM real_patients patients WHERE practice_id = ?', pid);
  if (newest?.id) await moveCursor(db, pid, 'patients', Number(newest.id));

  // Patient-to-patient referrals (the journeys' referral list).
  await ensureJourneySchema(db);
  const sp = channelSource(catalog, 'referral_patient');
  for (const j of await db.all('SELECT r.id, r.referred_patient_id, r.referrer_patient_id, r.created_at, p.created_at AS joined FROM journey_referrals r JOIN real_patients p ON p.id = r.referred_patient_id WHERE r.practice_id = ?', pid)) {
    const at = j.joined && j.joined < j.created_at ? j.joined : j.created_at;
    note(j.referred_patient_id, await addTouch(db, pid, { key: `friend:${j.referred_patient_id}`, patient_id: j.referred_patient_id, source_id: sp?.id ?? null, method: 'referral', detail: 'Referred by a patient', entity: 'patients', entity_id: j.referrer_patient_id, occurred_at: at }));
  }

  // Leads whose chart was linked later (a call attached to a patient, a request accepted).
  for (const t of await db.all(
    `SELECT t.id, t.touch_key, COALESCE(br.patient_id, c.patient_id) AS pt FROM marketing_touches t
     LEFT JOIN real_booking_requests br ON t.entity = 'booking_requests' AND br.id = t.entity_id LEFT JOIN real_calls c ON t.entity = 'calls' AND c.id = t.entity_id
     WHERE t.practice_id = ? AND t.patient_id IS NULL AND (br.patient_id IS NOT NULL OR c.patient_id IS NOT NULL)`, pid,
  )) {
    await db.run('UPDATE marketing_touches SET patient_id = ? WHERE id = ? AND patient_id IS NULL', t.pt, t.id);
    touched.add(t.pt);
  }
  await refreshAttribution(db, pid, [...touched]);
  return { touches: added, patients: touched.size };
}

async function linkPatientReferral(db, pid, referrer, referred) {
  if (referrer === referred) return;
  const ok = await db.get('SELECT id FROM patients WHERE id = ? AND practice_id = ?', referrer, pid);
  if (!ok) return;
  await ensureJourneySchema(db);
  const r = await db.run('INSERT INTO journey_referrals (practice_id, referrer_patient_id, referred_patient_id) VALUES (?, ?, ?) ON CONFLICT (practice_id, referred_patient_id) DO NOTHING', pid, referrer, referred);
  if (r.changes) await audit(db, null, 'journey.referral', 'journey_referrals', null, { referrer_patient_id: referrer, referred_patient_id: referred, from: 'referral link' }, { source: 'automation', actor: 'Marketing capture', patientId: referred });
}

// A patient's first visit, the metrics.js new-patient rule: earliest completed visit or completed procedure's charge.
const FIRST_VISITS = `SELECT x.patient_id, MIN(x.d) AS first_visit FROM (
    SELECT a.patient_id, substr(a.start_time, 1, 10) AS d FROM real_appointments a WHERE a.practice_id = ? AND a.status = 'completed'
    UNION ALL
    SELECT l.patient_id, l.entry_date AS d FROM real_ledger_entries l WHERE l.practice_id = ? AND l.type = 'charge' AND l.procedure_id IS NOT NULL AND ${LIVE()}
  ) x GROUP BY x.patient_id`;

async function firstVisitOf(db, pid, patientId) {
  const a = await db.get("SELECT MIN(substr(start_time, 1, 10)) AS d FROM appointments WHERE practice_id = ? AND patient_id = ? AND status = 'completed'", pid, patientId);
  const l = await db.get(`SELECT MIN(l.entry_date) AS d FROM ledger_entries l WHERE l.practice_id = ? AND l.patient_id = ? AND l.type = 'charge' AND l.procedure_id IS NOT NULL AND ${LIVE()}`, pid, patientId);
  return [a?.d, l?.d].filter(Boolean).sort()[0] || null;
}

// First and last touch: the earliest and latest touches with a source up to the first visit (the day after, for
// time zones); if every touch came later (an answer typed in after the visit), all of them. Pinned ones stay.
export function pickTouches(touches, firstVisit) {
  const withSource = touches.filter((t) => t.source_id != null).sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)) || a.id - b.id);
  const before = firstVisit ? withSource.filter((t) => String(t.occurred_at).slice(0, 10) <= addDays(firstVisit, 1)) : withSource;
  const use = before.length ? before : withSource;
  return { first: use[0] || null, last: use.at(-1) || null };
}

export async function refreshAttribution(db, pid, patientIds) {
  let changed = 0;
  for (const id of [...new Set(patientIds.filter(Boolean).map(Number))]) {
    const p = await db.get('SELECT id, marketing_first_touch_id, marketing_last_touch_id, marketing_pinned FROM patients WHERE id = ? AND practice_id = ?', id, pid);
    if (!p || Number(p.marketing_pinned)) continue;
    // A person's earlier correction isn't evidence: back on automatic, only what was captured counts.
    const touches = await db.all("SELECT id, source_id, occurred_at FROM marketing_touches WHERE practice_id = ? AND patient_id = ? AND touch_key NOT LIKE 'manual:%'", pid, id);
    const { first, last } = pickTouches(touches, await firstVisitOf(db, pid, id));
    if ((first?.id ?? null) !== (p.marketing_first_touch_id ?? null) || (last?.id ?? null) !== (p.marketing_last_touch_id ?? null)) {
      // update() records the before/after on the patient's history.
      await update(db, 'patients', id, pid, { marketing_first_touch_id: first?.id ?? null, marketing_last_touch_id: last?.id ?? null });
      changed++;
    }
  }
  return changed;
}

// Nightly: charts made with no touch at all (typed in by the front desk after a call, a request accepted onto a
// new chart made by hand) are matched to their first booking request or call by phone number or name + birth date.
export function backfillPractice(db, pid) {
  return withActor({ source: 'automation', actor: 'Marketing capture', practiceId: pid }, () => backfill(db, pid));
}
async function backfill(db, pid) {
  const tz = await tzOf(db, pid);
  const since = new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  const orphans = await db.all(
    `SELECT p.id, p.first_name, p.last_name, p.dob, p.phone, p.created_at FROM real_patients p
     WHERE p.practice_id = ? AND p.merged_into_id IS NULL AND p.marketing_pinned = 0 AND p.created_at >= ?
       AND NOT EXISTS (SELECT 1 FROM marketing_touches t WHERE t.patient_id = p.id AND t.source_id IS NOT NULL)`, pid, since,
  );
  const linked = [];
  for (const p of orphans) {
    const digits = tail10(p.phone);
    const reqs = await db.all(
      `SELECT id, phone, dob FROM real_booking_requests booking_requests WHERE practice_id = ? AND patient_id IS NULL AND lower(first_name) = lower(?) AND lower(last_name) = lower(?) ORDER BY id`,
      pid, p.first_name, p.last_name,
    );
    const req = reqs.find((b) => (p.dob && b.dob === p.dob) || (digits.length === 10 && tail10(b.phone) === digits));
    let key = req ? `booking:${req.id}` : null;
    if (!key && digits.length === 10) {
      const calls = await db.all("SELECT id, from_number, created_at FROM real_calls calls WHERE practice_id = ? AND direction = 'inbound' AND patient_id IS NULL AND from_number LIKE ? ORDER BY id", pid, `%${digits.slice(-4)}`);
      const call = calls.find((c) => tail10(c.from_number) === digits && localDate(tz, c.created_at) <= addDays(localDate(tz, p.created_at), 1));
      if (call) key = `call:${call.id}`;
    }
    if (!key) continue;
    const n = (await db.run('UPDATE marketing_touches SET patient_id = ? WHERE practice_id = ? AND touch_key = ? AND patient_id IS NULL', p.id, pid, key)).changes;
    if (n) linked.push(p.id);
  }
  await refreshAttribution(db, pid, linked);
  if (linked.length) await audit(db, null, 'marketing.backfill', 'patients', null, { patients: linked.length }, { source: 'automation', actor: 'Marketing capture' });
  return linked.length;
}

// The job: new records every run; once a day after 2am practice time a full pass (edited answers) and the backfill.
export async function runMarketingJobs(db) {
  const out = [];
  for (const p of await db.all('SELECT id FROM practices')) {
    await withActor({ source: 'automation', actor: 'Marketing capture', practiceId: p.id }, async () => {
      const now = await practiceNow(db, p.id);
      const state = await cursor(db, p.id, 'nightly');
      const nightly = now.slice(11, 13) >= '02' && (state.last_run_on || '') < now.slice(0, 10);
      const r = await syncPractice(db, p.id, { full: nightly });
      let backfilled = 0;
      if (nightly) {
        backfilled = await backfillPractice(db, p.id);
        await db.run('UPDATE marketing_sync_state SET last_run_on = ? WHERE id = ?', now.slice(0, 10), state.id);
      }
      out.push({ practice_id: p.id, ...r, backfilled, nightly });
    });
  }
  return out;
}

// ---- A patient's attribution (the chart card) ----
const TOUCH_SQL = `SELECT t.*, s.name AS source_name, s.channel, c.name AS campaign_name FROM marketing_touches t
  LEFT JOIN marketing_sources s ON s.id = t.source_id LEFT JOIN marketing_campaigns c ON c.id = t.campaign_id`;
const touchView = (t) => (t ? {
  id: t.id, method: t.method, method_label: METHOD_LABELS[t.method], source_id: t.source_id, source_name: t.source_name || null, channel: t.channel || null,
  channel_label: CHANNEL_LABELS[t.channel] || null, campaign_id: t.campaign_id, campaign_name: t.campaign_name || null, lead: !!Number(t.lead), lead_kind: t.lead_kind,
  detail: t.detail, occurred_at: t.occurred_at, entity: t.entity, entity_id: t.entity === 'patients' || t.entity === 'referral_contacts' ? null : t.entity_id,
} : null);

export async function patientAttribution(db, pid, patientId) {
  await syncPractice(db, pid);
  const p = await db.get('SELECT id, marketing_first_touch_id, marketing_last_touch_id, marketing_pinned FROM patients WHERE id = ? AND practice_id = ?', patientId, pid);
  if (!p) throw new HttpError(404, 'Patient not found');
  const touches = await db.all(`${TOUCH_SQL} WHERE t.practice_id = ? AND t.patient_id = ? ORDER BY t.occurred_at, t.id`, pid, patientId);
  const find = (id) => touchView(touches.find((t) => t.id === id));
  const history = await db.all(
    `SELECT a.id, a.action, a.source, a.actor, a.reason, a.details, a.created_at, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.practice_id = ? AND a.patient_id = ? AND a.action IN ('marketing.attribution_edit','marketing.attribution_reset') ORDER BY a.id DESC LIMIT 50`, pid, patientId,
  );
  return {
    patient_id: p.id, pinned: !!Number(p.marketing_pinned), first: find(p.marketing_first_touch_id), last: find(p.marketing_last_touch_id), touches: touches.map(touchView),
    history: history.map((h) => ({ ...h, details: h.details ? JSON.parse(h.details) : null })),
  };
}

// A person's correction: first and/or last touch set to a source (and campaign). Pinned until put back.
export async function setAttribution(db, req, patientId, body = {}) {
  const pid = req.user.practice_id;
  const p = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', Number(patientId), pid);
  if (!p) throw new HttpError(404, 'Patient not found');
  const catalog = await loadCatalog(db, pid);
  const reason = String(body.reason ?? '').trim().slice(0, 300);
  const pickOne = (x, which) => {
    if (x == null) return null;
    const s = catalog.sources.find((r) => r.id === Number(x.source_id));
    if (!s) throw new HttpError(400, `Choose a source for the ${which} touch`);
    let c = null;
    if (x.campaign_id != null && x.campaign_id !== '') {
      c = catalog.campaigns.find((r) => r.id === Number(x.campaign_id));
      if (!c) throw new HttpError(404, 'Campaign not found');
      if (c.source_id !== s.id) throw new HttpError(400, 'That campaign belongs to a different source');
    }
    return { source_id: s.id, campaign_id: c?.id ?? null };
  };
  const first = pickOne(body.first, 'first');
  const last = pickOne(body.last, 'last');
  if (!first && !last) throw new HttpError(400, 'Nothing to change');
  // Replacing what the system found needs a reason (it's someone's judgement over evidence).
  if ((p.marketing_first_touch_id || p.marketing_last_touch_id) && !reason) throw new HttpError(400, 'Say why you’re changing it (e.g. “patient says a friend sent them”)');
  const stamp = Date.now().toString(36);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const touchFor = async (x, which) => {
    const key = `manual:${p.id}:${which}:${stamp}`;
    await addTouch(db, pid, { key, patient_id: p.id, ...x, method: 'staff', detail: reason || 'Entered by the office', entity: 'patients', entity_id: p.id, occurred_at: which === 'first' ? p.created_at : now, created_by: req.user.id });
    return (await db.get('SELECT id FROM marketing_touches WHERE practice_id = ? AND touch_key = ?', pid, key)).id;
  };
  const patch = { marketing_pinned: 1 };
  if (first) patch.marketing_first_touch_id = await touchFor(first, 'first');
  if (last) patch.marketing_last_touch_id = await touchFor(last, 'last');
  if (first && !last && !p.marketing_last_touch_id) patch.marketing_last_touch_id = patch.marketing_first_touch_id;
  await update(db, 'patients', p.id, pid, patch);
  const before = { first_touch_id: p.marketing_first_touch_id, last_touch_id: p.marketing_last_touch_id, pinned: p.marketing_pinned };
  const after = { first_touch_id: patch.marketing_first_touch_id ?? p.marketing_first_touch_id, last_touch_id: patch.marketing_last_touch_id ?? p.marketing_last_touch_id, pinned: 1 };
  await audit(db, req, 'marketing.attribution_edit', 'patients', p.id, { first, last }, { reason: reason || null, patientId: p.id, before, after });
  return patientAttribution(db, pid, p.id);
}

export async function resetAttribution(db, req, patientId) {
  const pid = req.user.practice_id;
  const p = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', Number(patientId), pid);
  if (!p) throw new HttpError(404, 'Patient not found');
  await update(db, 'patients', p.id, pid, { marketing_pinned: 0 });
  await refreshAttribution(db, pid, [p.id]);
  const now = await db.get('SELECT marketing_first_touch_id, marketing_last_touch_id FROM patients WHERE id = ?', p.id);
  await audit(db, req, 'marketing.attribution_reset', 'patients', p.id, null, {
    patientId: p.id, before: { first_touch_id: p.marketing_first_touch_id, last_touch_id: p.marketing_last_touch_id, pinned: p.marketing_pinned },
    after: { first_touch_id: now.marketing_first_touch_id, last_touch_id: now.marketing_last_touch_id, pinned: 0 },
  });
  return patientAttribution(db, pid, p.id);
}

// A patient's own referral link code (made once, reused).
export async function referralCode(db, pid, patientId) {
  const had = await db.get('SELECT code FROM marketing_referral_codes WHERE practice_id = ? AND patient_id = ? ORDER BY id LIMIT 1', pid, patientId);
  if (had) return had.code;
  for (let i = 0; i < 5; i++) {
    const code = randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
    if (code.length < 6) continue;
    const r = await db.run('INSERT INTO marketing_referral_codes (practice_id, patient_id, code) VALUES (?, ?, ?) ON CONFLICT (practice_id, code) DO NOTHING', pid, patientId, code);
    if (r.changes) return code;
  }
  throw new HttpError(500, 'Couldn’t make a referral code — try again');
}

// ---- Links for campaigns ----
export const utmSourceFor = (source) => keyList(source?.match_keys)[0] || slug(source?.name) || 'other';
const MEDIUM_FOR = { google_ads: 'cpc', facebook: 'social', instagram: 'social', google_business: 'maps', website_organic: 'website', referral_patient: 'referral', referral_doctor: 'referral', insurance_directory: 'directory', mailer: 'print', event: 'event', walk_in: 'offline', other: 'other' };
// The practice's booking page (or a page on their own site with the booking button on it) with the campaign's tags.
export function campaignLink({ appUrl, practiceSlug, source, campaign, medium, target }) {
  let base;
  if (target) {
    let u;
    try { u = new URL(String(target)); } catch { throw new HttpError(400, 'The page address must be a full web address (https://…)'); }
    if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'The page address must start with https://');
    base = u;
  } else {
    if (!practiceSlug) throw new HttpError(409, 'Set up online booking first (Settings → Online booking) so there is a booking page to link to');
    base = new URL(`${String(appUrl || '').replace(/\/$/, '')}/book/${practiceSlug}`);
  }
  base.searchParams.set('utm_source', utmSourceFor(source));
  base.searchParams.set('utm_medium', cleanUtm(medium) || MEDIUM_FOR[source?.channel] || 'other');
  if (campaign?.utm_campaign) base.searchParams.set('utm_campaign', campaign.utm_campaign);
  if (campaign?.promo_code) base.searchParams.set('promo', campaign.promo_code);
  return base.toString();
}

// ---- Costs: spread evenly over their days ----
// { 'YYYY-MM': cents } for the part of a cost inside [from, to]. Whole cents: the remainder goes to the last days,
// so the full range always adds back up to the amount entered.
export function allocateCost(cost, from = null, to = null) {
  const days = daysBetween(cost.starts_on, cost.ends_on) + 1;
  if (days <= 0) return {};
  const amount = num(cost.amount);
  const base = Math.floor(amount / days);
  const extra = amount - base * days;
  const out = {};
  for (let i = 0; i < days; i++) {
    const d = addDays(cost.starts_on, i);
    if ((from && d < from) || (to && d > to)) continue;
    const v = base + (i >= days - extra ? 1 : 0);
    out[d.slice(0, 7)] = (out[d.slice(0, 7)] || 0) + v;
  }
  return out;
}

// ---- MK2: the report ----
export const GROUPS = ['source', 'campaign', 'channel', 'month'];

// Checks the filters. from/to are dates (a month 'YYYY-MM' means that whole month).
export function reportOptions(q = {}, today) {
  const norm = (v, end) => {
    const s = String(v ?? '');
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return end ? addDays(`${new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7), 1)).toISOString().slice(0, 7)}-01`, -1) : `${s}-01`;
    return s;
  };
  const from = q.from ? norm(q.from, false) : `${addDays(today, -364).slice(0, 7)}-01`;
  const to = q.to ? norm(q.to, true) : today;
  if (!isRealDate(from) || !isRealDate(to)) throw new HttpError(400, 'from and to must be real dates (YYYY-MM-DD) or months (YYYY-MM)');
  if (from > to) throw new HttpError(400, 'The start date is after the end date');
  if (daysBetween(from, to) > 3 * 366) throw new HttpError(400, 'Pick a range of three years or less');
  const model = q.model === 'last' ? 'last' : q.model == null || q.model === '' || q.model === 'first' ? 'first' : null;
  if (!model) throw new HttpError(400, 'model must be first or last');
  const by = q.by == null || q.by === '' ? 'source' : q.by;
  if (!GROUPS.includes(by)) throw new HttpError(400, `by must be one of: ${GROUPS.join(', ')}`);
  const window = q.window == null || q.window === '' ? 365 : q.window === 'life' ? 'life' : Number(q.window);
  if (window !== 'life' && !WINDOWS.includes(window)) throw new HttpError(400, 'window must be 30, 90, 180, 365 or life');
  const id = (v, name) => {
    if (v == null || v === '') return null;
    if (!/^\d+$/.test(String(v))) throw new HttpError(400, `${name} must be a number`);
    return Number(v);
  };
  return { from, to, model, by, window, locationId: id(q.location_id, 'location_id') };
}

// The patients (new patients in the range, per the metrics.js rule) with their attribution and money, scoped to
// the offices this person may see.
async function cohort(db, pid, user, o) {
  const scope = o.locationId ? { sql: ' AND p.location_id = ?', args: [o.locationId] } : patientScope(user, 'p');
  const col = o.model === 'last' ? 'marketing_last_touch_id' : 'marketing_first_touch_id';
  return db.all(
    `SELECT f.patient_id, f.first_visit, p.first_name, p.last_name, p.created_at, t.id AS touch_id, t.source_id, t.campaign_id, t.method, s.name AS source_name, s.channel, c.name AS campaign_name
     FROM (${FIRST_VISITS}) f JOIN real_patients p ON p.id = f.patient_id
     LEFT JOIN marketing_touches t ON t.id = p.${col} LEFT JOIN marketing_sources s ON s.id = t.source_id LEFT JOIN marketing_campaigns c ON c.id = t.campaign_id
     WHERE f.first_visit >= ? AND f.first_visit <= ? AND p.merged_into_id IS NULL${scope.sql} ORDER BY f.first_visit, p.last_name, p.id`,
    pid, pid, o.from, o.to, ...scope.args,
  );
}

// Ledger money per patient: production (charges) and collections (payments and insurance payments received, less
// refunds) in each window after the first visit (a deposit paid before it counts), and to date.
async function moneyFor(db, pid, patients, today) {
  const out = new Map();
  const ids = patients.map((p) => p.patient_id);
  const fv = new Map(patients.map((p) => [p.patient_id, p.first_visit]));
  for (const id of ids) out.set(id, { production: {}, collections: {}, monthly: [], matured: {} });
  await chunks(ids, async (chunk) => {
    const rows = await db.all(
      `SELECT l.patient_id, l.type, l.amount, l.entry_date FROM real_ledger_entries l
       WHERE l.practice_id = ? AND l.patient_id IN (${IN(chunk)}) AND l.type IN ('charge','payment','insurance_payment','refund') AND ${LIVE()}`, pid, ...chunk,
    );
    for (const r of rows) {
      const m = out.get(r.patient_id);
      const first = fv.get(r.patient_id);
      const age = daysBetween(first, r.entry_date);
      const prod = r.type === 'charge' ? num(r.amount) : 0;
      const coll = r.type === 'payment' || r.type === 'insurance_payment' ? -num(r.amount) : r.type === 'refund' ? -num(r.amount) : 0;
      for (const w of WINDOWS) {
        if (age < w) {
          m.production[w] = (m.production[w] || 0) + prod;
          m.collections[w] = (m.collections[w] || 0) + coll;
        }
      }
      m.production.life = (m.production.life || 0) + prod;
      m.collections.life = (m.collections.life || 0) + coll;
      if (coll) m.monthly.push([Math.max(0, age), coll]);
    }
  });
  for (const [id, m] of out) {
    for (const w of WINDOWS) m.matured[w] = daysBetween(fv.get(id), today) >= w - 1;
  }
  return out;
}

async function acceptedFor(db, pid, ids) {
  const out = new Map();
  await chunks(ids, async (chunk) => {
    for (const r of await db.all(
      `SELECT pr.patient_id, SUM(pr.fee) AS n FROM real_procedures pr JOIN real_treatment_plans tp ON tp.id = pr.treatment_plan_id
       WHERE pr.practice_id = ? AND pr.patient_id IN (${IN(chunk)}) AND pr.status != 'cancelled' AND tp.status IN ('accepted','completed') GROUP BY pr.patient_id`, pid, ...chunk,
    )) out.set(r.patient_id, num(r.n));
  });
  return out;
}

const groupKey = (by, x) => {
  if (by === 'source') return x.source_id == null ? 'none' : `s${x.source_id}`;
  if (by === 'campaign') return x.campaign_id == null ? (x.source_id == null ? 'none' : `nc${x.source_id}`) : `c${x.campaign_id}`;
  if (by === 'channel') return x.channel || 'none';
  return x.month;
};

// The whole report: one row per group, plus totals. Money only for people who may see it (billing:read).
export async function marketingReport(db, user, query = {}) {
  const pid = user.practice_id;
  const today = (await practiceNow(db, pid)).slice(0, 10);
  const o = reportOptions(query, today);
  if (o.locationId && !(await db.get('SELECT id FROM locations WHERE id = ? AND practice_id = ?', o.locationId, pid))) throw new HttpError(404, 'Office not found');
  if (o.locationId && restricted(user) && !user.location_ids.map(Number).includes(o.locationId)) throw new HttpError(403, "That office isn't one of yours");
  await syncPractice(db, pid);
  const catalog = await loadCatalog(db, pid);
  const tz = await tzOf(db, pid);
  const money = can(user, 'billing:read');
  // Costs are practice-wide: shown to people who see every office (and the money).
  const showCost = money && !restricted(user) && !o.locationId;
  const srcOf = new Map(catalog.sources.map((s) => [s.id, s]));
  const campOf = new Map(catalog.campaigns.map((c) => [c.id, c]));
  const rows = new Map();
  const labelFor = (key, x) => {
    if (o.by === 'month') return key;
    if (key === 'none') return NOT_RECORDED;
    if (o.by === 'source') return srcOf.get(x.source_id)?.name || NOT_RECORDED;
    if (o.by === 'channel') return CHANNEL_LABELS[key] || key;
    if (key.startsWith('nc')) return `${srcOf.get(x.source_id)?.name || ''} — no campaign`;
    return campOf.get(x.campaign_id)?.name || NOT_RECORDED;
  };
  const row = (x) => {
    const key = groupKey(o.by, x);
    if (!rows.has(key)) {
      rows.set(key, {
        key, label: labelFor(key, x), source_id: o.by === 'source' || o.by === 'campaign' ? x.source_id ?? null : null, campaign_id: o.by === 'campaign' ? x.campaign_id ?? null : null,
        channel: o.by === 'channel' ? (key === 'none' ? null : key) : o.by === 'source' || o.by === 'campaign' ? srcOf.get(x.source_id)?.channel ?? null : null,
        month: o.by === 'month' ? key : null, leads: 0, call_leads: 0, online_leads: 0, new_patients: 0, booked: 0, showed: 0, cost: 0, patients: [],
      });
    }
    return rows.get(key);
  };

  // Leads: a new caller's first call and each online request from someone new, by the touch's own source.
  const [fu, tu] = await utcRange(db, pid, o.from, o.to);
  const scope = o.locationId ? { sql: ' AND p.location_id = ?', args: [o.locationId] } : patientScope(user, 'p');
  const leadRows = await db.all(
    `SELECT t.id, t.lead_kind, t.source_id, t.campaign_id, t.occurred_at, s.channel FROM marketing_touches t
     LEFT JOIN marketing_sources s ON s.id = t.source_id LEFT JOIN real_patients p ON p.id = t.patient_id
     WHERE t.practice_id = ? AND t.lead = 1 AND t.occurred_at >= ? AND t.occurred_at < ?${scope.sql ? ` AND (t.patient_id IS NOT NULL${scope.sql})` : ''}`,
    pid, fu, tu, ...scope.args,
  );
  for (const l of leadRows) {
    const r = row({ ...l, month: localDate(tz, l.occurred_at).slice(0, 7) });
    r.leads++;
    if (l.lead_kind === 'call') r.call_leads++; else r.online_leads++;
  }

  // Show rate: charts made in the range (attributed the same way) that had a visit booked for today or earlier —
  // how many came to one.
  const col = o.model === 'last' ? 'marketing_last_touch_id' : 'marketing_first_touch_id';
  const shows = await db.all(
    `SELECT p.id, p.created_at, t.source_id, t.campaign_id, s.channel,
       (SELECT COUNT(*) FROM real_appointments a WHERE a.patient_id = p.id AND a.start_time <= ?) AS booked,
       (SELECT COUNT(*) FROM real_appointments a WHERE a.patient_id = p.id AND a.status = 'completed') AS showed
     FROM real_patients p LEFT JOIN marketing_touches t ON t.id = p.${col} LEFT JOIN marketing_sources s ON s.id = t.source_id
     WHERE p.practice_id = ? AND p.merged_into_id IS NULL AND p.created_at >= ? AND p.created_at < ?${scope.sql}`,
    `${today} 23:59`, pid, fu, tu, ...scope.args,
  );
  for (const s of shows) {
    if (!num(s.booked)) continue;
    const r = row({ ...s, month: localDate(tz, s.created_at).slice(0, 7) });
    r.booked++;
    if (num(s.showed)) r.showed++;
  }

  // New patients and what they produced.
  const pts = await cohort(db, pid, user, o);
  const m = await moneyFor(db, pid, pts, today);
  const acc = await acceptedFor(db, pid, pts.map((p) => p.patient_id));
  for (const p of pts) {
    const r = row({ ...p, month: p.first_visit.slice(0, 7) });
    r.new_patients++;
    r.patients.push({ ...m.get(p.patient_id), accepted: acc.get(p.patient_id) || 0 });
  }

  // Costs in the range, by day.
  if (showCost) {
    for (const c of await db.all('SELECT * FROM marketing_costs WHERE practice_id = ? AND voided_at IS NULL AND starts_on <= ? AND ends_on >= ?', pid, o.to, o.from)) {
      const camp = c.campaign_id ? campOf.get(c.campaign_id) : null;
      for (const [month, cents] of Object.entries(allocateCost(c, o.from, o.to))) {
        row({ source_id: c.source_id, campaign_id: camp?.id ?? null, channel: srcOf.get(c.source_id)?.channel, month }).cost += cents;
      }
    }
  }

  const finish = (r) => {
    const sum = (f) => r.patients.reduce((s, p) => s + f(p), 0);
    const { patients: _p, ...out } = r;
    out.show_rate = pct(r.showed, r.booked);
    if (money) {
      for (const w of WINDOWS) {
        out[`production_${w}`] = sum((p) => p.production[w] || 0);
        out[`collections_${w}`] = sum((p) => p.collections[w] || 0);
        out[`matured_${w}`] = r.patients.filter((p) => p.matured[w]).length;
      }
      out.production_life = sum((p) => p.production.life || 0);
      out.collections_life = sum((p) => p.collections.life || 0);
      out.treatment_accepted = sum((p) => p.accepted);
      out.ltv_production = r.new_patients ? Math.round(out.production_life / r.new_patients) : null;
      out.ltv_collections = r.new_patients ? Math.round(out.collections_life / r.new_patients) : null;
    }
    if (showCost) {
      const back = o.window === 'life' ? out.collections_life : out[`collections_${o.window}`];
      out.cost_per_lead = r.cost && r.leads ? Math.round(r.cost / r.leads) : null;
      out.cost_per_new_patient = r.cost && r.new_patients ? Math.round(r.cost / r.new_patients) : null;
      out.roi = r.cost ? Math.round(((back - r.cost) / r.cost) * 1000) / 10 : null;
      out.return_multiple = r.cost ? Math.round((back / r.cost) * 100) / 100 : null;
      out.payback_months = paybackMonths(r.patients, r.cost);
    } else delete out.cost;
    return out;
  };
  const list = [...rows.values()].map(finish).sort((a, b) => (o.by === 'month' ? String(a.key).localeCompare(String(b.key)) : (b.new_patients - a.new_patients) || (b.leads - a.leads) || String(a.label).localeCompare(String(b.label))));
  const all = [...rows.values()];
  const agg = { key: 'total', label: 'Total', source_id: null, campaign_id: null, channel: null, month: null, patients: all.flatMap((r) => r.patients) };
  for (const k of ['leads', 'call_leads', 'online_leads', 'new_patients', 'booked', 'showed', 'cost']) agg[k] = all.reduce((s, r) => s + r[k], 0);
  const total = finish(agg);
  return { ...o, today, money, show_cost: showCost, rows: list, total, windows: WINDOWS };
}

// Months until the group's collections (from each patient's first visit) add up to what it cost; null if not yet.
export function paybackMonths(patients, cost) {
  if (!cost) return null;
  const perMonth = new Array(PAYBACK_MAX_MONTHS + 1).fill(0);
  for (const p of patients) for (const [age, v] of p.monthly || []) { const mth = Math.floor(age / 30) + 1; if (mth <= PAYBACK_MAX_MONTHS) perMonth[mth] += v; }
  let cum = 0;
  for (let mth = 1; mth <= PAYBACK_MAX_MONTHS; mth++) {
    cum += perMonth[mth];
    if (cum >= cost) return mth;
  }
  return null;
}

// The patients behind a row (drill-down): the new patients in the range for that group. Names and dates only,
// plus the money for people who may see it. Viewing them is audited by the route.
export async function reportPatients(db, user, query = {}) {
  const pid = user.practice_id;
  const today = (await practiceNow(db, pid)).slice(0, 10);
  const o = reportOptions(query, today);
  if (o.locationId && restricted(user) && !user.location_ids.map(Number).includes(o.locationId)) throw new HttpError(403, "That office isn't one of yours");
  const key = String(query.key ?? '');
  if (!key) throw new HttpError(400, 'Which row? (key)');
  await syncPractice(db, pid);
  const pts = (await cohort(db, pid, user, o)).filter((p) => groupKey(o.by, { ...p, month: p.first_visit.slice(0, 7) }) === key || key === 'total');
  const money = can(user, 'billing:read');
  const m = money ? await moneyFor(db, pid, pts, today) : null;
  const acc = money ? await acceptedFor(db, pid, pts.map((p) => p.patient_id)) : null;
  return {
    ...o, key, money,
    patients: pts.slice(0, 2000).map((p) => ({
      patient_id: p.patient_id, name: `${p.first_name} ${p.last_name}`, first_visit: p.first_visit, source: p.source_name || NOT_RECORDED, channel: p.channel,
      campaign: p.campaign_name || null, method: p.method ? METHOD_LABELS[p.method] : null,
      ...(money ? {
        production_90: m.get(p.patient_id).production[90] || 0, production_365: m.get(p.patient_id).production[365] || 0, production_life: m.get(p.patient_id).production.life || 0,
        collections_90: m.get(p.patient_id).collections[90] || 0, collections_365: m.get(p.patient_id).collections[365] || 0, collections_life: m.get(p.patient_id).collections.life || 0,
        treatment_accepted: acc.get(p.patient_id) || 0,
      } : {}),
    })),
    total: pts.length,
  };
}

// ---- CSV ----
const dollars = (c) => (c == null ? '' : (c / 100).toFixed(2));
export function reportCsv(rep) {
  const cols = [['Group', (r) => r.label], ['Leads', (r) => r.leads], ['Call leads', (r) => r.call_leads], ['Online leads', (r) => r.online_leads], ['New patients', (r) => r.new_patients],
    ['Booked (charts made)', (r) => r.booked], ['Showed', (r) => r.showed], ['Show rate %', (r) => r.show_rate ?? '']];
  if (rep.money) {
    for (const w of WINDOWS) cols.push([`Production ${w}d`, (r) => dollars(r[`production_${w}`])], [`Collections ${w}d`, (r) => dollars(r[`collections_${w}`])]);
    cols.push(['Production to date', (r) => dollars(r.production_life)], ['Collections to date', (r) => dollars(r.collections_life)], ['Treatment accepted', (r) => dollars(r.treatment_accepted)],
      ['Lifetime value (collections / new patient)', (r) => dollars(r.ltv_collections)]);
  }
  if (rep.show_cost) {
    cols.push(['Cost', (r) => dollars(r.cost)], ['Cost per lead', (r) => dollars(r.cost_per_lead)], ['Cost per new patient', (r) => dollars(r.cost_per_new_patient)],
      [`ROI % (${rep.window === 'life' ? 'to date' : `${rep.window}d`} collections)`, (r) => r.roi ?? ''], ['Payback months', (r) => r.payback_months ?? '']);
  }
  return toCsv([...rep.rows, rep.total], cols);
}
export function patientsCsv(rep) {
  const cols = [['Patient ID', (r) => r.patient_id], ['Name', (r) => r.name], ['First visit', (r) => r.first_visit], ['Source', (r) => r.source], ['Campaign', (r) => r.campaign || ''], ['How we know', (r) => r.method || '']];
  if (rep.money) {
    cols.push(['Production 90d', (r) => dollars(r.production_90)], ['Production 365d', (r) => dollars(r.production_365)], ['Production to date', (r) => dollars(r.production_life)],
      ['Collections 90d', (r) => dollars(r.collections_90)], ['Collections 365d', (r) => dollars(r.collections_365)], ['Collections to date', (r) => dollars(r.collections_life)],
      ['Treatment accepted', (r) => dollars(r.treatment_accepted)]);
  }
  return toCsv(rep.patients, cols);
}

// ---- The report library entry (reportlibrary.js registers it with def(MARKETING_LIBRARY_REPORT)) ----
export const MARKETING_LIBRARY_REPORT = {
  id: 'marketing-roi', name: 'Marketing ROI by source', category: 'Patients',
  description: 'Leads, new patients, show rate, production and collections since their first visit, cost and return — by marketing source (first touch).',
  params: ['range', 'office'],
  columns: [
    { key: 'source', label: 'Source', type: 'text' }, { key: 'leads', label: 'Leads', type: 'int', sum: true }, { key: 'new_patients', label: 'New patients', type: 'int', sum: true },
    { key: 'show_rate', label: 'Show rate %', type: 'text' }, { key: 'production_365', label: 'Production (first year)', type: 'money', sum: true },
    { key: 'collections_365', label: 'Collections (first year)', type: 'money', sum: true }, { key: 'cost', label: 'Cost', type: 'money', sum: true },
    { key: 'cost_per_new_patient', label: 'Cost per new patient', type: 'money' }, { key: 'roi', label: 'ROI %', type: 'text' },
  ],
  async run(ctx) {
    const user = ctx.officeIds ? { ...ctx.user, location_ids: ctx.officeIds } : ctx.user;
    const rep = await marketingReport(ctx.db, user, { from: ctx.from, to: ctx.to, by: 'source', model: 'first', window: 365, location_id: ctx.locationId || undefined });
    return {
      rows: rep.rows.map((r) => ({ source: r.label, leads: r.leads, new_patients: r.new_patients, show_rate: r.show_rate, production_365: r.production_365 ?? null, collections_365: r.collections_365 ?? null, cost: r.cost ?? null, cost_per_new_patient: r.cost_per_new_patient ?? null, roi: r.roi ?? null })),
      totals: { show_rate: rep.total.show_rate, cost_per_new_patient: rep.total.cost_per_new_patient ?? null, roi: rep.total.roi ?? null },
      note: 'First-touch attribution. Money from the ledger (voided entries left out) within a year of each new patient’s first visit. Full dashboard: Marketing.',
    };
  },
};
