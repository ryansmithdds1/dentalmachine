// Is everything ready for this visit? (backlog LB1–LB5)
// A visit that seats lab work (crown, bridge, denture, night guard, implant crown…) is linked to its lab case, and
// a visit that needs special parts (implant fixture, abutment and screw, scan body, graft, aligners, sedation kit…)
// lists them. Each is a row in visit_requirements; together they make one "ready / not ready" state per visit for
// the schedule card and the huddle. When the case or the parts come in, a person checks them (photo, short
// checklist, or by voice) — lab_checkins keeps each check as it was made (append-only), and a failed check goes
// to the doctor with a draft note for the lab.
//
// One source of truth each: a lab case's progress stays on lab_cases (status, lab_status from the lab's link,
// received_date); a part's stock stays in inventory_items / inventory_moves. A part "set aside" from stock is a
// reservation counted from these rows (nothing is taken off the shelf count until it's used).
import { HttpError } from './auth.js';
import { insert, audit, change, practiceNow } from './util.js';
import { withActor } from './actor.js';
import { publish } from './events.js';

// ---- Schema (the lines for db.js: the tables go at the end of SCHEMA, the columns at the end of COLUMNS) ----
export const LABCHECK_TABLES = [
  `CREATE TABLE IF NOT EXISTS visit_requirements (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  kind TEXT NOT NULL CHECK (kind IN ('lab_case','part')),
  link_key TEXT NOT NULL,
  lab_case_id INTEGER REFERENCES lab_cases(id),
  procedure_id INTEGER REFERENCES procedures(id),
  item_name TEXT,
  details TEXT,
  inventory_item_id INTEGER REFERENCES inventory_items(id),
  qty INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('needed','linked','to_order','ordered','arrived','checked','set_aside','problem','cancelled')),
  source TEXT NOT NULL DEFAULT 'manual',
  reason TEXT,
  ordered_at TEXT,
  arrived_at TEXT,
  checked_at TEXT,
  checked_by INTEGER REFERENCES users(id),
  photo_ids TEXT,
  task_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (appointment_id, link_key)
);`,
  `CREATE TABLE IF NOT EXISTS lab_checkins (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  lab_case_id INTEGER REFERENCES lab_cases(id),
  requirement_id INTEGER REFERENCES visit_requirements(id),
  appointment_id INTEGER REFERENCES appointments(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('ok','problem')),
  checklist TEXT NOT NULL,
  problem_kind TEXT,
  problem_note TEXT,
  photo_ids TEXT,
  via TEXT NOT NULL DEFAULT 'screen',
  transcript TEXT,
  lab_id INTEGER REFERENCES labs(id),
  lab_name TEXT,
  sent_date TEXT,
  promised_date TEXT,
  received_date TEXT,
  client_key TEXT,
  lab_message_at TEXT,
  lab_message_by INTEGER REFERENCES users(id),
  checked_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, client_key)
);`,
  'CREATE INDEX IF NOT EXISTS idx_visit_req_appt ON visit_requirements(practice_id, appointment_id)',
  'CREATE INDEX IF NOT EXISTS idx_lab_checkins_case ON lab_checkins(practice_id, lab_case_id)',
];
export const LABCHECK_COLUMNS = [
  ['lab_cases', 'check_status', 'TEXT'], // null (not checked yet) | checked | problem — the latest check-in's result
  ['lab_cases', 'checked_at', 'TEXT'],
  ['lab_cases', 'promised_date', 'TEXT'], // the due date first promised (the lab's link can move due_date later)
  ['practices', 'readiness_settings', 'TEXT'], // { days_ahead, templates }
];

// ---- Which procedures need a lab ----
const LAB_RULES = [
  [/^D2(5[1-9]\d|6[0-6]\d)$/, 'inlay', 'Inlay / onlay'],
  [/^D27\d\d$/, 'crown', 'Crown'],
  [/^D2962$/, 'veneer', 'Veneer'],
  [/^D6(2\d\d|[67]\d\d)$/, 'bridge', 'Bridge'],
  [/^D60(5[89]|6\d|7[0-7]|8[2-8]|9[47])$/, 'implant_crown', 'Implant crown'],
  [/^D6(11\d|194)$/, 'denture', 'Implant denture'],
  [/^D51\d\d$/, 'denture', 'Denture'],
  [/^D5(2\d\d|8[2-9]\d)$/, 'partial', 'Partial denture'],
  [/^D5(7[5-6]\d|8[1-2]\d)$/, 'denture', 'Reline / interim denture'],
  [/^D994[4-6]$/, 'night_guard', 'Night guard'],
];
export function labKind(code) {
  const c = String(code || '').toUpperCase();
  const hit = LAB_RULES.find(([re]) => re.test(c));
  return hit ? hit[1] : null;
}
export const KIND_LABEL = Object.fromEntries(LAB_RULES.map(([, k, l]) => [k, l]));
KIND_LABEL.implant_crown = 'Implant crown';
KIND_LABEL.denture = 'Denture';
// Upper or lower, for the removable codes that name the arch.
const ARCH_CODES = { U: /^D5(110|130|211|213|221|223|225|227|282|750|760|810|820)$/, L: /^D5(120|140|212|214|222|224|226|228|283|751|761|811|821)$/ };
export const archOf = (code, area) => (area === 'U' || area === 'L' ? area : ARCH_CODES.U.test(code) ? 'U' : ARCH_CODES.L.test(code) ? 'L' : null);

