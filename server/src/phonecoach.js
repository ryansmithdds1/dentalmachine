// Phones: every call saved, linked and coached (PH1-PH7, docs/phones.md, docs/workflows/specs/PH-phones.md).
// The rules shared by the routes (routes/phonecoach.js), the phone webhooks and the background job:
// - protocols (the office's way of handling each kind of call) and the starter set to adapt;
// - small deterministic readers of what was said: the kind of call, an upset caller, why someone didn't book, and
//   what a caller asks for while they talk ("Thursday afternoon with Dr Chen") — used live, in tests and the sandbox;
// - scoring a call against its protocol (the AI adapter in ai/callscore.js does the reading), coaching only;
// - the numbers: answer rate and speed, missed and abandoned calls (attributed to whoever was on shift to answer),
//   new-patient calls that booked, scores, reasons for not booking, callbacks;
// - alerts (upset caller, a day over the missed-call target) that reach the owner and office manager at once and
//   stay in Needs attention until someone acknowledges them.
import { HttpError, PERMISSION_CATALOG, can } from './auth.js';
import { insert, audit, localNow, practiceNow, utcRange, normalizeDateTime } from './util.js';
import { withActor } from './actor.js';
import { raiseIssue, resolveIssue, failed } from './issues.js';
import { publish } from './events.js';
import { announce } from './chat.js';
import { sendMessage } from './messaging.js';
import { utcToLocal } from './timeclock.js';
import { openSlots, validateAppt, linkRecalls, addMinutes, INACTIVE } from './routes/schedule.js';
import { recallTypes } from './recalls.js';
import { typeDuration } from './patterns.js';
import { stopForBooking } from './cadence.js';

// Seeing other people's call scores and coaching them is a manager's job. The permission is registered here so
// Settings → Roles can give it (see the report: it belongs in auth.js's PERMISSION_CATALOG).
export const COACH = 'phones:coach';
PERMISSION_CATALOG[COACH] ??= 'Phones: see everyone’s call scores and missed calls, coach and rate calls, edit phone protocols';
export const canCoach = (user) => can(user, COACH);

export const CALL_TYPES = ['general', 'new_patient', 'emergency', 'scheduling', 'billing'];
export const CALL_TYPE_LABELS = { general: 'General', new_patient: 'New patient', emergency: 'Emergency', scheduling: 'Scheduling', billing: 'Billing' };
export const NO_BOOK_REASONS = { cost: 'Cost', time: 'No time that works', insurance: 'Insurance', shopping: 'Just shopping around', think: 'Wants to think about it', other: 'Other' };
// Calls that count as missed at the desk (it rang and nobody picked up, or the caller gave up while it rang).
export const DESK_MISSED = ['missed', 'abandoned'];

const s = (key, label, weight, required, hints) => ({ key, label, weight, required, hints });
const TIME = '/\\b(at|for|by)\\s+\\d{1,2}(:\\d{2})?\\s*(am|pm|a\\.m\\.|p\\.m\\.|o.clock)?\\b/';
// Starter protocols, written to be adapted. Hints are what the sandbox listens for (and help the AI): plain words
// the office says, or /a pattern/.
export const STARTER_PROTOCOLS = {
  general: {
    name: 'Every call', philosophy: 'Warm, unhurried and helpful. Every caller hears who we are, is called by name, and leaves with a clear next step.',
    steps: [
      s('greeting', 'Warm greeting with the office name', 2, true, ['thank you for calling', 'thanks for calling', 'good morning', 'good afternoon']),
      s('own_name', 'Says their own name', 1, true, ['this is', 'my name is', 'speaking']),
      s('caller_name', 'Asks for and uses the caller’s name', 1, false, ['who am i speaking', 'may i have your name', 'can i get your name', 'your name']),
      s('help', 'Asks how they can help', 1, false, ['how can i help', 'how may i help', 'what can i do for you']),
      s('offer', 'Offers an appointment', 2, true, ['would you like to', 'can i schedule', 'get you in', 'we have an opening', 'how about', 'i can book']),
      s('close_time', 'Closes with a day and time', 2, true, [TIME]),
      s('thanks', 'Thanks the caller', 1, false, ['thank you', 'have a great', 'see you']),
    ],
  },
  new_patient: {
    name: 'New patient', philosophy: 'A new patient is choosing us. Make them feel welcome, learn why they called, and book them before the call ends.',
    steps: [
      s('greeting', 'Warm greeting with the office name', 2, true, ['thank you for calling', 'thanks for calling', 'good morning', 'good afternoon']),
      s('own_name', 'Says their own name', 1, true, ['this is', 'my name is']),
      s('welcome', 'Welcomes them as a new patient', 1, false, ['welcome', 'glad you called', 'happy to have you']),
      s('reason', 'Asks what brings them in', 2, true, ['what brings you', 'reason for', 'what can we help', 'any concerns', 'is anything bothering']),
      s('how_heard', 'Asks how they heard about us', 1, false, ['how did you hear', 'who referred', 'how did you find']),
      s('insurance', 'Asks about insurance', 1, false, ['insurance', 'dental plan', 'coverage']),
      s('offer', 'Offers an appointment', 2, true, ['would you like to', 'get you in', 'we have an opening', 'how about', 'i can book']),
      s('close_time', 'Closes with a day and time', 3, true, [TIME]),
      s('referrals', 'Invites referrals of family and friends', 1, false, ['refer', 'family and friends', 'friends and family']),
    ],
  },
  emergency: {
    name: 'Emergency', philosophy: 'Someone in pain is seen today when we can. Listen, ask the few questions that matter, and give them a time.',
    steps: [
      s('greeting', 'Greeting with the office name', 1, true, ['thank you for calling', 'thanks for calling', 'good morning', 'good afternoon']),
      s('empathy', 'Shows they care', 2, true, ['sorry', 'that sounds', 'we will take care', 'we’ll take care', "we'll take care"]),
      s('triage', 'Asks about pain, swelling or bleeding', 2, true, ['pain', 'swelling', 'bleeding', 'how long', 'scale of']),
      s('same_day', 'Offers to see them today or soonest', 2, true, ['today', 'this afternoon', 'right away', 'as soon as', 'first thing']),
      s('close_time', 'Gives a time to come in', 2, true, [TIME]),
      s('safety', 'Says when to go to the ER or call 911', 1, false, ['911', 'emergency room', ' er ']),
    ],
  },
  scheduling: {
    name: 'Scheduling and changes', philosophy: 'Keep every patient on the schedule: offer two choices, confirm, and never end a call with a cancellation and no new time.',
    steps: [
      s('greeting', 'Greeting with the office name', 1, true, ['thank you for calling', 'thanks for calling', 'good morning', 'good afternoon']),
      s('verify', 'Confirms who the patient is', 1, true, ['date of birth', 'birthday', 'confirm your', 'spell your']),
      s('two_choices', 'Offers two choices', 2, false, ['or would', 'morning or afternoon', 'which works better', 'or the']),
      s('close_time', 'Confirms the new day and time', 3, true, [TIME]),
      s('reminder', 'Mentions the reminder or confirmation', 1, false, ['reminder', 'text you', 'confirmation']),
    ],
  },
  billing: {
    name: 'Billing and insurance', philosophy: 'Clear, kind and accurate about money. Explain, offer a way to pay, and check they have their next visit.',
    steps: [
      s('greeting', 'Greeting with the office name', 1, true, ['thank you for calling', 'thanks for calling', 'good morning', 'good afternoon']),
      s('verify', 'Confirms who the patient is', 2, true, ['date of birth', 'birthday', 'confirm your']),
      s('explain', 'Explains the balance or statement', 2, true, ['balance', 'statement', 'insurance paid', 'your portion', 'you owe']),
      s('pay_option', 'Offers a way to pay', 2, false, ['pay', 'payment plan', 'card on file', 'financing']),
      s('next_visit', 'Checks their next visit', 1, false, ['due for', 'next appointment', 'schedule your', 'cleaning']),
      s('thanks', 'Thanks the caller', 1, false, ['thank you', 'have a great']),
    ],
  },
};

