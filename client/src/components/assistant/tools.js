import { api } from '../../api.js';
import { fmtDate } from '../../format.js';

// What the assistant's tools do in the browser. Every step goes through the same API as the screens,
// as the signed-in user: permissions, office restrictions, validation and the audit log apply as usual.
// Results are kept small and plain (Claude reads them), and names seen along the way are remembered so
// confirmations can say "Ryan Smith" rather than "patient 42".

const names = { patients: new Map(), providers: new Map(), types: new Map(), appointments: new Map() };
const fullName = (p) => `${p.preferred_name || p.first_name} ${p.last_name}`;
const dollars = (cents) => Math.round(Number(cents || 0)) / 100;
const pad = (n) => String(n).padStart(2, '0');
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const addMinutes = (dt, mins) => {
  const [d, t] = dt.split(' ');
  const total = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + mins;
  const day = addDays(d, Math.floor(total / 1440));
  const m = ((total % 1440) + 1440) % 1440;
  return `${day} ${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
const minutesBetween = (a, b) => (Date.parse(`${b.replace(' ', 'T')}:00Z`) - Date.parse(`${a.replace(' ', 'T')}:00Z`)) / 60000;
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const normTime = (s) => {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) throw new Error('start_time must be YYYY-MM-DD HH:MM');
  return `${m[1]} ${pad(m[2])}:${m[3]}`;
};
export const clock = (dt) => {
  const [h, m] = dt.slice(11, 16).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
};
const when = (dt) => `${fmtDate(dt.slice(0, 10))} at ${clock(dt)}`;

const rememberAppt = (a) => {
  names.appointments.set(a.id, a);
  if (a.patient_id && a.first_name) names.patients.set(a.patient_id, fullName(a));
};
const apptView = (a) => {
  rememberAppt(a);
  return { id: a.id, patient_id: a.patient_id, patient: a.first_name ? fullName(a) : undefined, start_time: a.start_time?.slice(0, 16), end_time: a.end_time?.slice(0, 16), provider: a.provider_name, chair: a.operatory_name, reason: a.reason || a.type_name, status: a.status, procedures: a.procedure_summary || undefined };
};

let setupCache = null;
async function setup() {
  if (!setupCache) {
    const [providers, operatories, types] = await Promise.all([api.get('/providers'), api.get('/operatories'), api.get('/appointment-types')]);
    setupCache = {
      providers: providers.filter((p) => p.active !== 0).map((p) => ({ id: p.id, name: p.name, type: p.type })),
      chairs: operatories.filter((o) => o.active !== 0).map((o) => ({ id: o.id, name: o.name, hygiene: !!o.is_hygiene })),
      appointment_types: types.filter((t) => t.active !== 0).map((t) => ({ id: t.id, name: t.name, minutes: t.duration })),
    };
    for (const p of setupCache.providers) names.providers.set(p.id, p.name);
    for (const t of setupCache.appointment_types) names.types.set(t.id, t);
  }
  return setupCache;
}
let codesCache = null;
async function patientName(id) {
  if (!names.patients.has(id)) {
    try { names.patients.set(id, fullName(await api.get(`/patients/${id}`))); } catch { names.patients.set(id, `patient #${id}`); }
  }
  return names.patients.get(id);
}

