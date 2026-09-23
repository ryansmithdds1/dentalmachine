import { insert, practiceNow } from './util.js';
import { aiClient, structured } from './ai.js';
import { sendMessage } from './messaging.js';
import { hoursFor } from './hours.js';
import { openSlots, validateAppt } from './routes/schedule.js';
import { publish } from './events.js';

// The office phone line: who's calling (matched to the patient), the call log, recordings turned into
// transcripts and a short summary, a text back when a call is missed, and an AI receptionist that answers
// when nobody can (after hours, or when the desk doesn't pick up) — books, reschedules or takes a message.
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const pretty = (s) => { const d = digits(s); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(s || ''); };

export async function practiceForNumber(db, to) {
  const all = await db.all('SELECT * FROM practices WHERE voice_number IS NOT NULL OR sms_number IS NOT NULL');
  const hit = all.find((p) => digits(p.voice_number) === digits(to)) || all.find((p) => digits(p.sms_number) === digits(to));
  if (hit) return hit;
  return (await db.get('SELECT COUNT(*) AS n FROM practices')).n === 1 ? db.get('SELECT * FROM practices LIMIT 1') : null;
}

export async function patientForNumber(db, pid, from) {
  const d = digits(from);
  if (d.length < 10) return null;
  const rows = (await db.all("SELECT id, first_name, last_name, dob, phone, guarantor_id FROM patients WHERE practice_id = ? AND status != 'archived' AND phone IS NOT NULL", pid)).filter((p) => digits(p.phone) === d);
  return rows.sort((a, b) => (a.guarantor_id ? 1 : 0) - (b.guarantor_id ? 1 : 0))[0] || null;
}

// What the front desk sees as the phone rings.
export async function callerCard(db, pid, patientId) {
  if (!patientId) return null;
  const p = await db.get('SELECT id, first_name, last_name, preferred_name, dob FROM patients WHERE id = ? AND practice_id = ?', patientId, pid);
  if (!p) return null;
  const now = await practiceNow(db, pid);
  const balance = Number((await db.get('SELECT SUM(amount) AS n FROM ledger_entries WHERE patient_id = ?', p.id))?.n) || 0;
  const next = await db.get("SELECT id, start_time, reason FROM appointments WHERE patient_id = ? AND start_time >= ? AND status IN ('scheduled','confirmed') ORDER BY start_time LIMIT 1", p.id, now);
  const last = await db.get("SELECT start_time FROM appointments WHERE patient_id = ? AND status = 'completed' ORDER BY start_time DESC LIMIT 1", p.id);
  const household = await db.all("SELECT id, first_name FROM patients WHERE practice_id = ? AND guarantor_id = ? AND status != 'archived'", pid, p.id);
  return { ...p, balance, next_visit: next || null, last_visit: last?.start_time || null, household };
}

export function isOpenNow(practice, now) {
  const hhmm = now.slice(11, 16);
  return hoursFor(practice, now.slice(0, 10)).some(([o, c]) => hhmm >= o && hhmm < c);
}

// ---- Missed-call text-back ----
export async function textBack(db, messenger, call, practice, appUrl) {
  if (!practice.missed_call_text || call.texted_back_at || digits(call.from_number).length < 10) return null;
  const booking = practice.slug && practice.online_booking ? ` or book online: ${appUrl}/book/${practice.slug}` : '';
  const body = `Sorry we missed your call to ${practice.name}! Reply here and we'll help${booking}. Reply STOP to opt out.`;
  const msg = await sendMessage(db, messenger, { practiceId: practice.id, patientId: call.patient_id, channel: 'sms', to: pretty(call.from_number), body, kind: 'missed_call' });
  await db.run("UPDATE calls SET texted_back_at = datetime('now') WHERE id = ?", call.id);
  return msg;
}