// ---- Protocols ----
export function cleanSteps(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 20) throw new HttpError(400, 'A protocol needs 1 to 20 steps');
  const keys = new Set();
  return steps.map((st, i) => {
    const label = String(st?.label || '').trim().slice(0, 120);
    if (!label) throw new HttpError(400, `Step ${i + 1} needs a description`);
    const key = String(st.key || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `step_${i + 1}`;
    if (keys.has(key)) throw new HttpError(400, `Two steps are both called “${key}”`);
    keys.add(key);
    const weight = Number(st.weight ?? 1);
    if (!Number.isInteger(weight) || weight < 1 || weight > 5) throw new HttpError(400, `Step ${i + 1}: weight must be 1 to 5`);
    const hints = (Array.isArray(st.hints) ? st.hints : String(st.hints || '').split('\n')).map((h) => String(h).trim().slice(0, 120)).filter(Boolean).slice(0, 12);
    for (const h of hints) if (/^\/.+\/$/.test(h)) { try { new RegExp(h.slice(1, -1), 'i'); } catch { throw new HttpError(400, `Step ${i + 1}: “${h}” isn’t a valid pattern`); } }
    return { key, label, weight, required: !!st.required, hints };
  });
}

// The starter protocols, once per practice (the partial unique index keeps one active per call type).
export async function ensureProtocols(db, practiceId) {
  const have = new Set((await db.all("SELECT call_type FROM phone_protocols WHERE practice_id = ? AND status = 'active'", practiceId)).map((r) => r.call_type));
  for (const type of CALL_TYPES) {
    if (have.has(type)) continue;
    const p = STARTER_PROTOCOLS[type];
    try {
      await db.run('INSERT INTO phone_protocols (practice_id, call_type, name, philosophy, steps) VALUES (?, ?, ?, ?, ?)', practiceId, type, p.name, p.philosophy, JSON.stringify(p.steps));
    } catch (err) {
      if (!/unique|duplicate/i.test(String(err.message))) throw err; // made at the same moment by another request
    }
  }
}

export async function protocolFor(db, practiceId, callType) {
  await ensureProtocols(db, practiceId);
  return (await db.get("SELECT * FROM phone_protocols WHERE practice_id = ? AND call_type = ? AND status = 'active'", practiceId, callType))
    || db.get("SELECT * FROM phone_protocols WHERE practice_id = ? AND call_type = 'general' AND status = 'active'", practiceId);
}

// ---- Phone settings ----
const ids = (v) => { try { return (JSON.parse(v || '[]') || []).map(Number).filter(Number.isInteger); } catch { return []; } };
export const DEFAULT_DISCLOSURE = 'This call may be recorded for quality and training.';
export async function phoneSettings(db, practiceId) {
  const row = await db.get('SELECT * FROM phone_settings WHERE practice_id = ?', practiceId);
  return {
    recording_disclosure: row?.recording_disclosure || null, answerer_ids: ids(row?.answerer_ids), alert_user_ids: ids(row?.alert_user_ids),
    alert_sms_to: (() => { try { return JSON.parse(row?.alert_sms_to || '[]'); } catch { return []; } })(),
    missed_target_pct: row?.missed_target_pct ?? 15, missed_min_calls: row?.missed_min_calls ?? 10,
    live_transcription: !!row?.live_transcription, scoring: row ? !!row.scoring : true, updated_at: row?.updated_at || null,
  };
}