// What a lab case's description says it is (for cases entered by hand, with no procedure).
const KIND_WORDS = [
  ['implant_crown', /implant\s+(crown|restoration)|screw[- ]retained|abutment[- ]supported/],
  ['night_guard', /night\s*guard|occlusal guard|splint|bite guard/],
  ['partial', /partial|rpd|cast\s+frame/],
  ['denture', /denture|fdu|fdl|immediate/],
  ['bridge', /bridge|fpd|pontic/],
  ['veneer', /veneer/],
  ['inlay', /inlay|onlay/],
  ['crown', /crown|pfm|zirconia|e\.?max|full cast|fcc/],
];
export const kindFromText = (text) => KIND_WORDS.find(([, re]) => re.test(String(text || '').toLowerCase()))?.[0] || null;
export const archFromText = (text) => {
  const t = String(text || '').toLowerCase();
  return /\b(upper|maxillary|max)\b/.test(t) ? 'U' : /\b(lower|mandibular|mand)\b/.test(t) ? 'L' : null;
};

// "30", "#3", "3, 4-5", "3–5", "U" → the teeth as strings (arches aren't teeth).
export function parseTeeth(value) {
  const out = new Set();
  for (const part of String(value ?? '').toUpperCase().split(/[,;/\s]+(?![-–])/)) {
    const p = part.replace(/#/g, '').trim();
    const range = /^(\d{1,2})\s*[-–]\s*(\d{1,2})$/.exec(p);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
      if (b - a <= 16) for (let n = a; n <= b; n++) out.add(String(n));
    } else if (/^\d{1,2}$/.test(p) && Number(p) >= 1 && Number(p) <= 32) out.add(String(Number(p)));
    else if (/^[A-T]$/.test(p)) out.add(p);
  }
  return out;
}
const overlap = (a, b) => [...a].some((x) => b.has(x));

// ---- Parts templates: what a procedure needs on hand (Settings → Visit readiness; the office can edit them) ----
export const DEFAULT_TEMPLATES = {
  D6010: [{ name: 'Implant fixture', part: 'fixture', details: true }, { name: 'Healing abutment', part: 'healing_abutment' }, { name: 'Bone graft', part: 'graft' }],
  D6056: [{ name: 'Stock abutment', part: 'abutment' }, { name: 'Abutment screw', part: 'screw' }],
  D6057: [{ name: 'Custom abutment', part: 'abutment' }, { name: 'Abutment screw', part: 'screw' }],
  D6058: [{ name: 'Abutment', part: 'abutment' }, { name: 'Abutment screw', part: 'screw' }, { name: 'Scan body', part: 'scan_body' }],
  D6059: [{ name: 'Abutment', part: 'abutment' }, { name: 'Abutment screw', part: 'screw' }, { name: 'Scan body', part: 'scan_body' }],
  D6065: [{ name: 'Abutment', part: 'abutment' }, { name: 'Abutment screw', part: 'screw' }, { name: 'Scan body', part: 'scan_body' }],
  D6066: [{ name: 'Abutment', part: 'abutment' }, { name: 'Abutment screw', part: 'screw' }, { name: 'Scan body', part: 'scan_body' }],
  D7953: [{ name: 'Bone graft', part: 'graft' }, { name: 'Membrane', part: 'membrane' }],
  D4266: [{ name: 'Membrane', part: 'membrane' }],
  D4267: [{ name: 'Membrane', part: 'membrane' }],
  D8090: [{ name: 'Aligners from the ortho lab', part: 'aligners' }],
  D8680: [{ name: 'Retainers from the ortho lab', part: 'retainer' }],
  D9239: [{ name: 'IV sedation kit', part: 'sedation_kit' }],
  D9243: [{ name: 'IV sedation kit', part: 'sedation_kit' }],
};
export const DEFAULT_DAYS_AHEAD = 3;

// Settings saved by the office: validated so a typo can't break every schedule load.
export function cleanSettings(input = {}) {
  const days = Math.round(Number(input.days_ahead ?? DEFAULT_DAYS_AHEAD));
  if (!Number.isFinite(days) || days < 0 || days > 30) throw new HttpError(400, 'days_ahead must be 0–30');
  const templates = {};
  for (const [code, items] of Object.entries(input.templates ?? DEFAULT_TEMPLATES)) {
    const c = String(code).toUpperCase().trim();
    if (!/^D\d{4}$/.test(c)) throw new HttpError(400, `${code} isn't a procedure code`);
    if (!Array.isArray(items) || items.length > 10) throw new HttpError(400, `${c}: a list of up to 10 parts`);
    templates[c] = items.map((it) => {
      const name = String(it?.name || '').trim().slice(0, 80);
      if (!name) throw new HttpError(400, `${c}: every part needs a name`);
      const qty = Math.round(Number(it.qty ?? 1));
      if (!(qty >= 1 && qty <= 50)) throw new HttpError(400, `${c}: quantity must be 1–50`);
      return { name, part: String(it.part || '').replace(/[^a-z_]/g, '').slice(0, 30) || null, qty, inventory_item_id: it.inventory_item_id ? Number(it.inventory_item_id) : null, details: !!it.details };
    });
  }
  return { days_ahead: days, templates };
}
export function readSettings(practice) {
  let saved = null;
  try { saved = practice?.readiness_settings ? JSON.parse(practice.readiness_settings) : null; } catch { saved = null; }
  try { return cleanSettings(saved || {}); } catch { return cleanSettings({}); }
}