// ---- Transcripts ----
// TRANSCRIBE=deepgram (with DEEPGRAM_API_KEY) sends the recording to Deepgram; sandbox makes one up.
export function createTranscriber({ config, fetchImpl = globalThis.fetch }) {
  const mode = config.transcribe;
  if (mode === 'sandbox') {
    return { mode, async transcribe() { return 'Caller: Hi, I need to move my cleaning next week.\nOffice: Sure, how about Thursday at 10?\nCaller: That works, thank you.'; } };
  }
  if (mode === 'deepgram' && config.deepgramKey) {
    return {
      mode,
      // Two-channel recordings: the caller on the first channel, the office on the second.
      async transcribe(audio, { contentType = 'audio/mpeg' } = {}) {
        const res = await fetchImpl('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&multichannel=true&utterances=true', {
          method: 'POST', headers: { Authorization: `Token ${config.deepgramKey}`, 'Content-Type': contentType }, body: audio,
        });
        if (!res.ok) throw new Error(`Deepgram error ${res.status}`);
        const data = await res.json();
        const utt = data.results?.utterances || [];
        if (utt.length) return utt.sort((a, b) => a.start - b.start).map((u) => `${u.channel === 0 ? 'Caller' : 'Office'}: ${u.transcript}`).join('\n');
        return (data.results?.channels || []).map((c, i) => `${i === 0 ? 'Caller' : 'Office'}: ${c.alternatives?.[0]?.transcript || ''}`).join('\n');
      },
    };
  }
  return null;
}

const SUMMARY_TOOL = {
  name: 'call_summary',
  description: 'A short summary of a phone call to a dental office.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One or two sentences: who called, what they needed, what was agreed.' },
      reason: { type: 'string', enum: ['appointment', 'reschedule', 'cancel', 'billing', 'insurance', 'emergency', 'new_patient', 'question', 'other'] },
      follow_up: { type: 'boolean', description: 'Whether someone at the office still needs to do something' },
      follow_up_note: { type: 'string', description: 'What needs doing, if anything' },
      urgent: { type: 'boolean', description: 'Pain, swelling, bleeding, trauma or anything that can’t wait' },
    },
    required: ['summary', 'reason', 'follow_up'],
  },
};

export async function summarizeCall(db, config, callId) {
  const call = await db.get('SELECT * FROM calls WHERE id = ?', callId);
  if (!call?.transcript || !aiClient(config)) return null;
  const who = call.patient_id ? await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', call.patient_id) : null;
  const out = await structured(config, {
    system: 'You summarize phone calls to a dental office for the front desk. Be brief and factual.', tool: SUMMARY_TOOL, effort: 'low', maxTokens: 2000,
    content: `Caller: ${who ? `${who.first_name} ${who.last_name} (patient)` : pretty(call.from_number)}\nCall type: ${call.purpose}\n\nTranscript:\n${call.transcript.slice(0, 40_000)}`,
  });
  if (!out.summary) return null;
  await db.run('UPDATE calls SET summary = ?, reason = ?, follow_up = ? WHERE id = ?', out.summary, out.reason || 'other', out.follow_up ? 1 : 0, call.id);
  if (out.follow_up || out.urgent) {
    const now = await practiceNow(db, call.practice_id);
    await insert(db, 'tasks', {
      practice_id: call.practice_id, patient_id: call.patient_id, priority: out.urgent ? 'high' : 'normal', due_date: now.slice(0, 10),
      title: `${out.urgent ? 'URGENT — ' : ''}Call from ${who ? `${who.first_name} ${who.last_name}` : pretty(call.from_number)}: ${out.follow_up_note || out.summary}`.slice(0, 300),
    });
    publish(call.practice_id, { type: 'tasks' });
  }
  publish(call.practice_id, { type: 'call', event: 'summary', call_id: call.id });
  return out;
}