// ---- Reading a transcript ----
// Transcripts are "Caller: …" / "Office: …" lines (the recording's two channels); anything else counts as either.
export function linesOf(transcript) {
  return String(transcript || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^(caller|patient|office|staff|receptionist|agent)(?:\s*\([^)]*\))?\s*:\s*(.*)$/i.exec(l);
    if (!m) return { who: 'any', text: l };
    return { who: /^(caller|patient)$/i.test(m[1]) ? 'caller' : 'office', text: m[2] };
  });
}
const sentences = (text) => (String(text).match(/[^.!?]+[.!?]*/g) || []).map((x) => x.trim()).filter(Boolean);
const hintMatch = (hint, text) => {
  if (/^\/.+\/$/.test(hint)) { try { return new RegExp(hint.slice(1, -1), 'i').test(text); } catch { return false; } }
  return ` ${text.toLowerCase().replace(/[’]/g, "'")} `.includes(hint.toLowerCase().replace(/[’]/g, "'"));
};
// A quote counts as evidence only if it's really in the transcript (whitespace and case aside).
const squash = (x) => String(x || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
export const inTranscript = (quote, transcript) => !!squash(quote) && squash(quote).length >= 3 && squash(transcript).includes(squash(quote));

const TYPE_WORDS = [
  ['emergency', ['emergency', 'toothache', 'tooth ache', 'in pain', 'a lot of pain', 'really hurts', 'swelling', 'swollen', 'broke my tooth', 'broken tooth', 'chipped', 'bleeding', 'abscess', 'knocked out']],
  ['new_patient', ['new patient', 'first time', 'never been', 'looking for a dentist', 'looking for a new dentist', 'accepting new', 'just moved', 'take new patients']],
  ['billing', ['bill', 'balance', 'statement', 'invoice', 'charged', 'charge on my', 'payment', 'refund', 'claim', 'eob']],
  ['scheduling', ['reschedule', 'cancel', 'move my', 'change my appointment', 'appointment', 'cleaning', 'book', 'schedule', 'check-up', 'checkup']],
];
export function detectCallType(transcript, { newCaller = false } = {}) {
  const said = linesOf(transcript).filter((l) => l.who !== 'office').map((l) => l.text.toLowerCase()).join(' ');
  for (const [type, words] of TYPE_WORDS) if (words.some((w) => said.includes(w))) return type === 'scheduling' && newCaller ? 'new_patient' : type;
  return newCaller ? 'new_patient' : 'general';
}

// Upset callers: a short lexicon (strong words count double). Deterministic, so it works on live phrases.
const STRONG = ['ridiculous', 'unacceptable', 'furious', 'never coming back', 'never come back', 'speak to the manager', 'speak to a manager', 'talk to the manager', 'talk to a manager', 'speak to the owner', 'lawyer', 'sue you', 'worst', 'disgusting', 'how dare', 'fed up', 'sick of this', 'rip off', 'rip-off', 'scam', 'incompetent'];
const MILD = ['upset', 'angry', 'frustrated', 'frustrating', 'annoyed', 'terrible', 'horrible', 'awful', 'not happy', 'unhappy', 'complain', 'complaint', 'overcharged', 'mad', 'rude', 'waited forever', 'nobody called me back', 'no one called me back', 'third time'];
export function detectUpset(text) {
  let best = null;
  let total = 0;
  const callerText = linesOf(text).filter((l) => l.who !== 'office').map((l) => l.text).join(' ');
  for (const sent of sentences(callerText)) {
    const low = sent.toLowerCase().replace(/[’]/g, "'");
    let n = STRONG.filter((w) => low.includes(w)).length * 2 + MILD.filter((w) => low.includes(w)).length;
    if (/!{2,}/.test(sent) || (sent.replace(/[^A-Za-z]/g, '').length >= 8 && sent === sent.toUpperCase())) n += 1;
    total += n;
    if (n && (!best || n > best.n)) best = { n, quote: sent.slice(0, 300) };
  }
  return { upset: total >= 2, score: total, quote: best?.quote || null };
}

// Why a caller didn't book, from their own words (the AI suggestion's sandbox; staff confirm it with one click).
const REASON_WORDS = {
  cost: ['expensive', 'how much', 'cost', 'price', 'afford', 'too much', 'out of pocket', 'cheaper'],
  insurance: ['insurance', 'in network', 'in-network', 'out of network', 'coverage', 'accept my', 'take my plan', 'my plan'],
  time: ['no time', "doesn't work", 'does not work', 'too far out', 'nothing sooner', 'only available', 'my work schedule', "can't make", 'cannot make', 'busy that'],
  shopping: ['shopping around', 'calling around', 'other offices', 'compare', 'just checking prices', 'just checking'],
  think: ['think about it', 'get back to you', 'talk to my husband', 'talk to my wife', 'check with my', 'call back later', "i'll call back", 'let me check'],
};
export function suggestNoBookReason(transcript) {
  let best = null;
  const said = linesOf(transcript).filter((l) => l.who !== 'office').map((l) => l.text);
  for (const [reason, words] of Object.entries(REASON_WORDS)) {
    for (const line of said) {
      for (const sent of sentences(line)) {
        const low = sent.toLowerCase().replace(/[’]/g, "'");
        const n = words.filter((w) => low.includes(w)).length;
        if (n && (!best || n > best.n)) best = { reason, quote: sent.slice(0, 300), n };
      }
    }
  }
  return best ? { reason: best.reason, quote: best.quote } : { reason: null, quote: null };
}

// ---- Scoring (PH3) ----
// Weighted share of the steps met, 0-100. A step counts only with a quote that's really in the transcript.
export function scoreSteps(steps, results, transcript) {
  const byKey = new Map((results || []).map((r) => [r.key, r]));
  const out = steps.map((st) => {
    const r = byKey.get(st.key) || {};
    const quote = r.quote && inTranscript(r.quote, transcript) ? String(r.quote).slice(0, 400) : null;
    return { key: st.key, label: st.label, weight: st.weight, required: !!st.required, met: !!(r.met && quote), quote, note: r.note ? String(r.note).slice(0, 300) : (r.met && !quote ? 'The AI’s quote wasn’t found in the transcript, so this step isn’t counted.' : null) };
  });
  const total = out.reduce((n, x) => n + x.weight, 0);
  const got = out.filter((x) => x.met).reduce((n, x) => n + x.weight, 0);
  return { steps: out, score: total ? Math.round((100 * got) / total) : 0, missed_required: out.filter((x) => x.required && !x.met).map((x) => x.key) };
}

// The sandbox's own reading: for each step, the first thing the office said that matches one of its hints.
export function sandboxStepResults(steps, transcript) {
  const lines = linesOf(transcript);
  const office = lines.filter((l) => l.who !== 'caller');
  return steps.map((st) => {
    for (const l of office) {
      for (const sent of sentences(l.text)) if ((st.hints || []).some((h) => hintMatch(h, sent))) return { key: st.key, met: true, quote: sent };
    }
    return { key: st.key, met: false, quote: null };
  });
}

// Was a visit booked on (or right after) this call?
export async function wasBooked(db, call) {
  if (call.appointment_id || ['booked', 'requested', 'rescheduled', 'confirmed'].includes(call.outcome)) return true;
  if (!call.patient_id) return false;
  const until = new Date(Date.parse(`${String(call.created_at).replace(' ', 'T')}Z`) + 2 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  return !!(await db.get(`SELECT id FROM appointments WHERE patient_id = ? AND created_at >= ? AND created_at <= ? AND status NOT IN ${INACTIVE} LIMIT 1`, call.patient_id, call.created_at, until));
}

// Scores one call (after its recording is transcribed, or when asked again), suggests why it didn't book, and
// watches for an upset caller. Runs as the AI; a failure becomes a Needs attention item.
export async function reviewCall(db, { scorer, messenger, config = {} }, callId, { force = false } = {}) {
  const call = await db.get('SELECT * FROM calls WHERE id = ?', callId);
  if (!call?.transcript) return null;
  const settings = await phoneSettings(db, call.practice_id);
  return withActor({ source: 'ai', actor: 'AI call coach', userId: null, practiceId: call.practice_id }, async () => {
    const out = { call_id: call.id };
    const heard = detectUpset(call.transcript);
    // The upset check needs no AI: it runs on every transcript.
    if (heard.upset) out.alert = await raiseUpsetAlert(db, { messenger, config }, { call, quote: heard.quote, source: 'transcript' });
    if (!scorer || !settings.scoring) return out;
    if (!force && await db.get("SELECT id FROM call_scores WHERE call_id = ? AND status = 'current'", call.id)) return out;
    // The AI receptionist's own calls aren't coached (it isn't a person); voicemails have nobody to score.
    const scorable = call.direction === 'inbound' && call.purpose !== 'receptionist' && call.outcome !== 'voicemail';
    try {
      const guess = call.call_type || detectCallType(call.transcript, { newCaller: !!call.new_caller });
      const protocol = await protocolFor(db, call.practice_id, guess);
      const steps = JSON.parse(protocol.steps);
      const read = await scorer.score({ transcript: call.transcript, callType: guess, steps, philosophy: protocol.philosophy });
      const callType = CALL_TYPES.includes(read.call_type) ? read.call_type : guess;
      const used = callType === protocol.call_type ? protocol : await protocolFor(db, call.practice_id, callType);
      const usedSteps = used.id === protocol.id ? steps : JSON.parse(used.steps);
      const results = used.id === protocol.id ? read.steps : (await scorer.score({ transcript: call.transcript, callType, steps: usedSteps, philosophy: used.philosophy })).steps;
      if (!call.call_type) await db.run('UPDATE calls SET call_type = ? WHERE id = ?', callType, call.id);
      if (scorable) {
        const scored = scoreSteps(usedSteps, results, call.transcript);
        await db.tx(async () => {
          await db.run("UPDATE call_scores SET status = 'superseded' WHERE call_id = ? AND status = 'current'", call.id);
          await insert(db, 'call_scores', {
            practice_id: call.practice_id, call_id: call.id, protocol_id: used.id, protocol_version: used.version, call_type: callType, score: scored.score,
            steps: JSON.stringify(scored.steps), summary: read.summary ? String(read.summary).slice(0, 600) : null, model: scorer.label || scorer.mode, source: 'ai',
          });
        });
        out.score = scored.score;
      }
      // Why they didn't book: the AI's suggestion (quote checked), for a person to confirm. Billing calls aren't about booking.
      if (call.direction === 'inbound' && callType !== 'billing' && !(await wasBooked(db, call))) {
        const quoteOk = read.no_book?.quote && inTranscript(read.no_book.quote, call.transcript);
        const sug = read.no_book?.reason && NO_BOOK_REASONS[read.no_book.reason] ? { reason: read.no_book.reason, quote: quoteOk ? read.no_book.quote : null } : suggestNoBookReason(call.transcript);
        await db.run(
          `INSERT INTO call_no_book (practice_id, call_id, patient_id, suggested_reason, suggested_quote, suggested_by) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (call_id) DO UPDATE SET suggested_reason = excluded.suggested_reason, suggested_quote = excluded.suggested_quote, suggested_by = excluded.suggested_by`,
          call.practice_id, call.id, call.patient_id, sug.reason, sug.quote ? String(sug.quote).slice(0, 400) : null, scorer.label || scorer.mode,
        );
        out.no_book = sug.reason || 'unknown';
      }
      // The AI's own read of the caller's mood (quote checked) can raise the alert the lexicon missed.
      if (!heard.upset && read.upset?.upset && read.upset.quote && inTranscript(read.upset.quote, call.transcript)) {
        out.alert = await raiseUpsetAlert(db, { messenger, config }, { call, quote: read.upset.quote, source: 'ai' });
      }
      await resolveIssue(db, call.practice_id, `call-score:${call.id}`);
      publish(call.practice_id, { type: 'call', event: 'scored', call_id: call.id });
      return out;
    } catch (err) {
      await raiseIssue(db, { practiceId: call.practice_id, kind: 'ai', key: `call-score:${call.id}`, role: 'admin', entity: 'calls', entityId: call.id, title: 'A call couldn’t be scored against its protocol — try again from the call', detail: err.message });
      return { ...out, error: err.message };
    }
  });
}

// ---- Alerts (PH5, PH7) ----
const nameOf = (p) => (p ? `${p.preferred_name || p.first_name} ${p.last_name}` : null);
const pretty = (n) => { const d = String(n || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(n || 'unknown number'); };

// Who hears about alerts: the people named in phone settings, else the practice's administrators (owner, office manager).
export async function alertRecipients(db, practiceId) {
  const st = await phoneSettings(db, practiceId);
  const list = st.alert_user_ids.length
    ? await db.all(`SELECT id, name FROM users WHERE practice_id = ? AND active = 1 AND id IN (${st.alert_user_ids.map(() => '?').join(',')})`, practiceId, ...st.alert_user_ids)
    : await db.all("SELECT id, name FROM users WHERE practice_id = ? AND active = 1 AND role = 'admin' ORDER BY id", practiceId);
  return { users: list, sms: st.alert_sms_to };
}

// The private "Phone alerts" conversation for those people (a group chat; members kept in step with settings).
async function alertChannel(db, practiceId, userIds) {
  await db.run("INSERT INTO chat_channels (practice_id, kind, name, topic, dm_key) VALUES (?, 'group', 'Phone alerts', 'Upset callers and missed-call days', 'phone-alerts') ON CONFLICT (practice_id, dm_key) DO NOTHING", practiceId);
  const c = await db.get("SELECT * FROM chat_channels WHERE practice_id = ? AND dm_key = 'phone-alerts'", practiceId);
  for (const id of userIds) {
    await db.run('INSERT INTO chat_members (practice_id, channel_id, user_id, last_read_id) VALUES (?, ?, ?, 0) ON CONFLICT (channel_id, user_id) DO NOTHING', practiceId, c.id, id);
    await db.run('UPDATE chat_members SET left_at = NULL WHERE channel_id = ? AND user_id = ? AND left_at IS NOT NULL', c.id, id);
  }
  return c;
}

// Tells the owner and office manager at once: a live event to their screens, a message in their Phone alerts chat
// (with the patient and a link to listen), and a text with no patient details if the office set one up.
async function notify(db, messenger, practiceId, alert, { chatBody, patientId, smsBody }) {
  const { users, sms } = await alertRecipients(db, practiceId);
  const told = { users: users.map((u) => u.id), chat: null, sms: [] };
  publish(practiceId, { type: 'phone_alert', alert_id: alert.id, kind: alert.kind, call_id: alert.call_id ?? null, to: told.users });
  try {
    if (users.length) {
      const c = await alertChannel(db, practiceId, users.map((u) => u.id));
      const { id } = await db.run(
        "INSERT INTO chat_messages (practice_id, channel_id, user_id, source, kind, body, patient_id, urgent) VALUES (?, ?, NULL, 'automation', 'system', ?, ?, 1)",
        practiceId, c.id, chatBody.slice(0, 3900), patientId ?? null,
      );
      told.chat = id;
      await announce(db, c, { event: 'message', message_id: id, parent_id: null, mentions: told.users, urgent: true, by: null });
    }
  } catch (err) {
    await raiseIssue(db, { practiceId, kind: 'phones', key: `phone-alert-chat:${alert.id}`, role: 'admin', title: 'A phone alert couldn’t be posted to team chat', detail: err.message });
  }
  if (messenger) {
    for (const to of sms) {
      const m = await sendMessage(db, messenger, { practiceId, channel: 'sms', to, body: smsBody, kind: 'staff_alert' });
      told.sms.push({ to: String(to).slice(-4), status: m.status });
    }
  }
  await db.run('UPDATE phone_alerts SET notified = ? WHERE id = ?', JSON.stringify(told), alert.id);
  return told;
}

// An upset caller: one alert per call, open until someone acknowledges it.
export async function raiseUpsetAlert(db, { messenger } = {}, { call, quote, source = 'transcript' }) {
  const key = `upset:${call.id}`;
  const had = await db.get('SELECT * FROM phone_alerts WHERE practice_id = ? AND dedupe_key = ?', call.practice_id, key);
  if (had) return had;
  const patient = call.patient_id ? await db.get('SELECT id, first_name, last_name, preferred_name FROM patients WHERE id = ?', call.patient_id) : null;
  const who = nameOf(patient) || pretty(call.from_number);
  try {
    await db.run('INSERT INTO phone_alerts (practice_id, kind, dedupe_key, call_id, patient_id, quote, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
      call.practice_id, 'upset', key, call.id, patient?.id ?? null, quote ? String(quote).slice(0, 400) : null, source);
  } catch (err) {
    if (/unique|duplicate/i.test(String(err.message))) return db.get('SELECT * FROM phone_alerts WHERE practice_id = ? AND dedupe_key = ?', call.practice_id, key);
    throw err;
  }
  const alert = await db.get('SELECT * FROM phone_alerts WHERE practice_id = ? AND dedupe_key = ?', call.practice_id, key);
  await raiseIssue(db, {
    practiceId: call.practice_id, kind: 'phones', key: `phone-alert:${alert.id}`, severity: 'high', role: 'admin', entity: 'calls', entityId: call.id, patientId: patient?.id ?? null,
    title: `Upset caller: ${who} — listen and follow up`, detail: quote ? `They said: “${quote}”` : null,
  });
  await notify(db, messenger, call.practice_id, alert, {
    patientId: patient?.id,
    chatBody: `Upset caller: ${who}${quote ? ` — “${quote}”` : ''}. ${source === 'live' ? 'Heard during the call.' : 'From the call’s transcript.'} Listen: /calls?open=${call.id}`,
    smsBody: 'Dental Machine: an upset caller needs your attention. Open Calls → Alerts in the app. Reply STOP to opt out.',
  });
  return db.get('SELECT * FROM phone_alerts WHERE id = ?', alert.id);
}

export async function acknowledgeAlert(db, req, alertId, note) {
  const a = await db.get('SELECT * FROM phone_alerts WHERE id = ? AND practice_id = ?', Number(alertId), req.user.practice_id);
  if (!a) throw new HttpError(404, 'Alert not found');
  if (a.status === 'acknowledged') return a;
  const text = String(note || '').trim().slice(0, 500) || null;
  await db.run("UPDATE phone_alerts SET status = 'acknowledged', ack_by = ?, ack_at = ?, ack_note = ? WHERE id = ? AND status = 'open'", req.user.id, new Date().toISOString(), text, a.id);
  await resolveIssue(db, a.practice_id, `phone-alert:${a.id}`, `Acknowledged by ${req.user.name}${text ? `: ${text}` : ''}`);
  await audit(db, req, 'phone_alert.acknowledge', 'phone_alerts', a.id, { kind: a.kind, call_id: a.call_id, patient_id: a.patient_id }, { before: { status: 'open' }, after: { status: 'acknowledged', ack_note: text }, patientId: a.patient_id });
  publish(a.practice_id, { type: 'phone_alert', alert_id: a.id, event: 'acknowledged' });
  return db.get('SELECT * FROM phone_alerts WHERE id = ?', a.id);
}

// ---- What a caller asks for, as they say it (PH6) ----
const DAYS = [['sunday', 'sun'], ['monday', 'mon'], ['tuesday', 'tue', 'tues'], ['wednesday', 'wed'], ['thursday', 'thu', 'thur', 'thurs'], ['friday', 'fri'], ['saturday', 'sat']];
export const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const surname = (name) => String(name).replace(/,.*$/, '').replace(/^(dr|doctor|mr|mrs|ms|miss)\.?\s+/i, '').trim().split(/\s+/).pop().toLowerCase();
const firstOf = (name) => String(name).replace(/,.*$/, '').replace(/^(dr|doctor|mr|mrs|ms|miss)\.?\s+/i, '').trim().split(/\s+/)[0].toLowerCase();
const hour24 = (h, ap) => { let n = Number(h); if (/p/.test(ap || '') && n < 12) n += 12; if (/a/.test(ap || '') && n === 12) n = 0; if (!ap && n >= 1 && n <= 6) n += 12; return n; };

// A small deterministic parser: days ("Thursday", "tomorrow", "next week"), part of the day ("morning",
// "afternoon", "after 3"), a provider by name ("with Dr Chen", "Sarah") and "as soon as possible". Nothing found
// → an empty request. `today` is the practice's date; providers [{id, name}].
export function parseRequest(text, { today, providers = [] } = {}) {
  const t = ` ${String(text || '').toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9:' ]+/g, ' ').replace(/\s+/g, ' ')} `;
  const req = { weekdays: [], date_from: null, date_to: null, part: null, after: null, before: null, provider_ids: [], asap: false, heard: [] };
  DAYS.forEach((names, i) => {
    const hit = names.find((n) => new RegExp(` ${n}s? `).test(t));
    if (hit) { req.weekdays.push(i); req.heard.push(names[0]); }
  });
  if (today) {
    if (/ tomorrow /.test(t)) { req.date_from = req.date_to = addDays(today, 1); req.heard.push('tomorrow'); }
    else if (/ today | this afternoon | this morning /.test(t)) { req.date_from = req.date_to = today; req.heard.push('today'); }
    if (/ next week /.test(t)) {
      const monday = addDays(today, ((8 - weekdayOf(today)) % 7) || 7);
      req.date_from = monday; req.date_to = addDays(monday, 6); req.heard.push('next week');
    } else if (/ this week /.test(t)) {
      req.date_from = today; req.date_to = addDays(today, 6 - weekdayOf(today)); req.heard.push('this week');
    }
    if (/ (in )?(a|two|2|three|3) weeks? /.test(t) && / in (a|two|2|three|3) weeks? /.test(t)) {
      const n = /in (two|2) weeks/.test(t) ? 2 : /in (three|3) weeks/.test(t) ? 3 : 1;
      req.date_from = addDays(today, 7 * n - 3); req.date_to = addDays(today, 7 * n + 3); req.heard.push(`in ${n} week${n > 1 ? 's' : ''}`);
    }
  }
  if (/ (morning|mornings|am|a m|early) /.test(t) || / before (noon|lunch) /.test(t)) { req.part = 'am'; req.heard.push('morning'); }
  if (/ (afternoon|afternoons|pm|p m|after lunch|evening|late in the day|end of the day) /.test(t)) { req.part = req.part === 'am' ? null : 'pm'; req.heard.push('afternoon'); }
  const after = / after (\d{1,2})(?::(\d{2}))? ?(am|pm|a m|p m)? /.exec(t);
  if (after) { req.after = `${String(hour24(after[1], after[3])).padStart(2, '0')}:${after[2] || '00'}`; req.heard.push(`after ${after[1]}${after[3] ? ` ${after[3]}` : ''}`); }
  const before = / before (\d{1,2})(?::(\d{2}))? ?(am|pm|a m|p m)? /.exec(t);
  if (before) { req.before = `${String(hour24(before[1], before[3])).padStart(2, '0')}:${before[2] || '00'}`; req.heard.push(`before ${before[1]}${before[3] ? ` ${before[3]}` : ''}`); }
  if (/ (asap|as soon as possible|as soon as you can|soonest|earliest|first available|next available|right away) /.test(t)) { req.asap = true; req.heard.push('as soon as possible'); }
  for (const p of providers) {
    const last = surname(p.name);
    const first = firstOf(p.name);
    const byTitle = last.length >= 2 && new RegExp(` (dr|doctor|with) ${last} `).test(t);
    const byName = (last.length >= 4 && t.includes(` ${last} `)) || (first.length >= 3 && first !== last && new RegExp(` (with|see|seeing) ${first} `).test(t));
    if (byTitle || byName) { req.provider_ids.push(p.id); req.heard.push(p.name); }
  }
  return req;
}
export const emptyRequest = (r) => !r || (!r.weekdays?.length && !r.date_from && !r.part && !r.after && !r.before && !r.provider_ids?.length && !r.asap);

// Open times that fit the request. Slots: [{ start: 'YYYY-MM-DD HH:MM', provider_id }], soonest first.
export function filterSlots(slots, r) {
  if (emptyRequest(r)) return slots;
  const out = slots.filter((x) => {
    const date = x.start.slice(0, 10);
    const hm = x.start.slice(11, 16);
    if (r.weekdays?.length && !r.weekdays.includes(weekdayOf(date))) return false;
    if (r.date_from && date < r.date_from) return false;
    if (r.date_to && date > r.date_to) return false;
    if (r.part === 'am' && hm >= '12:00') return false;
    if (r.part === 'pm' && hm < '12:00') return false;
    if (r.after && hm < r.after) return false;
    if (r.before && hm >= r.before) return false;
    if (r.provider_ids?.length && !r.provider_ids.includes(x.provider_id)) return false;
    return true;
  }).sort((a, b) => a.start.localeCompare(b.start) || a.provider_id - b.provider_id);
  return out;
}

// ---- Next openings for what the caller likely needs (PH6) ----
export async function likelyNeed(db, pid, { patient, call }) {
  const today = (await practiceNow(db, pid)).slice(0, 10);
  const dentistType = { provider_type: 'dentist' };
  if (call?.call_type === 'emergency') return { kind: 'emergency', label: 'Emergency visit', duration: 30, ...dentistType };
  if (!patient) return { kind: 'new_patient', label: 'New patient exam', duration: 60, ...dentistType };
  const planned = await db.all(
    "SELECT p.code, pc.description FROM procedures p LEFT JOIN procedure_codes pc ON pc.id = p.code_id WHERE p.practice_id = ? AND p.patient_id = ? AND p.status = 'planned' AND p.appointment_id IS NULL ORDER BY p.id LIMIT 6", pid, patient.id,
  );
  const recall = await db.get("SELECT type, due_date FROM recalls WHERE practice_id = ? AND patient_id = ? AND status IN ('due','contacted') AND due_date <= ? ORDER BY due_date LIMIT 1", pid, patient.id, addDays(today, 60));
  if (recall) {
    const rt = (await recallTypes(db, pid)).find((t) => t.key === recall.type);
    const type = rt?.appointment_type_id ? await db.get('SELECT * FROM appointment_types WHERE id = ? AND practice_id = ? AND active = 1', rt.appointment_type_id, pid) : null;
    return { kind: 'recall', label: `${rt?.name || 'Recall'} (due ${recall.due_date})`, duration: typeDuration(type, null) || 60, appointment_type_id: type?.id ?? null, provider_type: type?.provider_type || 'hygienist', not_before: recall.due_date > today ? recall.due_date : null };
  }
  if (planned.length) return { kind: 'treatment', label: `Planned treatment: ${planned.map((p) => p.code).join(', ')}`, duration: Math.min(180, 30 + 30 * planned.length), ...dentistType };
  return { kind: 'visit', label: 'Visit', duration: 60, provider_type: null };
}

// Open times for the next few weeks across the providers who do this kind of visit (or those asked for), a
// handful per provider per day, soonest first. The screen filters them as the caller talks.
export async function nextOpenings(db, pid, { need, request = null, days = 21, limit = 60, locationId = null }) {
  const now = await practiceNow(db, pid);
  const all = await db.all('SELECT id, name, type FROM providers WHERE practice_id = ? AND active = 1 ORDER BY id', pid);
  let providers = request?.provider_ids?.length ? all.filter((p) => request.provider_ids.includes(p.id)) : all.filter((p) => !need.provider_type || p.type === need.provider_type);
  if (!providers.length) providers = all;
  const slots = [];
  let date = need.not_before && need.not_before > now.slice(0, 10) ? need.not_before : now.slice(0, 10);
  if (request?.date_from && request.date_from > date) date = request.date_from;
  const perDay = request && !emptyRequest(request) ? 8 : 3;
  for (let i = 0; i < Math.min(60, Math.max(1, days)) && slots.length < limit; i++, date = addDays(date, 1)) {
    if (request?.date_to && date > request.date_to) break;
    if (request?.weekdays?.length && !request.weekdays.includes(weekdayOf(date))) continue;
    for (const p of providers) {
      const times = await openSlots(db, pid, p.id, date, { duration: need.duration || 60, step: 30, after: now, typeId: need.appointment_type_id ?? null, locationId });
      const fit = filterSlots(times.map((start) => ({ start, provider_id: p.id })), request);
      for (const x of fit.slice(0, perDay)) slots.push({ ...x, provider: p.name, provider_type: p.type });
    }
  }
  slots.sort((a, b) => a.start.localeCompare(b.start) || a.provider_id - b.provider_id);
  return { providers: providers.map((p) => ({ id: p.id, name: p.name, type: p.type })), slots: slots.slice(0, limit) };
}

// One click books: the same checks as the schedule (validateAppt: hours, conflicts, blocks), linked to the call,
// recall and autopilot updated. Booking the same slot again for the same call returns the first booking.
export async function bookFromCall(db, req, call, body) {
  const pid = req.user.practice_id;
  const patientId = Number(body.patient_id || call.patient_id);
  if (!Number.isInteger(patientId) || patientId <= 0) throw new HttpError(400, 'Choose who the visit is for');
  const start = normalizeDateTime(body.start_time, 'start_time');
  const providerId = Number(body.provider_id);
  const duration = Number(body.duration || 60);
  if (!Number.isInteger(duration) || duration < 10 || duration > 240) throw new HttpError(400, 'duration must be 10-240 minutes');
  if (call.appointment_id) {
    const had = await db.get('SELECT * FROM appointments WHERE id = ?', call.appointment_id);
    if (had && had.status !== 'cancelled' && had.patient_id === patientId && had.start_time === start && had.provider_id === providerId) return { appointment: had, repeat: true };
  }
  const now = await practiceNow(db, pid);
  if (start <= now) throw new HttpError(400, 'That time has already passed');
  const type = body.appointment_type_id ? await db.get('SELECT * FROM appointment_types WHERE id = ? AND practice_id = ?', Number(body.appointment_type_id), pid) : null;
  if (body.appointment_type_id && !type) throw new HttpError(404, 'Appointment type not found');
  const row = {
    patient_id: patientId, provider_id: providerId, operatory_id: null, start_time: start, end_time: addMinutes(start, duration), status: 'scheduled',
    reason: String(body.reason || type?.name || '').slice(0, 200) || null, appointment_type_id: type?.id ?? null, location_id: req.location_id ?? null,
  };
  await validateAppt(db, pid, row);
  const id = await insert(db, 'appointments', { ...row, practice_id: pid, notice_due: 'booked', notes: 'Booked from a phone call' });
  await linkRecalls(db, pid, id);
  // Recall autopilot bookkeeping: the booking stands either way, and a failure shows in Needs attention.
  await stopForBooking(db, pid, patientId, id, { via: 'office' }).catch(failed(db, { practiceId: pid, kind: 'schedule', key: `call-book-cadence:${id}`, role: 'front_desk', title: 'A visit booked from a call didn’t stop the patient’s recall reminders' }));
  await db.run("UPDATE calls SET appointment_id = ?, outcome = CASE WHEN outcome IS NULL OR outcome = 'answered' THEN 'booked' ELSE outcome END, patient_id = COALESCE(patient_id, ?) WHERE id = ?", id, patientId, call.id);
  if (!call.agent_id) await db.run("UPDATE calls SET agent_id = ?, agent_source = 'claimed' WHERE id = ? AND agent_id IS NULL", req.user.id, call.id);
  await audit(db, req, 'call.book', 'calls', call.id, { appointment_id: id, patient_id: patientId, start_time: start, provider_id: providerId }, { patientId });
  publish(pid, { type: 'schedule', dates: [start.slice(0, 10)], source: 'phone' });
  publish(pid, { type: 'call', event: 'booked', call_id: call.id });
  return { appointment: await db.get('SELECT * FROM appointments WHERE id = ?', id), repeat: false };
}

// ---- Live speech (PH6, PH5) ----
// A phrase heard during the call (final or partial). Final phrases are kept; the caller's words are parsed for
// what they're asking for (published to the practice's screens: days, part of day, provider ids — no names or
// words), and checked for an upset caller.
export async function hearSpeech(db, { messenger, config } = {}, call, { track = 'caller', text, final = true, seq = null }) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!clean) return null;
  if (final) {
    const n = seq ?? Number((await db.get('SELECT COUNT(*) AS n FROM call_segments WHERE call_id = ? AND track = ?', call.id, track)).n) + 1;
    await db.run('INSERT INTO call_segments (practice_id, call_id, track, text, seq) VALUES (?, ?, ?, ?, ?) ON CONFLICT (call_id, track, seq) DO NOTHING', call.practice_id, call.id, track, clean, n);
  }
  if (track !== 'caller') return null;
  const said = (await db.all("SELECT text FROM call_segments WHERE call_id = ? AND track = 'caller' ORDER BY seq", call.id)).map((r) => r.text);
  if (!final) said.push(clean);
  const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', call.practice_id))?.timezone || 'America/New_York';
  const providers = await db.all('SELECT id, name FROM providers WHERE practice_id = ? AND active = 1', call.practice_id);
  const request = parseRequest(said.join(' '), { today: localNow(tz).slice(0, 10), providers });
  const { heard: _h, ...ids } = request;
  if (!emptyRequest(request)) publish(call.practice_id, { type: 'call', event: 'request', call_id: call.id, request: ids });
  if (final && !call.call_type) {
    const type = detectCallType(said.map((x) => `Caller: ${x}`).join('\n'), { newCaller: !!call.new_caller });
    if (type !== 'general') {
      await db.run('UPDATE calls SET call_type = ? WHERE id = ? AND call_type IS NULL', type, call.id);
      call.call_type = type;
      publish(call.practice_id, { type: 'call', event: 'call_type', call_id: call.id, call_type: type });
    }
  }
  let alert = null;
  if (final) {
    const mood = detectUpset(said.map((x) => `Caller: ${x}`).join('\n'));
    if (mood.upset) alert = await withActor({ source: 'automation', actor: 'Live call listener', practiceId: call.practice_id }, () => raiseUpsetAlert(db, { messenger, config }, { call, quote: mood.quote, source: 'live' }));
  }
  return { request, alert };
}

// ---- Who should have answered (PH7) ----
// The people who answer phones (settings), else the front desk. Who was on shift at a moment: those clocked in
// then (time clock punches, the corrected times), else those scheduled (staff_shifts).
export async function answerers(db, pid) {
  const st = await phoneSettings(db, pid);
  const users = await db.all(`SELECT u.id, u.name, u.role, cr.name AS custom_role_name FROM users u LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id WHERE u.practice_id = ? AND u.active = 1 ORDER BY u.id`, pid);
  const chosen = st.answerer_ids.length ? users.filter((u) => st.answerer_ids.includes(u.id)) : users.filter((u) => u.role === 'front_desk');
  return { all: users, answerers: chosen.length ? chosen : users.filter((u) => u.role !== 'api') };
}
export async function shiftIndex(db, pid, from, to) {
  const punches = await db.all(
    'SELECT user_id, COALESCE(eff_in, clock_in) AS s, COALESCE(eff_out, clock_out) AS e FROM time_punches WHERE practice_id = ? AND deleted_at IS NULL AND COALESCE(eff_in, clock_in) <= ? AND (COALESCE(eff_out, clock_out) IS NULL OR COALESCE(eff_out, clock_out) >= ?)',
    pid, `${to} 23:59`, `${from} 00:00`,
  );
  const shifts = await db.all("SELECT user_id, date, start_time, end_time FROM staff_shifts WHERE practice_id = ? AND date >= ? AND date <= ? AND status = 'scheduled' AND start_time IS NOT NULL AND end_time IS NOT NULL", pid, from, to);
  return (local) => {
    const date = local.slice(0, 10);
    const hm = local.slice(11, 16);
    const clocked = punches.filter((p) => p.s <= local && (!p.e || p.e > local)).map((p) => p.user_id);
    if (clocked.length) return [...new Set(clocked)];
    return [...new Set(shifts.filter((x) => x.date === date && x.start_time <= hm && x.end_time > hm).map((x) => x.user_id))];
  };
}

// ---- The numbers (PH3, PH7) ----
const tail = (n) => String(n || '').replace(/\D/g, '').slice(-10);
const utcMs = (s) => Date.parse(`${String(s).replace(' ', 'T').slice(0, 19)}Z`);
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2); };