// ---- The state of one requirement, and of a whole visit ----
// Lab case: progress comes from the case itself.
export function caseState(c, visitDate, today) {
  if (!c || c.status === 'cancelled') return 'needed';
  if (c.check_status === 'problem') return 'problem';
  if (c.status === 'delivered' || (c.status === 'received' && c.check_status === 'checked')) return 'checked';
  if (c.status === 'received') return 'arrived';
  if (c.due_date && c.due_date < today) return 'late';
  if (c.due_date && visitDate && c.due_date >= visitDate) return 'late'; // promised back on or after the visit
  if (c.lab_status === 'shipped') return 'shipped';
  if (c.lab_status === 'in_production' || c.lab_status === 'received') return 'in_production';
  if (c.due_date && c.due_date <= addDays(today, 2)) return 'due';
  return 'sent';
}
export const STATE_LABEL = {
  needed: 'No lab case yet', choose: 'Pick the lab case', sent: 'Sent to the lab', in_production: 'In production', shipped: 'Shipped by the lab',
  due: 'Due back soon', late: 'Late — call the lab', arrived: 'Arrived — check it', checked: 'Checked', problem: 'Problem', to_order: 'To order',
  ordered: 'Ordered', set_aside: 'Set aside', cancelled: 'Not needed',
};
const READY = new Set(['checked', 'set_aside']);
const WAITING = new Set(['sent', 'in_production', 'shipped', 'due', 'ordered']);
// One state for a visit: the worst of its items. null = the visit needs nothing.
export function rollup(states) {
  const s = states.filter((x) => x && x !== 'cancelled');
  if (!s.length) return null;
  if (s.includes('problem')) return 'problem';
  if (s.some((x) => ['needed', 'choose', 'to_order'].includes(x))) return 'missing';
  if (s.includes('late')) return 'late';
  if (s.some((x) => WAITING.has(x))) return 'waiting';
  if (s.includes('arrived')) return 'arrived';
  return s.every((x) => READY.has(x)) ? 'ready' : 'waiting';
}
export const ROLLUP_LABEL = { ready: 'Everything is here and checked', arrived: 'Arrived — needs a check', waiting: 'Waiting on the lab or an order', late: 'Late — call the lab', missing: 'Something isn’t ordered or linked', problem: 'Problem with the case or parts' };
export const isReady = (state) => state === 'ready';

export const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const ACTIVE_APPT = "('scheduled','confirmed','checked_in','in_chair')";
const OPEN_CASE = "('sent','returned_for_adjustment','received')";
const who = (p) => `${p.preferred_name || p.first_name} ${p.last_name}`;

