import { api } from '../../api.js';

// The changes the assistant makes, run in the browser once the person says yes (or at once, for low-risk
// ones). Every step goes through the same API as the screens, as the signed-in user: permissions, office
// restrictions, validation and the audit log apply as usual. Each returns what happened (for Claude) and,
// where the change can be taken back, how to undo it.

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
  const m = ((total % 1440) + 1440) % 1440;
  return `${addDays(d, Math.floor(total / 1440))} ${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
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

let setupCache = null;
async function setup() {
  if (!setupCache) {
    const [providers, operatories, types] = await Promise.all([api.get('/providers'), api.get('/operatories'), api.get('/appointment-types')]);
    setupCache = { providers, chairs: operatories.filter((o) => o.active !== 0), types };
  }
  return setupCache;
}

// A chair for a booking when none was named: the provider's usual chair if it's free, else a free chair of
// the right kind (hygiene chairs for hygienists), else the first free one.
async function freeChair(i, start, length) {
  const { chairs, providers } = await setup();
  const end = addMinutes(start, length);
  const busy = new Set((await api.get(`/appointments?from=${start.slice(0, 10)}`))
    .filter((a) => a.operatory_id && a.start_time.slice(0, 16) < end && a.end_time.slice(0, 16) > start).map((a) => a.operatory_id));
  const free = chairs.filter((c) => !busy.has(c.id));
  const hygienist = providers.find((p) => p.id === i.provider_id)?.type === 'hygienist';
  return (free.find((c) => c.default_provider_id === i.provider_id) || free.find((c) => !!c.is_hygiene === hygienist) || free[0])?.id;
}

export const WRITERS = {
  async book_appointment(i) {
    const start = normTime(i.start_time);
    const { types } = await setup();
    const length = i.duration_minutes || types.find((t) => t.id === i.appointment_type_id)?.duration || 60;
    const operatoryId = i.operatory_id || await freeChair(i, start, length);
    const a = await api.post('/appointments', {
      patient_id: i.patient_id, provider_id: i.provider_id, start_time: start, operatory_id: operatoryId, appointment_type_id: i.appointment_type_id, reason: i.reason, notes: i.notes,
      ...(i.appointment_type_id && !i.duration_minutes ? {} : { end_time: addMinutes(start, length) }),
    });
    return { result: { id: a.id, start_time: a.start_time?.slice(0, 16), chair: a.operatory_name }, undo: () => api.patch(`/appointments/${a.id}/status`, { status: 'cancelled' }) };
  },
  async reschedule_appointment(i) {
    const before = await api.get(`/appointments/${i.appointment_id}`);
    const start = normTime(i.start_time);
    const length = minutesBetween(before.start_time.slice(0, 16), before.end_time.slice(0, 16));
    const a = await api.put(`/appointments/${i.appointment_id}`, { start_time: start, end_time: addMinutes(start, length), ...(i.provider_id ? { provider_id: i.provider_id } : {}), ...(i.operatory_id ? { operatory_id: i.operatory_id } : {}) });
    return {
      result: { id: a.id, start_time: a.start_time?.slice(0, 16) },
      undo: () => api.put(`/appointments/${i.appointment_id}`, { start_time: before.start_time.slice(0, 16), end_time: before.end_time.slice(0, 16), provider_id: before.provider_id, operatory_id: before.operatory_id }),
    };
  },
  async set_appointment_status({ appointment_id: id, status }) {
    const before = await api.get(`/appointments/${id}`);
    await api.patch(`/appointments/${id}/status`, { status });
    return { result: { id, status }, undo: () => api.patch(`/appointments/${id}/status`, { status: before.status }) };
  },
  async record_payment(i) {
    const out = await api.post(`/patients/${i.patient_id}/payments`, { amount: Math.round(Number(i.amount_dollars) * 100), method: i.method, reference: i.reference, description: i.note });
    return { result: { payment_id: out.entry.id, new_balance: dollars(out.balance) }, undo: () => api.post(`/ledger/${out.entry.id}/void`, { reason: 'Undone from the assistant' }) };
  },
  async add_clinical_note(i) {
    const n = await api.post(`/patients/${i.patient_id}/notes`, { body: i.body, appointment_id: i.appointment_id });
    return { result: { note_id: n.id, signed: false } }; // part of the record: edited in the chart, not undone
  },
  async add_procedures(i) {
    const done = [];
    for (const item of i.items || []) {
      const p = await api.post(`/patients/${i.patient_id}/procedures`, { code: item.code, tooth: item.tooth, surfaces: item.surfaces, area: item.area, provider_id: i.provider_id, complete: i.status === 'completed' });
      done.push(p);
    }
    return {
      result: done.map((p) => ({ id: p.id, code: p.code, tooth: p.tooth, status: p.status, fee: dollars(p.fee) })),
      undo: i.status === 'completed' ? null : () => Promise.all(done.map((p) => api.post(`/procedures/${p.id}/cancel`))),
    };
  },
  async chart_conditions(i) {
    const out = [];
    for (const c of i.items || []) out.push(await api.post(`/patients/${i.patient_id}/conditions`, { tooth: c.tooth, condition: c.condition, surfaces: c.surfaces, notes: c.notes }));
    return { result: out.map((c) => ({ id: c.id, tooth: c.tooth, condition: c.condition })) };
  },
  async record_perio({ patient_id: id, teeth }) {
    const today = localToday();
    const exams = await api.get(`/patients/${id}/perio`);
    const existing = (Array.isArray(exams) ? exams : []).find((e) => e.exam_date === today);
    const before = existing ? structuredClone(existing.readings) : null;
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
    return { result: { exam_id: out.id }, undo: () => (before ? api.put(`/perio/${out.id}`, { readings: before }) : api.del(`/perio/${out.id}`)) };
  },
};

export function screenPath({ name, screen, patient_id: id, tab, date }) {
  if (name === 'start_voice_perio') return `/patients/${id}?tab=perio`;
  if (screen === 'patient' && id) return `/patients/${id}${tab ? `?tab=${tab}` : ''}`;
  if (screen === 'schedule') return `/schedule${date ? `?date=${date}` : ''}`;
  return { patients: '/patients', today: '/', claims: '/claims', reports: '/reports', messages: '/messages', settings: '/settings' }[screen] || '/';
}