// The effective score of a call: the newest owner/manager rating if there is one, else the AI's.
export async function effectiveScores(db, callIds) {
  const out = new Map();
  if (!callIds.length) return out;
  for (let i = 0; i < callIds.length; i += 400) {
    const chunk = callIds.slice(i, i + 400);
    const q = chunk.map(() => '?').join(',');
    for (const r of await db.all(`SELECT call_id, score FROM call_scores WHERE status = 'current' AND call_id IN (${q})`, ...chunk)) out.set(r.call_id, { ai: r.score, score: r.score, by: 'ai' });
    for (const r of await db.all(`SELECT call_id, rating FROM call_reviews WHERE rating IS NOT NULL AND call_id IN (${q}) ORDER BY id`, ...chunk)) out.set(r.call_id, { ...(out.get(r.call_id) || {}), score: r.rating, by: 'owner' });
  }
  return out;
}

// Everything for a period: per person (answer rate, time to answer, missed/abandoned, new-patient bookings,
// average score), and missed calls by day, hour, weekday × hour, line and position, voicemails, callbacks.
export async function phoneMetrics(db, pid, { from, to }) {
  const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', pid))?.timezone || 'America/New_York';
  const [startUtc, endUtc] = await utcRange(db, pid, from, to);
  const calls = await db.all(
    `SELECT id, patient_id, direction, purpose, from_number, to_number, source, outcome, desk_result, agent_id, agent_source, ring_seconds, call_type, new_caller, appointment_id, texted_back_at, created_at
     FROM calls WHERE practice_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at`, pid, startUtc, endUtc,
  );
  const inbound = calls.filter((c) => c.direction === 'inbound');
  const outbound = await db.all(
    "SELECT id, patient_id, to_number, from_number, purpose, created_at FROM calls WHERE practice_id = ? AND direction = 'outbound' AND created_at >= ? AND created_at < ? ORDER BY created_at",
    pid, startUtc, new Date(utcMs(endUtc) + 3 * 86400_000).toISOString().slice(0, 19).replace('T', ' '),
  );
  const { all: team, answerers: phoneTeam } = await answerers(db, pid);
  const phoneIds = new Set(phoneTeam.map((u) => u.id));
  const onShift = await shiftIndex(db, pid, from, to);
  const scores = await effectiveScores(db, inbound.map((c) => c.id));
  const lines = new Map((await db.all('SELECT number, source FROM tracking_numbers WHERE practice_id = ?', pid)).map((t) => [tail(t.number), t.source]));
  const person = new Map();
  const P = (id) => {
    if (!person.has(id)) {
      const u = team.find((x) => x.id === id);
      person.set(id, { user_id: id, name: u?.name || 'Former staff', position: u?.custom_role_name || u?.role || null, rang: 0, answered: 0, missed: 0, abandoned: 0, voicemail: 0, handled: 0, ring: [], np_calls: 0, np_booked: 0, scores: [], owner_rated: 0 });
    }
    return person.get(id);
  };
  const blank = () => ({ total: 0, rang: 0, answered: 0, missed: 0, abandoned: 0, voicemail: 0 });
  const byDay = new Map();
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, ...blank() }));
  const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ total: 0, missed: 0 })));
  const byLine = new Map();
  const byPosition = new Map();
  const unattributed = blank();
  const totals = { ...blank(), after_hours: 0, ai_answered: 0, texted_back: 0, callbacks: 0, callback_minutes: [], new_patient_calls: 0, new_patient_booked: 0 };
  const missedCalls = [];
  for (const c of inbound) {
    const local = utcToLocal(tz, utcMs(c.created_at));
    const date = local.slice(0, 10);
    const hour = Number(local.slice(11, 13));
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const rang = !!c.desk_result;
    const missed = DESK_MISSED.includes(c.desk_result);
    const answered = c.desk_result === 'answered';
    const vm = c.outcome === 'voicemail';
    const line = c.source || lines.get(tail(c.to_number)) || 'Main line';
    const buckets = [byDay.get(date) || byDay.set(date, { date, ...blank() }).get(date), byHour[hour], byLine.get(line) || byLine.set(line, { line, ...blank() }).get(line), totals];
    for (const b of buckets) {
      b.total++;
      if (rang) b.rang++;
      if (answered) b.answered++;
      if (missed) b.missed++;
      if (c.desk_result === 'abandoned') b.abandoned++;
      if (vm) b.voicemail++;
    }
    heat[dow][hour].total++;
    if (missed) heat[dow][hour].missed++;
    if (c.outcome === 'after_hours') totals.after_hours++;
    if (c.purpose === 'receptionist') totals.ai_answered++;
    if (c.texted_back_at) totals.texted_back++;
    // Who should have answered: whoever took it; otherwise the phone team on shift then.
    const who = c.agent_id ? [c.agent_id] : rang ? onShift(local).filter((id) => phoneIds.has(id)) : [];
    if (rang && !who.length) {
      unattributed.total++; unattributed.rang++;
      if (answered) unattributed.answered++;
      if (missed) unattributed.missed++;
      if (c.desk_result === 'abandoned') unattributed.abandoned++;
    }
    for (const id of who) {
      const p = P(id);
      if (rang) p.rang++;
      if (answered) p.answered++;
      if (missed) p.missed++;
      if (c.desk_result === 'abandoned') p.abandoned++;
      if (vm) p.voicemail++;
      const pos = p.position || 'Unassigned';
      const pb = byPosition.get(pos) || byPosition.set(pos, { position: pos, ...blank() }).get(pos);
      pb.total++;
      if (rang) pb.rang++;
      if (answered) pb.answered++;
      if (missed) pb.missed++;
      if (c.desk_result === 'abandoned') pb.abandoned++;
    }
    const isNp = c.call_type === 'new_patient' || (!!c.new_caller && c.call_type !== 'billing' && c.call_type !== 'emergency' && c.call_type != null);
    const booked = isNp ? await wasBooked(db, c) : false;
    if (isNp) { totals.new_patient_calls++; if (booked) totals.new_patient_booked++; }
    if (c.agent_id) {
      const p = P(c.agent_id);
      p.handled++;
      if (answered && c.ring_seconds != null) p.ring.push(c.ring_seconds);
      if (isNp) { p.np_calls++; if (booked) p.np_booked++; }
      const sc = scores.get(c.id);
      if (sc?.score != null) { p.scores.push(sc.score); if (sc.by === 'owner') p.owner_rated++; }
    }
    if (missed || vm) missedCalls.push({ ...c, local });
  }
  // Callbacks: the first call back out to the same number (or patient) within three days of a missed call.
  for (const m of missedCalls) {
    const t0 = utcMs(m.created_at);
    const back = outbound.find((o) => utcMs(o.created_at) > t0 && utcMs(o.created_at) - t0 <= 3 * 86400_000 && ((tail(o.to_number || o.from_number) && tail(o.to_number || o.from_number) === tail(m.from_number)) || (m.patient_id && o.patient_id === m.patient_id)));
    if (back) { totals.callbacks++; totals.callback_minutes.push(Math.round((utcMs(back.created_at) - t0) / 60000)); }
  }
  const rate = (b) => ({ ...b, missed_pct: pct(b.missed, b.rang), answer_rate: pct(b.answered, b.rang) });
  const people = [...person.values()].map((p) => ({
    user_id: p.user_id, name: p.name, position: p.position, rang: p.rang, answered: p.answered, missed: p.missed, abandoned: p.abandoned, voicemail: p.voicemail, handled: p.handled,
    answer_rate: pct(p.answered, p.rang), avg_seconds_to_answer: avg(p.ring), new_patient_calls: p.np_calls, new_patient_booked: p.np_booked, new_patient_booked_pct: pct(p.np_booked, p.np_calls),
    avg_score: avg(p.scores), scored_calls: p.scores.length, owner_rated: p.owner_rated,
  }));
  const { callback_minutes: cbm, ...t } = totals;
  return {
    from, to, timezone: tz,
    totals: { ...rate(t), callback_median_minutes: median(cbm), callback_pct: pct(t.callbacks, missedCalls.length), new_patient_booked_pct: pct(t.new_patient_booked, t.new_patient_calls), missed_or_voicemail: missedCalls.length },
    by_day: [...byDay.values()].map(rate), by_hour: byHour.map(rate), heatmap: heat, by_line: [...byLine.values()].map(rate), by_position: [...byPosition.values()].map(rate),
    unattributed: rate(unattributed), people,
  };
}