// A recording is fetched from Twilio, kept (encrypted) with the practice's files, transcribed and summarized.
export async function processRecording(db, { storage, transcriber, config, fetchImpl = globalThis.fetch }, callId, recordingUrl) {
  const call = await db.get('SELECT * FROM calls WHERE id = ?', callId);
  if (!call || !recordingUrl) return;
  const sid = config.twilioAccountSid;
  const res = await fetchImpl(`${recordingUrl}.mp3`, { headers: sid ? { Authorization: `Basic ${Buffer.from(`${sid}:${config.twilioAuthToken}`).toString('base64')}` } : {} });
  if (!res.ok) throw new Error(`Recording download failed (${res.status})`);
  const audio = Buffer.from(await res.arrayBuffer());
  const { storageKey, encrypted } = await storage.save(call.practice_id, audio);
  await db.run('UPDATE calls SET recording_key = ?, recording_encrypted = ?, recording_url = NULL WHERE id = ?', storageKey, encrypted ? 1 : 0, call.id);
  if (transcriber) {
    const transcript = await transcriber.transcribe(audio, { contentType: 'audio/mpeg' });
    await db.run('UPDATE calls SET transcript = ? WHERE id = ?', transcript, call.id);
    await summarizeCall(db, config, call.id);
  }
}

// ---- AI receptionist ----
const RECEPTIONIST = `You are the phone receptionist for {practice}, a dental office, speaking with a caller by phone. It is {now} ({weekday}); the office is {open}.
Your words are read aloud: short, warm, plain sentences (one or two at a time), no lists, no markdown, spell out times like "two thirty P M".
You can: find open appointment times and book them, move or cancel the caller's existing visit, and take a message for the team.
{caller}
Rules: confirm the patient's full name (and date of birth for anyone new) before booking. Never give medical advice or prices; for pain, swelling, bleeding or an injury, take an urgent message and tell them the team will call back right away — for anything life-threatening, tell them to call 911.
When the caller is done, say goodbye and call end_call.`;

const RECEPTION_TOOLS = [
  { name: 'open_times', description: 'Open appointment times on a date. Try the next few days if one is full.', input_schema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, minutes: { type: 'integer', description: 'Visit length, default 60' } }, required: ['date'] } },
  {
    name: 'book_visit', description: 'Books a visit at a time open_times returned. For an existing patient it goes straight on the schedule; a new patient’s request is held for the team to confirm.',
    input_schema: { type: 'object', properties: { start: { type: 'string', description: 'YYYY-MM-DD HH:MM exactly as open_times gave it' }, provider_id: { type: 'integer' }, minutes: { type: 'integer' }, reason: { type: 'string' }, first_name: { type: 'string' }, last_name: { type: 'string' }, dob: { type: 'string', description: 'YYYY-MM-DD, for a new patient' }, existing_patient: { type: 'boolean' } }, required: ['start', 'provider_id', 'reason', 'first_name', 'last_name', 'existing_patient'] },
  },
  { name: 'upcoming_visits', description: 'The caller’s upcoming visits (a patient matched by their phone number).', input_schema: { type: 'object', properties: {} } },
  { name: 'change_visit', description: 'Moves one of the caller’s upcoming visits to a new open time, or cancels it.', input_schema: { type: 'object', properties: { appointment_id: { type: 'integer' }, action: { type: 'string', enum: ['move', 'cancel'] }, new_start: { type: 'string' } }, required: ['appointment_id', 'action'] } },
  { name: 'take_message', description: 'Leaves a message for the team.', input_schema: { type: 'object', properties: { name: { type: 'string' }, message: { type: 'string' }, callback_number: { type: 'string' }, urgent: { type: 'boolean' } }, required: ['message'] } },
  { name: 'end_call', description: 'Hangs up after you have said goodbye.', input_schema: { type: 'object', properties: {} } },
];
const addMin = (dt, n) => new Date(Date.parse(`${dt.replace(' ', 'T')}:00Z`) + n * 60000).toISOString().slice(0, 16).replace('T', ' ');