// Inserts a row into one of this module's tables and returns its id (RETURNING works on both databases,
// before and after the tables are listed in db.js).
async function add(db, table, row) {
  const keys = Object.keys(row);
  const r = await db.get(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING id`, ...Object.values(row));
  return r?.id;
}
export { add as insertRow };

// ---- Linking (LB1) and templates (LB5) for one visit ----
// Idempotent: run on every schedule load, the huddle, and the hourly job. Changes are recorded as automation.
export async function syncVisit(db, appt, settings, today) {
  if (!appt || !['scheduled', 'confirmed', 'checked_in', 'in_chair'].includes(appt.status)) return;
  const reqs = await db.all('SELECT * FROM visit_requirements WHERE appointment_id = ?', appt.id);
  const procs = await db.all("SELECT id, code, tooth, area, description FROM procedures WHERE appointment_id = ? AND practice_id = ? AND status != 'cancelled'", appt.id, appt.practice_id);
  const open = await db.all(`SELECT * FROM lab_cases WHERE practice_id = ? AND patient_id = ? AND status IN ${OPEN_CASE}`, appt.practice_id, appt.patient_id);
  // Cases already linked to another visit that's still coming up aren't offered again.
  const taken = new Set((await db.all(
    `SELECT r.lab_case_id FROM visit_requirements r JOIN appointments a ON a.id = r.appointment_id
     WHERE r.practice_id = ? AND r.patient_id = ? AND r.lab_case_id IS NOT NULL AND r.status != 'cancelled' AND r.appointment_id != ? AND a.status IN ${ACTIVE_APPT}`,
    appt.practice_id, appt.patient_id, appt.id,
  )).map((r) => r.lab_case_id));
  const linked = new Set(reqs.filter((r) => r.lab_case_id && r.status !== 'cancelled').map((r) => r.lab_case_id));
  const made = [];
  const addReq = async (row) => {
    const id = await db.get(
      `INSERT INTO visit_requirements (practice_id, location_id, appointment_id, patient_id, kind, link_key, lab_case_id, procedure_id, item_name, details, inventory_item_id, qty, status, source, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (appointment_id, link_key) DO NOTHING RETURNING id`,
      appt.practice_id, appt.location_id ?? null, appt.id, appt.patient_id, row.kind, row.link_key, row.lab_case_id ?? null, row.procedure_id ?? null,
      row.item_name ?? null, row.details ?? null, row.inventory_item_id ?? null, row.qty ?? 1, row.status, row.source || 'auto', row.reason ?? null,
    );
    if (id?.id) made.push({ id: id.id, ...row });
    return id?.id;
  };
  const linkCase = async (c) => {
    linked.add(c.id);
    if (!c.appointment_id) await change(db, 'lab_cases', c.id, { appointment_id: appt.id });
    if (!c.promised_date && c.due_date) await change(db, 'lab_cases', c.id, { promised_date: c.due_date });
  };
  // 1. The office named this visit on the case.
  for (const c of open.filter((x) => x.appointment_id === appt.id && !linked.has(x.id))) {
    if (await addReq({ kind: 'lab_case', link_key: `lab:${c.id}`, lab_case_id: c.id, procedure_id: c.procedure_id || null, status: 'linked', reason: `Case #${c.id} names this visit as its seat appointment` })) await linkCase(c);
  }
  // 2. Each lab procedure on the visit: its case, if exactly one open case fits.
  for (const p of procs) {
    const kind = labKind(p.code);
    if (!kind) continue;
    const mine = reqs.find((r) => r.procedure_id === p.id && r.kind === 'lab_case');
    if (mine?.lab_case_id || mine?.status === 'cancelled') continue;
    const teeth = parseTeeth(p.tooth);
    const arch = archOf(p.code, p.area);
    const covers = (c) => c.procedure_id === p.id || (teeth.size && overlap(parseTeeth(c.tooth), teeth))
      || (!teeth.size && (kindFromText(c.description) || labKind(String(c.description).slice(0, 5))) === kind && (!arch || !archFromText(`${c.description} ${c.tooth || ''}`) || archFromText(`${c.description} ${c.tooth || ''}`) === arch));
    const already = [...linked].map((id) => open.find((c) => c.id === id)).filter(Boolean).find(covers);
    if (already) continue;
    const fits = open.filter((c) => !linked.has(c.id) && !taken.has(c.id) && covers(c));
    const exact = fits.filter((c) => c.procedure_id === p.id);
    const pickOne = exact.length === 1 ? exact[0] : fits.length === 1 ? fits[0] : null;
    const reason = pickOne ? (pickOne.procedure_id === p.id ? `Case #${pickOne.id} was made for ${p.code}${p.tooth ? ` #${p.tooth}` : ''}` : `Case #${pickOne.id} is the only open case for ${teeth.size ? `tooth #${[...teeth].join(', ')}` : KIND_LABEL[kind].toLowerCase()}`) : null;
    if (mine && pickOne) {
      await change(db, 'visit_requirements', mine.id, { lab_case_id: pickOne.id, status: 'linked', reason });
      await linkCase(pickOne);
      made.push({ id: mine.id, lab_case_id: pickOne.id, reason });
    } else if (!mine) {
      if (await addReq({ kind: 'lab_case', link_key: `proc:${p.id}`, procedure_id: p.id, lab_case_id: pickOne?.id ?? null, status: pickOne ? 'linked' : 'needed', reason, item_name: `${KIND_LABEL[kind]}${p.tooth ? ` #${p.tooth}` : arch ? ` (${arch === 'U' ? 'upper' : 'lower'})` : ''}` }) && pickOne) await linkCase(pickOne);
    }
  }
  // 3. Parts the procedures need (templates).
  for (const p of procs) {
    const items = settings.templates[p.code] || [];
    for (let i = 0; i < items.length; i++) {
      const t = items[i];
      await addReq({ kind: 'part', link_key: `tpl:${p.id}:${i}`, procedure_id: p.id, item_name: t.name, qty: t.qty, details: t.part ? JSON.stringify({ part: t.part }) : null, inventory_item_id: t.inventory_item_id || null, status: 'to_order', source: 'template', reason: `${p.code} usually needs this` });
    }
  }
  for (const m of made) {
    if (m.kind === 'part' && m.inventory_item_id) await reserveOrOrder(db, m.id, today);
    await audit(db, null, m.kind === 'part' ? 'visit_requirement.template' : 'visit_requirement.auto_link', 'visit_requirements', m.id,
      { appointment_id: appt.id, lab_case_id: m.lab_case_id ?? null, item: m.item_name ?? null, reason: m.reason ?? null }, { patientId: appt.patient_id, locationId: appt.location_id ?? null, source: 'automation', actor: 'Visit readiness' });
  }
  return made.length;
}

// Stock for a part: set aside if the shelf has enough that isn't already set aside for another visit; otherwise it
// stays "to order" (the order is a to-do made by the sweep, and the part shows on the to-order list).
export async function stockFor(db, itemId, exceptReqId = 0) {
  const item = await db.get('SELECT * FROM inventory_items WHERE id = ?', itemId);
  if (!item) return null;
  const r = await db.get(
    `SELECT COALESCE(SUM(r.qty), 0) AS n FROM visit_requirements r JOIN appointments a ON a.id = r.appointment_id
     WHERE r.inventory_item_id = ? AND r.id != ? AND r.status IN ('set_aside','checked') AND a.status IN ${ACTIVE_APPT}`, itemId, exceptReqId,
  );
  return { item, on_hand: item.on_hand, reserved: Number(r?.n || 0), available: item.on_hand - Number(r?.n || 0) };
}
export async function reserveOrOrder(db, reqId) {
  const req = await db.get('SELECT * FROM visit_requirements WHERE id = ?', reqId);
  if (!req?.inventory_item_id || !['to_order', 'set_aside'].includes(req.status)) return req?.status;
  const s = await stockFor(db, req.inventory_item_id, req.id);
  const status = s && s.available >= req.qty ? 'set_aside' : 'to_order';
  const reason = s ? (status === 'set_aside' ? `Set aside from stock (${s.available - req.qty} ${s.item.unit} left free)` : `Only ${Math.max(0, s.available)} ${s.item.unit} free on the shelf — order ${req.qty - Math.max(0, s.available)}`) : null;
  if (status !== req.status || reason !== req.reason) await change(db, 'visit_requirements', req.id, { status, reason });
  return status;
}

// Everything one visit needs, with its state. Cases to choose from are offered when a lab procedure has none.
export async function visitItems(db, appt, today) {
  const date = appt.start_time.slice(0, 10);
  const rows = await db.all(
    `SELECT r.*, l.status AS case_status, l.lab_status, l.check_status, l.due_date, l.received_date, l.lab_name, l.description AS case_description, l.tooth AS case_tooth, l.shade,
       i.name AS inventory_name, i.on_hand
     FROM visit_requirements r LEFT JOIN lab_cases l ON l.id = r.lab_case_id LEFT JOIN inventory_items i ON i.id = r.inventory_item_id
     WHERE r.appointment_id = ? AND r.practice_id = ? AND r.status != 'cancelled' ORDER BY r.kind, r.id`, appt.id, appt.practice_id,
  );
  const out = [];
  for (const r of rows) {
    let state;
    let choices;
    if (r.kind === 'lab_case') {
      state = r.lab_case_id ? caseState({ status: r.case_status, lab_status: r.lab_status, check_status: r.check_status, due_date: r.due_date }, date, today) : 'needed';
      if (!r.lab_case_id) {
        choices = await db.all(`SELECT id, lab_name, description, tooth, due_date, status FROM lab_cases WHERE practice_id = ? AND patient_id = ? AND status IN ${OPEN_CASE} ORDER BY due_date`, appt.practice_id, appt.patient_id);
        if (choices.length) state = 'choose';
      }
    } else state = r.status === 'linked' || r.status === 'needed' ? 'to_order' : r.status;
    out.push({
      id: r.id, kind: r.kind, state, label: STATE_LABEL[state], lab_case_id: r.lab_case_id, procedure_id: r.procedure_id, source: r.source, reason: r.reason,
      name: r.kind === 'lab_case' ? (r.lab_case_id ? `${r.case_description}${r.case_tooth ? ` #${r.case_tooth}` : ''}` : r.item_name) : r.item_name,
      lab_name: r.lab_name || null, due_date: r.due_date || null, shade: r.shade || null, qty: r.qty, details: r.details ? JSON.parse(r.details) : null,
      inventory_item_id: r.inventory_item_id, inventory_name: r.inventory_name || null, on_hand: r.on_hand ?? null, task_id: r.task_id, photo_ids: r.photo_ids ? JSON.parse(r.photo_ids) : [],
      ...(choices ? { choices } : {}),
    });
  }
  const state = rollup(out.map((x) => x.state));
  return { appointment_id: appt.id, patient_id: appt.patient_id, state, label: state ? ROLLUP_LABEL[state] : null, items: out };
}

// Visits in a date range (the person's offices only) with their readiness; linking and templates run first.
export async function readinessFor(db, { practiceId, from, to, scope = { sql: '', args: [] }, locationId = null, sync = true }) {
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  const settings = readSettings(practice);
  const today = (await practiceNow(db, practiceId)).slice(0, 10);
  const appts = await db.all(
    `SELECT a.* FROM appointments a WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status NOT IN ('cancelled','no_show')${locationId ? ' AND a.location_id = ?' : ''}${scope.sql} ORDER BY a.start_time`,
    practiceId, `${from} 00:00`, `${addDays(to, 1)} 00:00`, ...(locationId ? [locationId] : []), ...scope.args,
  );
  if (sync && to >= today) {
    await withActor({ source: 'automation', actor: 'Visit readiness', practiceId }, async () => {
      await db.run('UPDATE lab_cases SET promised_date = due_date WHERE practice_id = ? AND promised_date IS NULL AND due_date IS NOT NULL', practiceId);
      for (const a of appts) if (a.start_time.slice(0, 10) >= today) await syncVisit(db, a, settings, today);
    });
  }
  const visits = [];
  for (const a of appts) {
    const v = await visitItems(db, a, today);
    if (v.items.length) visits.push({ ...v, start_time: a.start_time, provider_id: a.provider_id, location_id: a.location_id, status: a.status });
  }
  return { today, settings, visits };
}

// ---- The huddle sweep (LB1): visits within N days that aren't ready get a to-do, once per item ----
export async function sweepPractice(db, practiceId) {
  const today = (await practiceNow(db, practiceId)).slice(0, 10);
  const ahead = readSettings(await db.get('SELECT readiness_settings FROM practices WHERE id = ?', practiceId)).days_ahead;
  const { settings, visits } = await readinessFor(db, { practiceId, from: today, to: addDays(today, ahead) });
  let made = 0;
  await withActor({ source: 'automation', actor: 'Visit readiness', practiceId }, async () => {
    for (const v of visits) {
      if (v.start_time.slice(0, 10) > addDays(today, settings.days_ahead)) continue;
      const p = await db.get('SELECT first_name, last_name, preferred_name FROM patients WHERE id = ?', v.patient_id);
      for (const it of v.items) {
        const title = TASK_FOR[it.state]?.(it, p, v);
        if (!title || it.task_id) continue;
        // Claim the row first, so two servers (or a double run) make one task.
        const claimed = await db.run('UPDATE visit_requirements SET task_id = -1 WHERE id = ? AND task_id IS NULL', it.id);
        if (!claimed.changes) continue;
        const taskId = await insert(db, 'tasks', { practice_id: practiceId, patient_id: v.patient_id, title: title.slice(0, 300), priority: ['late', 'needed', 'problem'].includes(it.state) || v.start_time.slice(0, 10) <= addDays(today, 1) ? 'high' : 'normal', due_date: today });
        await db.run('UPDATE visit_requirements SET task_id = ? WHERE id = ?', taskId, it.id);
        await audit(db, null, 'visit_requirement.task', 'visit_requirements', it.id, { task_id: taskId, state: it.state }, { patientId: v.patient_id, source: 'automation', actor: 'Visit readiness' });
        made++;
      }
    }
  });
  if (made) publish(practiceId, { type: 'tasks' });
  return made;
}
const visitWhen = (v) => new Date(`${v.start_time.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const TASK_FOR = {
  sent: (it, p, v) => `Call the lab${it.lab_name ? ` (${it.lab_name})` : ''}: ${who(p)}'s ${it.name} isn't back — visit ${visitWhen(v)}`,
  in_production: (it, p, v) => TASK_FOR.sent(it, p, v),
  due: (it, p, v) => TASK_FOR.sent(it, p, v),
  late: (it, p, v) => `Call the lab${it.lab_name ? ` (${it.lab_name})` : ''}: ${who(p)}'s ${it.name} is late (due ${it.due_date || '?'}) — visit ${visitWhen(v)}`,
  needed: (it, p, v) => `No lab case for ${who(p)}'s ${it.name} — visit ${visitWhen(v)}. Send the case or mark it made in the office`,
  choose: (it, p, v) => `Link ${who(p)}'s lab case to the ${visitWhen(v)} visit (${it.name})`,
  to_order: (it, p, v) => `Order ${it.qty > 1 ? `${it.qty} × ` : ''}${it.name}${it.details?.brand ? ` (${[it.details.brand, it.details.platform, it.details.size].filter(Boolean).join(' ')})` : ''} for ${who(p)} — visit ${visitWhen(v)}`,
  ordered: (it, p, v) => `Check on the order: ${it.name} for ${who(p)} isn't in — visit ${visitWhen(v)}`,
};
export async function runReadinessJob(db) {
  let n = 0;
  for (const p of await db.all('SELECT id FROM practices')) n += await sweepPractice(db, p.id);
  return n;
}

// ---- Voice (LB3): what was said → patient, teeth, kind, shade, part, verdict. Deterministic; nothing is saved ----
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
};
function wordsToNumbers(t) {
  return t.replace(/\b(twenty|thirty)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/g, (_, a, b) => String(NUMBER_WORDS[a] + NUMBER_WORDS[b]))
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty)\b/g, (w) => String(NUMBER_WORDS[w]))
    .replace(/\b(\d+)\s+point\s+(\d+)\b/g, '$1.$2');
}
// Problems said out loud → which checklist item fails, and whether it sounds like a remake or an adjustment.
const PROBLEMS = [
  [/\b(open margin|margins? (is |are |looks? |seems? )?(open|short|off|bad)|margin (gap|discrepancy)|short margin)\b/, 'margins', 'remake', 'Margin is open'],
  [/\b(open contacts?|contacts? (is |are )?(open|light|tight|heavy|off)|tight contacts?|light contacts?)\b/, 'margins', 'adjust', 'Contacts need adjusting'],
  [/\b(does ?n[o']?t fit|not fitting|won'?t seat|rocks|rocking|doesn'?t seat)\b/, 'margins', 'remake', 'Doesn’t fit'],
  [/\b(too high|high occlusion|occlusion (is )?(high|off)|bite is high)\b/, 'margins', 'adjust', 'Occlusion is high'],
  [/\b(cracked|crack|chipped|chip|broken|fractured|porosity|bubbles?)\b/, 'no_cracks', 'remake', 'Cracked or chipped'],
  [/\b(wrong shade|shade (is |looks )?(off|wrong|too (dark|light)|doesn'?t match)|too (dark|light|opaque|gray|grey))\b/, 'shade', 'remake', 'Shade is off'],
  [/\b(missing|no models?|without (the )?models?|didn'?t (send|include)|forgot)\b/, 'all_parts', 'missing_parts', 'Something is missing'],
  [/\b(wrong (tooth|patient|case|name)|not (her|his|their)s)\b/, 'right_patient', 'remake', 'Wrong patient or tooth'],
  [/\b(does ?n[o']?t match (the )?(rx|prescription)|wrong material|not what we ordered)\b/, 'matches_rx', 'remake', 'Doesn’t match the Rx'],
  [/\b(remake|redo|send (it )?back|not (acceptable|right|good)|problem|issue)\b/, null, 'remake', 'Needs a remake'],
];
const NEGATED_PROBLEMS = /\b(no (cracks?|chips?|bubbles?|porosity|problems?|issues?)|nothing (is )?missing|not (cracked|chipped|broken|missing))\b/g;
const GOOD = /\b(looks? (good|great|fine|perfect|beautiful|ok|okay)|all good|good to go|perfect|checks? out|we'?re good|it'?s good|approved|all set)\b/;
export const CHECKLIST = {
  right_patient: 'Right patient and tooth', matches_rx: 'Matches the Rx', shade: 'Shade is right', margins: 'Margins and contacts look right',
  no_cracks: 'No cracks or chips', all_parts: 'All parts and models are there',
};
const PART_WORDS = [
  ['healing_abutment', /\bhealing (abutment|cap|collar)s?\b/], ['scan_body', /\bscan ?bod(y|ies)\b/], ['screw', /\b(abutment |prosthetic )?screws?\b/],
  ['abutment', /\babutments?\b/], ['fixture', /\b(fixtures?|implants?)\b/], ['membrane', /\bmembranes?\b/], ['graft', /\b(bone )?graft( material)?\b|\ballograft\b|\bxenograft\b/],
  ['aligners', /\baligners?\b|\btrays?\b/], ['retainer', /\bretainers?\b|\bessix\b/], ['sedation_kit', /\bsedation\b/],
];
const BRANDS = ['nobel', 'straumann', 'zimmer', 'biohorizons', 'neodent', 'megagen', 'osstem', 'hiossen', 'astra', 'dentsply', 'bicon', 'implant direct', 'blue sky', 'keystone', 'invisalign', 'spark', 'clearcorrect'];

export function parseUtterance(input) {
  const raw = String(input || '').slice(0, 1000);
  let t = ` ${wordsToNumbers(raw.toLowerCase().replace(/[’‘]/g, "'").replace(/[—–]/g, ' - '))} `;
  const out = { text: raw, patient_words: [], teeth: [], arch: null, kind: null, shade: null, verdict: null, problems: [], checklist: {}, problem_kind: null, part: null };
  // Patient name: the words after "for" / "patient" up to the next pause or keyword.
  const nm = /\b(?:for|patient)\s+([a-z][a-z'.-]+(?:\s+[a-z][a-z'.-]+){0,2}?)(?=\s*(?:[,.;:]|\s-\s|\s(?:is|it|crown|bridge|denture|partial|night|guard|implant|number|tooth|teeth|shade|upper|lower|the|a|her|his|looks|all|and|are|veneer|onlay|inlay|nobel|straumann|parts?)\b|\s*$))/.exec(t);
  const skip = new Set(['this', 'the', 'patient', 'case', 'lab', 'her', 'his', 'a', 'an', 'number', 'tooth']);
  if (nm) out.patient_words = nm[1].split(/\s+/).filter((w) => !skip.has(w)).slice(0, 3);
  // Shade before teeth ("shade A2" isn't tooth 2). Vita classic (A1–D4, with half shades), bleach (BL1–4, OM1–3), 3D-Master (2M2).
  const sh = /\bshade\s+(?:is\s+|of\s+)?(bl\s?[1-4]|om\s?[1-3]|[1-5]\s?[lmr]\s?[1-3](?:\.5)?|[a-d]\s?-?\s?[1-4](?:\.5)?)\b/.exec(t);
  if (sh) {
    out.shade = sh[1].replace(/[\s-]/g, '').toUpperCase();
    t = t.replace(sh[0], ' ');
  }
  // Implant sizes ("4.3 by 10", "4.3 x 10 mm") before teeth, so the length isn't read as a tooth.
  const size = /\b(\d(?:\.\d{1,2})?)\s*(?:mm\s*)?(?:by|x|×)\s*(\d{1,2}(?:\.\d)?)\s*(?:mm|millimeters?)?\b/.exec(t);
  const brand = BRANDS.find((b) => new RegExp(`\\b${b}\\b`).test(t));
  const platform = /\b(np|rp|wp|narrow platform|regular platform|wide platform|nc|rc)\b/.exec(t)?.[1] || null;
  const partKind = PART_WORDS.find(([, re]) => re.test(t))?.[0] || null;
  if (size) t = t.replace(size[0], ' ');
  if (partKind || brand || size) {
    out.part = { part: partKind || (size ? 'fixture' : null), brand: brand ? brand.replace(/\b\w/g, (c) => c.toUpperCase()) : null, platform: platform ? platform.toUpperCase() : null, diameter: size ? Number(size[1]) : null, length: size ? Number(size[2]) : null };
  }
  // Teeth: "number 30", "tooth #3", "#14", "teeth 3 through 5" / "3 to 5".
  const teeth = new Set();
  for (const m of t.matchAll(/(?:\bteeth\s+|\btooth\s+|\bnumbers?\s+|#\s*|\bno\.\s*|\bon\s+(?=#?\d{1,2}\b))#?\s*(\d{1,2})(?:\s*(?:-|to|through|thru)\s*#?(\d{1,2}))?(?:\s*(?:and|,)\s*#?(\d{1,2})\b)?/g)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : null;
    if (b && b > a && b - a <= 16) for (let n = a; n <= b; n++) teeth.add(n);
    else teeth.add(a);
    if (m[3]) teeth.add(Number(m[3]));
  }
  out.teeth = [...teeth].filter((n) => n >= 1 && n <= 32).map(String);
  out.arch = archFromText(t);
  out.kind = kindFromText(t);
  // Verdict: a problem said anywhere wins over "looks good" ("looks good but the margin is open").
  const cleared = t.replace(NEGATED_PROBLEMS, (m) => {
    if (/crack|chip|broken|bubble|porosity/.test(m)) out.checklist.no_cracks = true;
    if (/missing/.test(m)) out.checklist.all_parts = true;
    return ' ';
  });
  for (const [re, item, kind, label] of PROBLEMS) {
    if (!re.test(cleared)) continue;
    if (label === 'Needs a remake' && out.problems.length) continue;
    out.problems.push(label);
    if (item) out.checklist[item] = false;
    out.problem_kind ??= kind;
  }
  if (out.problems.length) out.verdict = 'problem';
  else if (GOOD.test(cleared)) {
    out.verdict = 'ok';
    for (const k of Object.keys(CHECKLIST)) out.checklist[k] ??= true;
  }
  return out;
}

// Which case (or part) was meant: every open candidate scored on name, teeth, kind, arch and part details.
// Never decides alone — `confident` only means one candidate stands clearly above the rest.
export function matchUtterance(parsed, candidates) {
  const words = new Set(parsed.patient_words.length ? parsed.patient_words : String(parsed.text || '').toLowerCase().split(/[^a-z'-]+/));
  const teeth = new Set(parsed.teeth);
  const scored = candidates.map((c) => {
    let score = 0;
    const why = [];
    const last = String(c.last_name || '').toLowerCase();
    const firsts = [c.first_name, c.preferred_name].filter(Boolean).map((x) => x.toLowerCase());
    if (last && words.has(last)) { score += 4; why.push('last name'); }
    if (firsts.some((f) => words.has(f))) { score += 2; why.push('first name'); }
    const ct = parseTeeth(c.tooth);
    if (teeth.size && ct.size) {
      if (overlap(teeth, ct)) { score += 3; why.push(`tooth #${[...teeth].join(', ')}`); } else score -= 3;
    }
    const ck = c.type === 'part' ? null : c.kind || kindFromText(c.description);
    if (parsed.kind && ck) {
      if (parsed.kind === ck) { score += 2; why.push(KIND_LABEL[ck]?.toLowerCase() || ck); } else score -= 1;
    }
    const ca = c.arch || archFromText(`${c.description || ''} ${c.tooth || ''}`);
    if (parsed.arch && ca) {
      if (parsed.arch === ca) { score += 1; why.push(ca === 'U' ? 'upper' : 'lower'); } else score -= 2;
    }
    if (c.type === 'part' && parsed.part) {
      const d = c.details || {};
      const name = String(c.item_name || '').toLowerCase();
      if (parsed.part.part && (d.part === parsed.part.part || name.includes(parsed.part.part.replace('_', ' ')))) { score += 2; why.push(String(c.item_name).toLowerCase()); }
      if (parsed.part.brand && String(d.brand || '').toLowerCase() === parsed.part.brand.toLowerCase()) { score += 1; why.push(parsed.part.brand); }
      if (parsed.part.diameter && Number(d.diameter) === parsed.part.diameter && (!parsed.part.length || Number(d.length) === parsed.part.length)) { score += 2; why.push(`${parsed.part.diameter} × ${parsed.part.length}`); }
    } else if (c.type === 'part' && !parsed.part) score -= 1;
    else if (c.type !== 'part' && parsed.part && !parsed.kind) score -= 1;
    return { ...c, score, why };
  }).filter((c) => c.score > 0 && (!parsed.patient_words.length || c.why.some((w) => w.endsWith('name')))).sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  const nameHit = best && best.why.some((w) => w.endsWith('name'));
  const ambiguous = !best || (next && next.score >= best.score - 1) || !nameHit;
  return { best: best || null, candidates: scored.slice(0, 5), ambiguous, confident: !!best && !ambiguous && best.score >= 5, needs_confirm: true };
}

// A checklist sent from the screen: each item must be answered; "Looks good" needs every item ticked.
export function cleanChecklist(input, verdict) {
  const out = {};
  for (const k of Object.keys(CHECKLIST)) {
    const v = input?.[k];
    if (v !== true && v !== false) throw new HttpError(400, `Answer every checklist item (${CHECKLIST[k]})`);
    out[k] = v;
  }
  if (verdict === 'ok' && Object.values(out).some((v) => !v)) throw new HttpError(400, 'Something on the checklist isn’t right — note the problem instead of “Looks good”');
  return out;
}

// ---- Lab stats (LB4): turnaround against what was promised, late and remake rates, per lab ----
const days = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);
export function labStats(cases, today) {
  const by = new Map();
  for (const c of cases) {
    const key = c.lab_id ? `id:${c.lab_id}` : `name:${String(c.lab_name || '').toLowerCase()}`;
    if (!by.has(key)) by.set(key, { lab_id: c.lab_id || null, lab_name: c.lab_name, cases: 0, received: 0, turnaround_total: 0, turnaround_n: 0, promised_total: 0, promised_n: 0, late: 0, remakes: 0, problems: 0, open_late: 0 });
    const s = by.get(key);
    s.cases++;
    const promised = c.promised_date || c.due_date;
    if (c.received_date) {
      s.received++;
      if (c.sent_date) { s.turnaround_total += days(c.sent_date, c.received_date); s.turnaround_n++; }
      if (c.sent_date && promised) { s.promised_total += days(c.sent_date, promised); s.promised_n++; }
      if (promised && c.received_date > promised) s.late++;
    } else if (['sent', 'returned_for_adjustment'].includes(c.status) && promised && promised < today) s.open_late++;
    if (c.remade) s.remakes++;
    if (c.problem) s.problems++;
  }
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
  const avg = (t, n) => (n ? Math.round((t / n) * 10) / 10 : null);
  return [...by.values()].map((s) => ({
    lab_id: s.lab_id, lab_name: s.lab_name, cases: s.cases, received: s.received,
    avg_turnaround_days: avg(s.turnaround_total, s.turnaround_n), avg_promised_days: avg(s.promised_total, s.promised_n),
    late: s.late, late_pct: pct(s.late, s.received), remakes: s.remakes, remake_pct: pct(s.remakes, s.received), problems: s.problems, open_late: s.open_late,
  })).sort((a, b) => b.cases - a.cases || String(a.lab_name).localeCompare(String(b.lab_name)));
}

// The note for the lab after a failed check (a person reads, edits and sends it).
export function labMessageDraft({ kind, patient, labCase, problems, note, visitDate }) {
  const what = `${labCase.description}${labCase.tooth ? ` #${labCase.tooth}` : ''}`;
  const ask = kind === 'adjust' ? 'Please adjust it and send it back' : 'Please remake it';
  return [
    `Case #${labCase.id} — ${patient} — ${what}${labCase.shade ? `, shade ${labCase.shade}` : ''}`,
    '',
    `We checked this case when it arrived and it isn't ready to seat: ${[...(problems || []), note].filter(Boolean).join('; ')}.`,
    `${ask}${visitDate ? ` — the patient is scheduled ${visitDate}; let us know the new ship date so we can keep or move the visit` : ''}.`,
    'Photos from our check are on the case link.',
  ].join('\n');
}