// The leaderboard: people ranked by average score, then answer rate (coaching, not discipline).
export const leaderboard = (people) => [...people].filter((p) => p.handled || p.rang)
  .sort((a, b) => (b.avg_score ?? -1) - (a.avg_score ?? -1) || (b.answer_rate ?? -1) - (a.answer_rate ?? -1) || b.handled - a.handled || a.user_id - b.user_id)
  .map((p, i) => ({ rank: i + 1, ...p }));

// Why callers didn't book: counts and share by reason, weekly trend, over the confirmed reasons (and the
// suggestions still waiting for a person, shown apart).
export async function noBookStats(db, pid, { from, to }) {
  const [startUtc, endUtc] = await utcRange(db, pid, from, to);
  const rows = await db.all('SELECT n.*, c.created_at AS call_at FROM call_no_book n JOIN calls c ON c.id = n.call_id WHERE n.practice_id = ? AND c.created_at >= ? AND c.created_at < ?', pid, startUtc, endUtc);
  const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', pid))?.timezone || 'America/New_York';
  const confirmed = rows.filter((r) => r.reason);
  const counts = Object.fromEntries(Object.keys(NO_BOOK_REASONS).map((k) => [k, 0]));
  const weeks = new Map();
  for (const r of confirmed) {
    counts[r.reason]++;
    const d = utcToLocal(tz, utcMs(r.call_at)).slice(0, 10);
    const wk = addDays(d, -new Date(`${d}T12:00:00Z`).getUTCDay());
    const w = weeks.get(wk) || weeks.set(wk, { week: wk, total: 0, ...Object.fromEntries(Object.keys(NO_BOOK_REASONS).map((k) => [k, 0])) }).get(wk);
    w.total++;
    w[r.reason]++;
  }
  return {
    from, to, total: confirmed.length, waiting: rows.length - confirmed.length,
    reasons: Object.entries(counts).map(([reason, n]) => ({ reason, label: NO_BOOK_REASONS[reason], count: n, pct: pct(n, confirmed.length) })).sort((a, b) => b.count - a.count),
    trend: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
  };
}