async function receptionTool(db, call, practice, name, input) {
  const pid = practice.id;
  const now = await practiceNow(db, pid);
  const mine = async () => (call.patient_id ? db.all("SELECT id, patient_id, start_time, end_time, reason, provider_id FROM appointments WHERE practice_id = ? AND start_time > ? AND status IN ('scheduled','confirmed') AND (patient_id = ? OR patient_id IN (SELECT id FROM patients WHERE guarantor_id = ?)) ORDER BY start_time LIMIT 6", pid, now, call.patient_id, call.patient_id) : []);
  if (name === 'open_times') {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date : now.slice(0, 10);
    const providers = await db.all('SELECT id, name, type FROM providers WHERE practice_id = ? AND active = 1 ORDER BY id', pid);
    const out = [];
    for (const p of providers) {
      const times = (await openSlots(db, pid, p.id, date, { duration: Math.min(180, Math.max(15, Number(input.minutes) || 60)), step: 30, after: now })).slice(0, 6);
      if (times.length) out.push({ provider_id: p.id, provider: p.name, kind: p.type, times });
    }
    return { date, providers: out };
  }
  if (name === 'upcoming_visits') return { visits: await mine() };
  if (name === 'book_visit') {
    const start = String(input.start || '');
    const minutes = Math.min(180, Math.max(15, Number(input.minutes) || 60));
    if (!(await openSlots(db, pid, Number(input.provider_id), start.slice(0, 10), { duration: minutes, after: now })).includes(start)) return { error: 'That time is no longer open. Check open_times again.' };
    const known = input.existing_patient && call.patient_id ? await db.get('SELECT id, first_name, last_name FROM patients WHERE id = ?', call.patient_id) : null;
    // An existing patient (matched by the number they're calling from) goes straight onto the schedule.
    const family = known ? await db.all('SELECT id, first_name, last_name FROM patients WHERE practice_id = ? AND (id = ? OR guarantor_id = ?)', pid, known.id, known.id) : [];
    const who = family.find((f) => f.first_name.toLowerCase() === String(input.first_name || '').trim().toLowerCase());
    if (who) {
      const row = { patient_id: who.id, provider_id: Number(input.provider_id), operatory_id: null, start_time: start, end_time: addMin(start, minutes), status: 'scheduled', reason: String(input.reason || '').slice(0, 200) || null };
      await validateAppt(db, pid, row);
      const id = await insert(db, 'appointments', { ...row, practice_id: pid, notice_due: 'booked', notes: 'Booked by the AI receptionist' });
      await db.run('UPDATE calls SET outcome = ? WHERE id = ?', 'booked', call.id);
      publish(pid, { type: 'schedule', dates: [start.slice(0, 10)], source: 'phone' });
      return { booked: true, appointment_id: id, patient: `${who.first_name} ${who.last_name}`, start };
    }
    const id = await insert(db, 'booking_requests', {
      practice_id: pid, first_name: String(input.first_name).slice(0, 80), last_name: String(input.last_name).slice(0, 80), dob: /^\d{4}-\d{2}-\d{2}$/.test(input.dob || '') ? input.dob : null,
      phone: pretty(call.from_number), reason: String(input.reason || '').slice(0, 200), provider_id: Number(input.provider_id), requested_start: start, duration: minutes, new_patient: 1, notes: 'Requested by phone (AI receptionist)',
    });
    await db.run('UPDATE calls SET outcome = ? WHERE id = ?', 'requested', call.id);
    publish(pid, { type: 'requests' });
    return { requested: true, request_id: id, note: 'Held for the team to confirm; they will text or call to confirm.' };
  }
  if (name === 'change_visit') {
    const a = (await mine()).find((v) => v.id === Number(input.appointment_id));
    if (!a) return { error: 'That visit isn’t one of the caller’s upcoming visits.' };
    if (input.action === 'cancel') {
      await db.run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", a.id);
      await db.run("UPDATE procedures SET appointment_id = NULL WHERE appointment_id = ? AND status = 'planned'", a.id);
      await db.run('UPDATE calls SET outcome = ? WHERE id = ?', 'cancelled', call.id);
      publish(pid, { type: 'schedule', dates: [a.start_time.slice(0, 10)], source: 'phone' });
      return { cancelled: true };
    }
    const start = String(input.new_start || '');
    const minutes = (Date.parse(`${a.end_time.replace(' ', 'T')}:00Z`) - Date.parse(`${a.start_time.replace(' ', 'T')}:00Z`)) / 60000;
    if (!(await openSlots(db, pid, a.provider_id, start.slice(0, 10), { duration: minutes, after: now })).includes(start)) return { error: 'That time is not open for this provider. Check open_times.' };
    await db.run("UPDATE appointments SET start_time = ?, end_time = ?, operatory_id = NULL, status = 'scheduled', confirmed_at = NULL, reminder_sent_at = NULL, notice_due = 'moved' WHERE id = ?", start, addMin(start, minutes), a.id);
    await db.run('UPDATE calls SET outcome = ? WHERE id = ?', 'rescheduled', call.id);
    publish(pid, { type: 'schedule', dates: [...new Set([a.start_time.slice(0, 10), start.slice(0, 10)])], source: 'phone' });
    return { moved: true, start, note: 'The team will assign a chair.' };
  }
  if (name === 'take_message') {
    await insert(db, 'tasks', {
      practice_id: pid, patient_id: call.patient_id, priority: input.urgent ? 'high' : 'normal', due_date: now.slice(0, 10),
      title: `${input.urgent ? 'URGENT — ' : ''}Phone message from ${input.name || pretty(call.from_number)} (${input.callback_number || pretty(call.from_number)}): ${input.message}`.slice(0, 300),
    });
    await db.run('UPDATE calls SET outcome = ? WHERE id = ?', 'message', call.id);
    publish(pid, { type: 'tasks' });
    return { ok: true };
  }
  return { error: 'Unknown tool' };
}

