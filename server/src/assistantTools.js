import { createServer } from 'node:http';

// The assistant's look-ups, run on the server so a whole request (find the patient, check the schedule,
// work out the booking) is one round trip for the browser. Each look-up goes through the app's own API
// as the signed-in user — same permissions, office limits and access log as the screens — via a private
// loopback listener on the same process.

let loopback = null;
function loopbackPort(app) {
  loopback ??= new Promise((resolve, reject) => {
    const server = createServer(app);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.unref();
  });
  return loopback;
}

export function apiAs(app, req) {
  return async (method, path, body) => {
    const port = await loopbackPort(app);
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: req.headers.authorization || '',
        ...(req.headers['x-location-id'] ? { 'X-Location-Id': req.headers['x-location-id'] } : {}),
        'X-Forwarded-For': req.ip || '',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  };
}

const pad = (n) => String(n).padStart(2, '0');
const fullName = (p) => `${p.preferred_name || p.first_name} ${p.last_name}`;
const dollars = (cents) => Math.round(Number(cents || 0)) / 100;
export const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const addMinutes = (dt, mins) => {
  const [d, t] = dt.split(' ');
  const total = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + mins;
  const m = ((total % 1440) + 1440) % 1440;
  return `${addDays(d, Math.floor(total / 1440))} ${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
export const normTime = (s) => {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) throw new Error('start_time must be YYYY-MM-DD HH:MM');
  return `${m[1]} ${pad(m[2])}:${m[3]}`;
};
const clock = (dt) => {
  const [h, m] = dt.slice(11, 16).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const when = (dt) => {
  const d = new Date(`${dt.slice(0, 10)}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} at ${clock(dt)}`;
};

// One conversation's look-ups share what they've learned (names for the confirmation lines).
export function toolbox(call, today) {
  const names = { patients: new Map(), providers: new Map(), types: new Map(), appointments: new Map() };
  let setupCache = null;
  let codesCache = null;
  const apptView = (a) => {
    names.appointments.set(a.id, a);
    if (a.patient_id && a.first_name) names.patients.set(a.patient_id, fullName(a));
    return {
      id: a.id, patient_id: a.patient_id, patient: a.first_name ? fullName(a) : undefined, start_time: a.start_time?.slice(0, 16), end_time: a.end_time?.slice(0, 16),
      provider: a.provider_name, chair: a.operatory_name, reason: a.reason || a.type_name, status: a.status, procedures: a.procedure_summary || undefined,
    };
  };
  async function setup() {
    if (!setupCache) {
      const [providers, operatories, types] = await Promise.all([call('GET', '/providers'), call('GET', '/operatories'), call('GET', '/appointment-types')]);
      setupCache = {
        providers: providers.filter((p) => p.active !== 0).map((p) => ({ id: p.id, name: p.name, type: p.type })),
        chairs: operatories.filter((o) => o.active !== 0).map((o) => ({ id: o.id, name: o.name, hygiene: !!o.is_hygiene, usual_provider_id: o.default_provider_id || null })),
        appointment_types: types.filter((t) => t.active !== 0).map((t) => ({ id: t.id, name: t.name, minutes: t.duration })),
      };
      for (const p of setupCache.providers) names.providers.set(p.id, p.name);
      for (const t of setupCache.appointment_types) names.types.set(t.id, t);
    }
    return setupCache;
  }
  async function patientName(id) {
    if (!names.patients.has(id)) {
      try { names.patients.set(id, fullName(await call('GET', `/patients/${id}`))); } catch { names.patients.set(id, `patient #${id}`); }
    }
    return names.patients.get(id);
  }

  const readers = {
    async find_patient({ query }) {
      const out = await call('GET', `/patients?q=${encodeURIComponent(query)}&limit=8&status=all`);
      return out.rows.map((p) => {
        names.patients.set(p.id, fullName(p));
        return { id: p.id, name: fullName(p), dob: p.dob, phone: p.phone, status: p.status, balance: dollars(p.balance), next_appointment: p.next_appointment?.slice(0, 16) || null };
      });
    },
    async patient_summary({ patient_id: id }) {
      const card = await call('GET', `/patients/${id}/card`);
      delete card.photo;
      return card;
    },
    practice_setup: () => setup(),
    async find_open_times({ provider_id: providerId, from_date: from, days = 7, duration_minutes: duration, appointment_type_id: typeId, time_of_day: tod = 'any' }) {
      await setup();
      const length = duration || names.types.get(typeId)?.minutes || 60;
      const dates = Array.from({ length: Math.min(Math.max(days, 1), 21) }, (_, i) => addDays(from, i));
      const days_ = await Promise.all(dates.map((date) => call('GET', `/availability?${new URLSearchParams({ date, provider_id: providerId, duration: length, ...(typeId ? { appointment_type_id: typeId } : {}) })}`)));
      const out = [];
      for (const { slots } of days_) {
        for (const s of slots) {
          const hour = Number(s.slice(11, 13));
          if (s <= today || !/:(00|30)$/.test(s)) continue; // offer times on the hour and half hour
          if ((tod === 'morning' && hour >= 12) || (tod === 'afternoon' && hour < 12)) continue;
          if (out.length < 12) out.push(s);
        }
      }
      return { provider: names.providers.get(providerId), minutes: length, open_times: out };
    },
    async patient_appointments({ patient_id: id }) {
      const d = today.slice(0, 10);
      return (await call('GET', `/appointments?patient_id=${id}&from=${d}&to=${addDays(d, 365)}`)).map(apptView);
    },
    async day_schedule({ date, provider_id: providerId }) {
      return (await call('GET', `/appointments?from=${date}${providerId ? `&provider_id=${providerId}` : ''}`)).map(apptView);
    },
    async search_procedure_codes({ query }) {
      codesCache ||= await call('GET', '/procedure-codes?active=true');
      const q = String(query || '').trim().toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const hits = codesCache.filter((c) => c.code.toLowerCase() === q || words.every((w) => `${c.code} ${c.description} ${c.category || ''}`.toLowerCase().includes(w)));
      return hits.slice(0, 12).map((c) => ({ code: c.code, description: c.description, requires_tooth: !!c.requires_tooth, requires_surfaces: !!c.requires_surface }));
    },
    async patient_treatment({ patient_id: id }) {
      return (await call('GET', `/patients/${id}/procedures`)).filter((p) => p.status === 'planned')
        .map((p) => ({ id: p.id, code: p.code, description: p.description, tooth: p.tooth, surfaces: p.surfaces, fee: dollars(p.fee), appointment_id: p.appointment_id }));
    },
    async note_templates() {
      return (await call('GET', '/note-templates')).map((t) => ({ id: t.id, name: t.name, codes: t.codes || undefined, body: t.body }));
    },
  };

  // Plain-language line for the confirmation card and the done message.
  async function describe(name, i) {
    await setup().catch(() => {});
    const who = i.patient_id ? await patientName(i.patient_id) : null;
    const prov = (id) => names.providers.get(id) || `provider #${id}`;
    const appt = async (id) => {
      if (!names.appointments.has(id)) { try { apptView(await call('GET', `/appointments/${id}`)); } catch { /* described by number */ } }
      const a = names.appointments.get(id);
      return a ? `${fullName(a)}'s ${when(a.start_time.slice(0, 16))} visit` : `appointment #${id}`;
    };
    switch (name) {
      case 'book_appointment': {
        const type = names.types.get(i.appointment_type_id);
        return `Book ${who}: ${type?.name || i.reason || 'appointment'} with ${prov(i.provider_id)}, ${when(normTime(i.start_time))} (${i.duration_minutes || type?.minutes || 60} min)`;
      }
      case 'reschedule_appointment':
        return `Move ${await appt(i.appointment_id)} to ${when(normTime(i.start_time))}${i.provider_id ? ` with ${prov(i.provider_id)}` : ''}`;
      case 'set_appointment_status':
        return `${{ confirmed: 'Confirm', checked_in: 'Check in', in_chair: 'Seat', completed: 'Complete', cancelled: 'Cancel', no_show: 'Mark no-show:' }[i.status] || i.status} ${await appt(i.appointment_id)}`;
      case 'record_payment':
        return `Post a $${Number(i.amount_dollars).toFixed(2)} ${String(i.method).replace('_', ' ')} payment for ${who}${i.reference ? ` (ref ${i.reference})` : ''}`;
      case 'add_clinical_note':
        return `Add a clinical note for ${who}:\n“${i.body}”`;
      case 'add_procedures':
        return `${i.status === 'completed' ? 'Complete' : 'Plan'} for ${who}: ${(i.items || []).map((x) => `${x.code}${x.tooth ? ` #${x.tooth}` : ''}${x.surfaces ? ` ${x.surfaces}` : ''}${x.area ? ` ${x.area}` : ''}`).join(', ')}`;
      case 'chart_entry': {
        // The same preview the chart shows (POST /charting/resolve): what will be charted, fees, and anything to check.
        let r;
        try {
          r = await call('POST', '/charting/resolve', { patient_id: i.patient_id, text: i.text });
        } catch (err) {
          return `Chart for ${who}: “${i.text}” — can’t: ${err.message}`;
        }
        const line = (items) => items.map((x) => `${x.text}${x.error ? ` (can’t: ${x.error})` : ''}`).join(', ');
        const money = (c) => `$${dollars(c).toFixed(2)}`;
        const est = (x) => (x.estimate ? `; est. patient ${money(x.estimate.total_patient)}` : '');
        if (r.options) return `Treatment options for ${who}:\n${r.options.map((o) => `${o.label}: ${line(o.items)} — ${money(o.total_fee)}${est(o)}`).join('\n')}`;
        const warn = r.warnings?.length ? `\nCheck: ${r.warnings.join('; ')}` : '';
        return `Chart for ${who}: ${line(r.items)} — ${money(r.total_fee)}${est(r)}${warn}`;
      }
      case 'chart_conditions':
        return `Chart for ${who}: ${(i.items || []).map((x) => `#${x.tooth} ${String(x.condition).replace('_', ' ')}${x.surfaces ? ` ${x.surfaces}` : ''}${x.notes ? ` (${x.notes})` : ''}`).join(', ')}`;
      case 'record_perio':
        return `Perio for ${who}: ${(i.teeth || []).map((t) => `#${t.tooth}${t.pd ? ` ${t.pd.map((d) => d ?? '–').join(' ')}` : ''}${t.bop?.some(Boolean) ? ' (bleeding)' : ''}${t.missing ? ' missing' : ''}`).join('; ')}`;
      default:
        return name;
    }
  }

  const stepLabel = (name, input, result) => ({
    find_patient: `Found ${Array.isArray(result) ? result.length : 0} for “${input.query}”`,
    find_open_times: `${result?.open_times?.length || 0} open times for ${result?.provider || 'the provider'}`,
    practice_setup: 'Providers and visit types',
    patient_summary: 'Patient summary',
    patient_appointments: 'Upcoming visits',
    day_schedule: `Schedule for ${input.date}`,
    search_procedure_codes: `Codes for “${input.query}”`,
    patient_treatment: 'Planned treatment',
    note_templates: 'Note templates',
  })[name] || name;

  return { readers, describe, stepLabel, setup, patientName, apptView, names };
}