// ---- Missed-call target (PH7): checked through the day; one alert per practice per day ----
export async function runMissedCallCheck(db, { messenger = null, now = new Date(), practiceId = null } = {}) {
  const practices = practiceId ? await db.all('SELECT id, timezone FROM practices WHERE id = ?', practiceId) : await db.all('SELECT DISTINCT p.id, p.timezone FROM practices p JOIN phone_settings s ON s.practice_id = p.id');
  const raised = [];
  for (const p of practices) {
    await withActor({ source: 'automation', actor: 'Missed-call check', practiceId: p.id, userId: null }, async () => {
      const st = await phoneSettings(db, p.id);
      const today = localNow(p.timezone || 'America/New_York', now).slice(0, 10);
      const [s0, s1] = await utcRange(db, p.id, today, today);
      const r = await db.get("SELECT SUM(CASE WHEN desk_result IS NOT NULL THEN 1 ELSE 0 END) AS rang, SUM(CASE WHEN desk_result IN ('missed','abandoned') THEN 1 ELSE 0 END) AS missed FROM calls WHERE practice_id = ? AND direction = 'inbound' AND created_at >= ? AND created_at < ?", p.id, s0, s1);
      const rang = Number(r?.rang) || 0;
      const missed = Number(r?.missed) || 0;
      const share = rang ? (100 * missed) / rang : 0;
      if (rang < st.missed_min_calls || share <= st.missed_target_pct) return;
      const key = `missed-rate:${today}`;
      if (await db.get('SELECT id FROM phone_alerts WHERE practice_id = ? AND dedupe_key = ?', p.id, key)) return;
      const detail = `${missed} of ${rang} calls missed today (${Math.round(share)}%; target ${st.missed_target_pct}%).`;
      try {
        await db.run("INSERT INTO phone_alerts (practice_id, kind, dedupe_key, detail, source) VALUES (?, 'missed_rate', ?, ?, 'automation')", p.id, key, detail);
      } catch (err) {
        if (/unique|duplicate/i.test(String(err.message))) return;
        throw err;
      }
      const alert = await db.get('SELECT * FROM phone_alerts WHERE practice_id = ? AND dedupe_key = ?', p.id, key);
      await raiseIssue(db, { practiceId: p.id, kind: 'phones', key: `phone-alert:${alert.id}`, severity: 'high', role: 'admin', title: `Missed calls over target today: ${Math.round(share)}%`, detail });
      await notify(db, messenger, p.id, alert, { chatBody: `Missed calls are over target today: ${detail} See Phones → Missed calls.`, smsBody: `Dental Machine: missed calls are over target today (${Math.round(share)}%). Reply STOP to opt out.` });
      raised.push(alert.id);
    });
  }
  return raised;
}