// One turn of the conversation: the caller said `heard`; returns what to say, and whether to hang up.
export async function receptionistTurn(db, config, callId, heard) {
  const call = await db.get('SELECT * FROM calls WHERE id = ?', callId);
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', call.practice_id);
  const turns = JSON.parse(call.ai_turns || '[]');
  if (heard) turns.push({ role: 'caller', text: String(heard).slice(0, 1000) });
  const ai = aiClient(config);
  if (!ai) return { say: `Sorry, I can't help right now. Please call back during office hours${practice.phone ? ` at ${practice.phone}` : ''}.`, hangup: true };
  const now = await practiceNow(db, practice.id);
  const card = await callerCard(db, practice.id, call.patient_id);
  const system = RECEPTIONIST.replace('{practice}', practice.name).replace('{now}', now).replace('{weekday}', new Date(`${now.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }))
    .replace('{open}', isOpenNow(practice, now) ? 'open now' : 'closed right now')
    .replace('{caller}', card ? `The number calling belongs to patient ${card.first_name} ${card.last_name}${card.household.length ? ` (family: ${card.household.map((h) => h.first_name).join(', ')})` : ''}. Confirm who you're speaking with.` : 'The caller’s number isn’t on file: they may be new.');
  const messages = [];
  for (const t of turns) {
    const role = t.role === 'caller' ? 'user' : 'assistant';
    if (messages.at(-1)?.role === role) messages.at(-1).content += `\n${t.text}`;
    else messages.push({ role, content: t.text });
  }
  if (messages[0]?.role !== 'user') messages.unshift({ role: 'user', content: '(The call connects.)' });
  let say = '';
  let hangup = false;
  for (let i = 0; i < 5 && !hangup; i++) {
    const res = await ai.client.messages.create({ model: ai.cfg.model, max_tokens: 1500, thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, system, tools: RECEPTION_TOOLS, messages });
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    if (text) say = say ? `${say} ${text}` : text;
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (!uses.length || res.stop_reason !== 'tool_use') break;
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const u of uses) {
      if (u.name === 'end_call') { hangup = true; results.push({ type: 'tool_result', tool_use_id: u.id, content: 'ok' }); continue; }
      let out;
      try { out = await receptionTool(db, call, practice, u.name, u.input || {}); } catch (err) { out = { error: err.message }; }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
    if (hangup) break;
  }
  say ||= hangup ? 'Thank you for calling. Goodbye.' : 'Sorry, could you say that again?';
  turns.push({ role: 'ai', text: say });
  await db.run('UPDATE calls SET ai_turns = ?, transcript = ? WHERE id = ?', JSON.stringify(turns), turns.map((t) => `${t.role === 'caller' ? 'Caller' : 'Receptionist'}: ${t.text}`).join('\n'), call.id);
  return { say, hangup };
}