// ---- Tools that only look (run straight away) ----
export const READERS = {
  async find_patient({ query }) {
    const out = await api.get(`/patients?q=${encodeURIComponent(query)}&limit=8&status=all`);
    return out.rows.map((p) => {
      names.patients.set(p.id, fullName(p));
      return { id: p.id, name: fullName(p), dob: p.dob, phone: p.phone, status: p.status, balance: dollars(p.balance), next_appointment: p.next_appointment?.slice(0, 16) || null };
    });
  },
  async patient_summary({ patient_id: id }) {
    const card = await api.get(`/patients/${id}/card`);
    delete card.photo;
    return card;
  },
  practice_setup: () => setup(),
  async find_open_times({ provider_id: providerId, from_date: from, days = 7, duration_minutes: duration, appointment_type_id: typeId, time_of_day: tod = 'any' }) {
    await setup();
    const length = duration || names.types.get(typeId)?.minutes || 60;
    const out = [];
    const now = `${localToday()} ${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
    for (let i = 0; i < Math.min(Math.max(days, 1), 21) && out.length < 12; i++) {
      const date = addDays(from, i);
      const q = new URLSearchParams({ date, provider_id: providerId, duration: length, ...(typeId ? { appointment_type_id: typeId } : {}) });
      const { slots } = await api.get(`/availability?${q}`);
      for (const s of slots) {
        const hour = Number(s.slice(11, 13));
        if (s <= now || !/:(00|30)$/.test(s)) continue; // offer times on the hour and half hour
        if ((tod === 'morning' && hour >= 12) || (tod === 'afternoon' && hour < 12)) continue;
        out.push(s);
        if (out.length >= 12) break;
      }
    }
    return { provider: names.providers.get(providerId), minutes: length, open_times: out };
  },
  async patient_appointments({ patient_id: id }) {
    const today = localToday();
    return (await api.get(`/appointments?patient_id=${id}&from=${today}&to=${addDays(today, 365)}`)).map(apptView);
  },
  async day_schedule({ date, provider_id: providerId }) {
    return (await api.get(`/appointments?from=${date}${providerId ? `&provider_id=${providerId}` : ''}`)).map(apptView);
  },
  async search_procedure_codes({ query }) {
    codesCache ||= await api.get('/procedure-codes?active=true');
    const q = String(query || '').trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const hits = codesCache.filter((c) => c.code.toLowerCase() === q || words.every((w) => `${c.code} ${c.description} ${c.category || ''}`.toLowerCase().includes(w)));
    return hits.slice(0, 12).map((c) => ({ code: c.code, description: c.description, requires_tooth: !!c.requires_tooth, requires_surfaces: !!c.requires_surface }));
  },
  async patient_treatment({ patient_id: id }) {
    return (await api.get(`/patients/${id}/procedures`)).filter((p) => p.status === 'planned')
      .map((p) => ({ id: p.id, code: p.code, description: p.description, tooth: p.tooth, surfaces: p.surfaces, fee: dollars(p.fee), appointment_id: p.appointment_id }));
  },
};

// ---- Tools that change the record (the user confirms first) ----
export const WRITERS = {
  async book_appointment(i) {
    const start = normTime(i.start_time);
    await setup();
    const body = {
      patient_id: i.patient_id, provider_id: i.provider_id, start_time: start, operatory_id: i.operatory_id, appointment_type_id: i.appointment_type_id, reason: i.reason, notes: i.notes,
      ...(i.appointment_type_id && !i.duration_minutes ? {} : { end_time: addMinutes(start, i.duration_minutes || 60) }),
    };
    return apptView(await api.post('/appointments', body));
  },
  async reschedule_appointment(i) {
    const a = await api.get(`/appointments/${i.appointment_id}`);
    const start = normTime(i.start_time);
    const length = minutesBetween(a.start_time.slice(0, 16), a.end_time.slice(0, 16));
    const body = { start_time: start, end_time: addMinutes(start, length), ...(i.provider_id ? { provider_id: i.provider_id } : {}), ...(i.operatory_id ? { operatory_id: i.operatory_id } : {}) };
    return apptView(await api.put(`/appointments/${i.appointment_id}`, body));
  },
  async set_appointment_status({ appointment_id: id, status }) {
    const a = await api.patch(`/appointments/${id}/status`, { status });
    return { id, status: a.status || status };
  },
  async record_payment(i) {
    const out = await api.post(`/patients/${i.patient_id}/payments`, { amount: Math.round(Number(i.amount_dollars) * 100), method: i.method, reference: i.reference, description: i.note });
    return { payment_id: out.entry.id, amount: dollars(-out.entry.amount), new_balance: dollars(out.balance) };
  },
  async add_clinical_note(i) {
    const n = await api.post(`/patients/${i.patient_id}/notes`, { body: i.body, appointment_id: i.appointment_id });
    return { note_id: n.id, signed: false };
  },
  async add_procedures(i) {
    const done = [];
    for (const item of i.items || []) {
      const p = await api.post(`/patients/${i.patient_id}/procedures`, { code: item.code, tooth: item.tooth, surfaces: item.surfaces, area: item.area, provider_id: i.provider_id, complete: i.status === 'completed' });
      done.push({ id: p.id, code: p.code, tooth: p.tooth, status: p.status, fee: dollars(p.fee) });
    }
    return done;
  },
  async record_perio({ patient_id: id, teeth }) {
    const today = localToday();
    const exams = await api.get(`/patients/${id}/perio`);
    const list = Array.isArray(exams) ? exams : exams.exams || [];
    const existing = list.find((e) => e.exam_date === today);
    const readings = { ...(existing?.readings || {}) };
    for (const t of teeth || []) {
      const { tooth, ...v } = t;
      const key = String(tooth).toUpperCase();
      const merged = { ...(readings[key] || {}) };
      for (const k of ['pd', 'bop', 'gm']) {
        if (!Array.isArray(v[k])) continue;
        const base = merged[k] || Array(6).fill(k === 'bop' ? false : null);
        merged[k] = base.map((old, s) => (v[k][s] === null || v[k][s] === undefined ? old : v[k][s]));
      }
      if (v.mob != null) merged.mob = v.mob;
      if (v.missing) merged.missing = true;
      readings[key] = merged;
    }
    const out = existing ? await api.put(`/perio/${existing.id}`, { readings }) : await api.post(`/patients/${id}/perio`, { readings, exam_date: today });
    return { exam_id: out.id, teeth: (teeth || []).map((t) => String(t.tooth)) };
  },
};

// A plain-language line for the confirmation card.
export async function describe(name, i) {
  await setup().catch(() => {});
  const who = i.patient_id ? await patientName(i.patient_id) : null;
  const prov = (id) => names.providers.get(id) || `provider #${id}`;
  switch (name) {
    case 'book_appointment': {
      const type = names.types.get(i.appointment_type_id);
      return `Book ${who} — ${type?.name || i.reason || 'appointment'} with ${prov(i.provider_id)}, ${when(normTime(i.start_time))} (${i.duration_minutes || type?.minutes || 60} min)`;
    }
    case 'reschedule_appointment': {
      const a = names.appointments.get(i.appointment_id);
      return `Move ${a ? `${fullName(a)}'s ${a.reason || a.type_name || 'visit'} on ${when(a.start_time.slice(0, 16))}` : `appointment #${i.appointment_id}`} to ${when(normTime(i.start_time))}${i.provider_id ? ` with ${prov(i.provider_id)}` : ''}`;
    }
    case 'set_appointment_status': {
      const a = names.appointments.get(i.appointment_id);
      return `Mark ${a ? `${fullName(a)}'s ${when(a.start_time.slice(0, 16))} visit` : `appointment #${i.appointment_id}`} as ${i.status.replace('_', ' ')}`;
    }
    case 'record_payment':
      return `Post a $${Number(i.amount_dollars).toFixed(2)} ${i.method.replace('_', ' ')} payment for ${who}${i.reference ? ` (ref ${i.reference})` : ''}`;
    case 'add_clinical_note':
      return `Add a clinical note to ${who}'s chart:\n“${i.body}”`;
    case 'add_procedures':
      return `${i.status === 'completed' ? 'Chart as completed' : 'Add to the treatment plan'} for ${who}: ${(i.items || []).map((x) => `${x.code}${x.tooth ? ` #${x.tooth}` : ''}${x.surfaces ? ` ${x.surfaces}` : ''}${x.area ? ` ${x.area}` : ''}`).join(', ')}`;
    case 'record_perio':
      return `Record perio for ${who}: ${(i.teeth || []).map((t) => `#${t.tooth}${t.pd ? ` ${t.pd.map((d) => d ?? '–').join(' ')}` : ''}${t.bop?.some(Boolean) ? ' (bleeding)' : ''}${t.missing ? ' missing' : ''}`).join('; ')}`;
    default:
      return `${name} ${JSON.stringify(i)}`;
  }
}

// What a step looked like, for the little trail under each reply.
export function stepLabel(name, input, result) {
  switch (name) {
    case 'find_patient': return `Searched patients for “${input.query}” — ${Array.isArray(result) ? result.length : 0} found`;
    case 'find_open_times': return `Checked ${result?.provider || 'the'} schedule — ${result?.open_times?.length || 0} open times`;
    case 'practice_setup': return 'Looked up providers and visit types';
    case 'patient_summary': return 'Opened the patient summary';
    case 'patient_appointments': return 'Looked up upcoming visits';
    case 'day_schedule': return `Looked at ${fmtDate(input.date)}`;
    case 'search_procedure_codes': return `Looked up codes for “${input.query}”`;
    case 'patient_treatment': return 'Looked up planned treatment';
    default: return name;
  }
}

export function screenPath({ screen, patient_id: id, tab, date }) {
  if (screen === 'patient' && id) return `/patients/${id}${tab ? `?tab=${tab}` : ''}`;
  if (screen === 'schedule') return `/schedule${date ? `?date=${date}` : ''}`;
  return { patients: '/patients', today: '/', claims: '/claims', reports: '/reports', messages: '/messages', settings: '/settings' }[screen] || '/';
}
