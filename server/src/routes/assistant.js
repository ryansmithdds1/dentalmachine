import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { HttpError, rateLimit } from '../auth.js';
import { audit, practiceNow, insert } from '../util.js';
import { log } from '../monitoring.js';
import { apiAs, toolbox } from '../assistantTools.js';

// The assistant: staff say (or type) what they want — "book Ryan Smith for a crown prep with Dr. Lee next
// Tuesday", "take a $120 card payment", "note: patient reports sensitivity on 19" — and Claude works out
// the steps. Claude only proposes tool calls; the browser carries them out through the same API as the
// screens, as the signed-in user, so permissions, office restrictions, validation and the audit log all
// apply unchanged. Anything that changes the record waits for the user to confirm it.
//
// This route holds the API key and the instructions, and passes the conversation through. Patient
// details go to Anthropic, so a signed BAA with Anthropic is required before real patient data is used.

export const TOOLS = [
  // ---- Look things up (run straight away) ----
  {
    name: 'find_patient', kind: 'read',
    description: 'Search patients by name, phone, date of birth (YYYY-MM-DD) or chart number. Returns up to 8 matches with id, name, date of birth, balance and next visit. Always use this to get a patient id; never guess ids.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Name, phone, DOB or chart number' } }, required: ['query'] },
  },
  {
    name: 'patient_summary', kind: 'read',
    description: 'One patient at a glance: balance, insurance and eligibility, last and next visits, unscheduled treatment, medical alerts.',
    input_schema: { type: 'object', properties: { patient_id: { type: 'integer' } }, required: ['patient_id'] },
  },
  {
    name: 'practice_setup', kind: 'read',
    description: 'The practice\'s providers (dentists, hygienists), chairs (operatories) and appointment types with their lengths. Use it to turn "Dr. Lee" or "a crown prep" into ids.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'find_open_times', kind: 'read',
    description: 'Open appointment times for a provider, searching day by day from a start date. Returns the first matching times (at most 12).',
    input_schema: {
      type: 'object',
      properties: {
        provider_id: { type: 'integer' },
        from_date: { type: 'string', description: 'YYYY-MM-DD, the first day to search' },
        days: { type: 'integer', description: 'How many days to search (1-21), default 7' },
        duration_minutes: { type: 'integer', description: 'Visit length; taken from the appointment type when one is given' },
        appointment_type_id: { type: 'integer' },
        time_of_day: { type: 'string', enum: ['any', 'morning', 'afternoon'], description: 'morning = before 12:00' },
      },
      required: ['provider_id', 'from_date'],
    },
  },
  {
    name: 'patient_appointments', kind: 'read',
    description: 'A patient\'s upcoming appointments (the next 12 months), with ids for rescheduling or status changes.',
    input_schema: { type: 'object', properties: { patient_id: { type: 'integer' } }, required: ['patient_id'] },
  },
  {
    name: 'day_schedule', kind: 'read',
    description: 'Appointments on a day, optionally for one provider.',
    input_schema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, provider_id: { type: 'integer' } }, required: ['date'] },
  },
  {
    name: 'search_procedure_codes', kind: 'read',
    description: 'Find CDT procedure codes by code or words ("crown", "D2740", "composite two surface posterior"). Returns code, description and whether a tooth, surfaces or quadrant is required.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'patient_treatment', kind: 'read',
    description: 'A patient\'s planned (not yet done) treatment, with procedure ids.',
    input_schema: { type: 'object', properties: { patient_id: { type: 'integer' } }, required: ['patient_id'] },
  },
  {
    name: 'note_templates', kind: 'read',
    description: 'The practice\'s clinical note templates (name, the codes they go with, and the text with [[Label: option|option]] blanks). Use one when the person names it ("crown prep note") or when it clearly fits what was done.',
    input_schema: { type: 'object', properties: {} },
  },
  // ---- Move around the app (run straight away) ----
  {
    name: 'open_screen', kind: 'ui',
    description: 'Show a screen: the schedule (optionally on a date), a patient\'s chart on a tab, or another area of the app.',
    input_schema: {
      type: 'object',
      properties: {
        screen: { type: 'string', enum: ['schedule', 'patient', 'patients', 'today', 'claims', 'reports', 'messages', 'settings'] },
        patient_id: { type: 'integer' },
        tab: { type: 'string', enum: ['overview', 'chart', 'treatment', 'perio', 'notes', 'documents', 'ledger', 'insurance', 'family', 'rx', 'comms'] },
        date: { type: 'string', description: 'YYYY-MM-DD for the schedule' },
      },
      required: ['screen'],
    },
  },
  {
    name: 'start_voice_perio', kind: 'ui',
    description: 'Open the patient\'s perio chart and start full-mouth voice charting (the hygienist then reads depths tooth by tooth without you). Use for "start perio", "let\'s do perio", "chart perio".',
    input_schema: { type: 'object', properties: { patient_id: { type: 'integer' } }, required: ['patient_id'] },
  },
  // ---- Change the record (the user confirms first; low-risk ones run at once with Undo) ----
  {
    name: 'book_appointment', kind: 'write',
    description: 'Book an appointment. With an appointment type the length and planned procedures come from the type.',
    input_schema: {
      type: 'object',
      properties: {
        patient_id: { type: 'integer' },
        provider_id: { type: 'integer' },
        start_time: { type: 'string', description: 'YYYY-MM-DD HH:MM (24-hour, practice time)' },
        appointment_type_id: { type: 'integer' },
        duration_minutes: { type: 'integer', description: 'Needed when there is no appointment type' },
        operatory_id: { type: 'integer' },
        reason: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['patient_id', 'provider_id', 'start_time'],
    },
  },
  {
    name: 'reschedule_appointment', kind: 'write',
    description: 'Move an existing appointment to a new start time (same length), optionally to another provider or chair.',
    input_schema: {
      type: 'object',
      properties: { appointment_id: { type: 'integer' }, start_time: { type: 'string', description: 'YYYY-MM-DD HH:MM' }, provider_id: { type: 'integer' }, operatory_id: { type: 'integer' } },
      required: ['appointment_id', 'start_time'],
    },
  },
  {
    name: 'set_appointment_status', kind: 'write',
    description: 'Mark an appointment confirmed, checked in (arrived), in the chair (seated), completed, cancelled or no-show.',
    input_schema: {
      type: 'object',
      properties: { appointment_id: { type: 'integer' }, status: { type: 'string', enum: ['confirmed', 'checked_in', 'in_chair', 'completed', 'cancelled', 'no_show'] } },
      required: ['appointment_id', 'status'],
    },
  },
  {
    name: 'record_payment', kind: 'write',
    description: 'Post a patient payment to the ledger.',
    input_schema: {
      type: 'object',
      properties: {
        patient_id: { type: 'integer' },
        amount_dollars: { type: 'number', description: 'e.g. 120.50' },
        method: { type: 'string', enum: ['cash', 'check', 'credit_card', 'debit_card', 'ach', 'care_credit', 'other'] },
        reference: { type: 'string', description: 'Check number or card last four, if said' },
        note: { type: 'string' },
      },
      required: ['patient_id', 'amount_dollars', 'method'],
    },
  },
  {
    name: 'add_clinical_note', kind: 'write',
    description: 'Add a clinical note to the patient\'s chart (unsigned; the provider signs it in the chart).',
    input_schema: {
      type: 'object',
      properties: { patient_id: { type: 'integer' }, body: { type: 'string', description: 'The note, written up from the dictation' }, appointment_id: { type: 'integer' } },
      required: ['patient_id', 'body'],
    },
  },
  {
    name: 'add_procedures', kind: 'write',
    description: 'Chart procedures for a patient: planned treatment (default), or completed work (posts the fee to the ledger).',
    input_schema: {
      type: 'object',
      properties: {
        patient_id: { type: 'integer' },
        status: { type: 'string', enum: ['planned', 'completed'] },
        provider_id: { type: 'integer' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'CDT code, e.g. D2740' },
              tooth: { type: 'string', description: 'Universal 1-32 or A-T' },
              surfaces: { type: 'string', description: 'e.g. MOD' },
              area: { type: 'string', description: 'Quadrant (UR, UL, LR, LL) or arch (U, L) for codes charted that way' },
            },
            required: ['code'],
          },
        },
      },
      required: ['patient_id', 'items'],
    },
  },
  {
    name: 'chart_conditions', kind: 'write',
    description: 'Chart existing conditions and work found on exam (not treatment): existing fillings, crowns, root canals, implants, missing teeth, caries, fractures, watches.',
    input_schema: {
      type: 'object',
      properties: {
        patient_id: { type: 'integer' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tooth: { type: 'string' },
              condition: { type: 'string', enum: ['caries', 'missing', 'filling', 'crown', 'root_canal', 'implant', 'bridge_pontic', 'fracture', 'sealant', 'veneer', 'impacted', 'watch', 'abscess', 'mobility'] },
              surfaces: { type: 'string' },
              notes: { type: 'string', description: 'e.g. "amalgam", "PFM"' },
            },
            required: ['tooth', 'condition'],
          },
        },
      },
      required: ['patient_id', 'items'],
    },
  },
  {
    name: 'record_perio', kind: 'write',
    description: 'Record periodontal readings for some teeth on today\'s perio exam (added to it if one exists). Six sites per tooth in the order DB, B, MB, DL, L, ML; use null for a site not read.',
    input_schema: {
      type: 'object',
      properties: {
        patient_id: { type: 'integer' },
        teeth: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tooth: { type: 'string' },
              pd: { type: 'array', items: { type: ['integer', 'null'] }, description: '6 pocket depths in mm' },
              bop: { type: 'array', items: { type: 'boolean' }, description: '6 bleeding flags' },
              gm: { type: 'array', items: { type: ['integer', 'null'] }, description: '6 gingival margin / recession readings in mm' },
              mob: { type: 'integer', description: 'Mobility 0-3' },
              missing: { type: 'boolean' },
            },
            required: ['tooth'],
          },
        },
      },
      required: ['patient_id', 'teeth'],
    },
  },
];

const SYSTEM = `You are the assistant built into Dental Machine, a dental practice management system. Dentists, hygienists, assistants and front-desk staff talk to you mid-task, usually with gloves on, to avoid typing and clicking. Speed matters more than conversation: do the work with the tools and say as little as possible.

How to work:
- The operator note at each turn tells you the date, who is speaking, what is on screen, the open patient's summary (id, balance, today's visit, planned treatment) and, on this computer, which chair and who is in it. Use it instead of looking those things up again. The first note also lists the providers, chairs and appointment types with their ids.
- Look up anything else before acting: find_patient for other patients, search_procedure_codes for codes, find_open_times for openings, note_templates for templates. Never invent an id.
- "The patient", "her", "him", "this patient" mean the patient on screen, or else the one in this computer's chair.
- If a name matches more than one patient, ask which (give dates of birth). If something essential is missing, ask one short question. Otherwise don't ask — act.
- Make changes by calling the tools. The person sees exactly what you are about to do and confirms it, so never ask "shall I?". Do everything that was asked in one go: several tool calls in the same turn become one confirmation.
- Scheduling: find open times, then book the best match (earliest that fits what they said). An exact time they gave can be booked directly.
- Payments are in dollars; card payments here are recorded, not charged.
- Clinical notes: write a clean professional note from the dictation, in its order, with nothing added. If they name a template or one clearly fits, fill its blanks from what was said and leave unmentioned blanks as they are.
- Charting what's already there (existing restorations, missing teeth, decay found) is chart_conditions; treatment to do or done today is add_procedures.
- Teeth use Universal numbering (1-32, primary A-T). Perio sites are DB, B, MB, DL, L, ML: "buccal 3 2 4" is DB, B, MB; "lingual" is DL, L, ML. For a full-mouth perio chart by voice, use start_voice_perio.
- Replies are shown briefly, not read aloud: at most one short sentence, or just the question you need answered. After making changes, say nothing unless there's something they need to know. Times in 12-hour form. No markdown.
- If a tool returns an error, say plainly what went wrong in a few words.`;

// Tool definitions as sent to Claude (the kind is ours, not the API's).
const API_TOOLS = TOOLS.map(({ kind: _kind, ...t }) => t);
const KIND = Object.fromEntries(TOOLS.map((t) => [t.name, t.kind]));

// Low-risk changes happen at once and can be undone; the rest wait for a yes.
const isAuto = (u) => (u.name === 'set_appointment_status' && ['confirmed', 'checked_in', 'in_chair'].includes(u.input?.status)) || u.name === 'record_perio';

async function runReads(uses, tb, steps, ui) {
  return Promise.all(uses.map(async (u) => {
    try {
      if (KIND[u.name] === 'ui') {
        ui.push({ name: u.name, ...u.input });
        return { type: 'tool_result', tool_use_id: u.id, content: '{"ok":true}' };
      }
      const fn = tb.readers[u.name];
      if (!fn) throw new Error(`Unknown tool ${u.name}`);
      const out = await fn(u.input || {});
      steps.push(tb.stepLabel(u.name, u.input || {}, out));
      return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) };
    } catch (err) {
      steps.push(`${tb.stepLabel(u.name, u.input || {}, null)}: ${err.message}`);
      return { type: 'tool_result', tool_use_id: u.id, content: err.message, is_error: true };
    }
  }));
}

export function assistantConfig(env = process.env) {
  return {
    apiKey: env.ANTHROPIC_API_KEY || null,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    model: env.ASSISTANT_MODEL || 'claude-opus-5-5',
    effort: ['low', 'medium', 'high'].includes(env.ASSISTANT_EFFORT) ? env.ASSISTANT_EFFORT : 'low',
    enabled: env.ASSISTANT !== 'off' && !!env.ANTHROPIC_API_KEY,
  };
}

const MAX_MESSAGES = 60;
const MAX_CHARS = 200_000;

export default function assistantRoutes({ db, config, secret, app: getApp }) {
  const r = Router();
  const cfg = config.assistant || assistantConfig();
  const client = cfg.enabled ? new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 2, timeout: 60_000, ...(config.aiFetch ? { fetch: config.aiFetch } : {}) }) : null;
  const limiter = rateLimit({ windowMs: 60_000, max: 40, name: 'assistant' });
  // Screen notes stay in the conversation (the history is append-only, which newer models check), so
  // the browser keeps them — signed, so a note it sends back is one this server wrote for this user.
  const sign = (userId, text) => createHmac('sha256', `${secret}:assistant-note`).update(`${userId}\n${text}`).digest('base64url');
  const signedOk = (userId, text, sig) => {
    const want = Buffer.from(sign(userId, text));
    const got = Buffer.from(String(sig || ''));
    return got.length === want.length && timingSafeEqual(got, want);
  };

  r.get('/assistant', (req, res) => {
    res.json({ enabled: !!client, tools: TOOLS.map((t) => ({ name: t.name, kind: t.kind })) });
  });

  // One request: Claude plans, the server runs the look-ups (as the signed-in user) and keeps going until
  // Claude is done or wants to change something. The browser gets back everything to append to its copy
  // of the conversation, what to show, and any changes waiting for the person's yes (or, for low-risk
  // ones, to make straight away with Undo).
  r.post('/assistant/turn', limiter, async (req, res) => {
    if (!client) throw new HttpError(503, 'The assistant isn’t set up on this server (ANTHROPIC_API_KEY)');
    const started = Date.now();
    const messages = req.body?.messages;
    if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) throw new HttpError(400, `messages must be a list of 1-${MAX_MESSAGES}`);
    if (JSON.stringify(messages).length > MAX_CHARS) throw new HttpError(413, 'This conversation is too long — start a new one');
    for (const m of messages) {
      if (!m || !['user', 'assistant', 'system'].includes(m.role) || (typeof m.content !== 'string' && !Array.isArray(m.content))) throw new HttpError(400, 'Each message needs a role (user or assistant) and content');
      if (m.role === 'system' && (typeof m.content !== 'string' || !signedOk(req.user.id, m.content, m.sig))) throw new HttpError(400, 'That conversation was changed — start a new one');
    }
    if (messages[0].role !== 'user') throw new HttpError(400, 'The conversation must start with the user');
    if (messages.at(-1).role !== 'user') throw new HttpError(400, 'The conversation must end with the user');

    const ctx = req.body?.context || {};
    const now = await practiceNow(db, req.user.practice_id);
    const practice = await db.get('SELECT name, timezone FROM practices WHERE id = ?', req.user.practice_id);
    const tb = toolbox(apiAs(getApp(), req), now.slice(0, 16));
    const midSystem = /^claude-(opus-5|fable-5)/.test(cfg.model);
    const note = await contextNote({ req, ctx, now, practice, tb, first: !messages.some((m) => m.role === 'system') });

    const append = [];
    const steps = [];
    const ui = [];
    const history = messages.filter((m) => midSystem || m.role !== 'system').map((m) => (m.role === 'system' ? { role: 'system', content: m.content } : m));
    if (midSystem) {
      const signed = { role: 'system', content: note, sig: sign(req.user.id, note) };
      append.push(signed);
      history.push({ role: 'system', content: note });
    }
    const said = typeof messages.at(-1).content === 'string' ? messages.at(-1).content
      : messages.at(-1).content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    let text = '';
    let refused = false;
    let pending = [];
    let readResults = [];
    const used = [];
    for (let step = 0; step < 8; step++) {
      let response;
      try {
        response = await client.beta.messages.create({
          model: cfg.model,
          max_tokens: 8000,
          // A declined request is retried on the model Anthropic recommends; a thinking block whose
          // earlier conversation doesn't match is dropped rather than failing the request.
          ...(midSystem ? { betas: ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01'], fallbacks: 'default' } : {}),
          thinking: midSystem ? { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } : { type: 'adaptive' },
          output_config: { effort: cfg.effort },
          cache_control: { type: 'ephemeral' },
          system: midSystem ? SYSTEM : [{ type: 'text', text: SYSTEM }, { type: 'text', text: note }],
          tools: API_TOOLS,
          messages: history,
        });
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The assistant is busy — try again in a moment');
        if (err instanceof Anthropic.BadRequestError) throw new HttpError(400, 'The assistant couldn’t read that conversation — start a new one');
        if (err instanceof Anthropic.AuthenticationError) throw new HttpError(503, 'The assistant’s API key was rejected');
        if (err instanceof Anthropic.APIError) throw new HttpError(502, 'The assistant isn’t reachable right now');
        throw err;
      }
      if ((response.input_transformations || []).length) log.warn('assistant: earlier reasoning dropped (conversation changed)', { dropped: response.input_transformations.length });
      const turn = { role: 'assistant', content: response.content };
      history.push(turn);
      append.push(turn);
      text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (response.stop_reason === 'refusal') { refused = true; break; }
      const uses = response.content.filter((b) => b.type === 'tool_use');
      if (!uses.length) break;
      used.push(...uses.map((u) => u.name));
      const writes = uses.filter((u) => KIND[u.name] === 'write');
      if (writes.length) {
        // Look-ups asked for alongside the changes still run, so their results travel with the answer.
        readResults = await runReads(uses.filter((u) => KIND[u.name] !== 'write'), tb, steps, ui);
        pending = await Promise.all(writes.map(async (w) => ({ id: w.id, name: w.name, input: w.input, line: await tb.describe(w.name, w.input), auto: isAuto(w) })));
        // All low-risk: made at once with Undo. Any change that matters: everything waits for a yes.
        if (!pending.every((p) => p.auto)) for (const p of pending) p.auto = false;
        break;
      }
      const results = await runReads(uses, tb, steps, ui);
      const back = { role: 'user', content: results };
      history.push(back);
      append.push(back);
    }
    const logId = await insert(db, 'assistant_log', {
      practice_id: req.user.practice_id, user_id: req.user.id, said: String(said).slice(0, 2000), tools: JSON.stringify(used), ms: Date.now() - started,
      outcome: refused ? 'refused' : pending.length ? (pending[0].auto ? 'done' : 'asked') : 'answered',
    });
    await audit(db, req, 'assistant.turn', null, null, { tools: used });
    res.json({ append, text, steps, ui, pending, results: readResults, refused, log_id: logId, ms: Date.now() - started });
  });

  // How each request went (confirmed, cancelled, undone), so the phrases that go wrong can be found.
  r.post('/assistant/log/:lid', async (req, res) => {
    const outcome = ['confirmed', 'cancelled', 'undone', 'failed', 'done'].includes(req.body?.outcome) ? req.body.outcome : null;
    if (!outcome) throw new HttpError(400, 'outcome must be confirmed, cancelled, undone, failed or done');
    await db.run('UPDATE assistant_log SET outcome = ? WHERE id = ? AND practice_id = ? AND user_id = ?', outcome, Number(req.params.lid), req.user.practice_id, req.user.id);
    res.json({ ok: true });
  });
  r.get('/assistant/log', async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Administrator access required');
    res.json(await db.all(
      `SELECT l.id, l.said, l.tools, l.ms, l.outcome, l.created_at, u.name AS user_name FROM assistant_log l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.practice_id = ? ORDER BY l.id DESC LIMIT 300`, req.user.practice_id,
    ));
  });

  // What Claude should know without asking: when and where, who's speaking, the patient on screen, the
  // patient in this computer's chair, and (once per conversation) the practice's providers and visit types.
  async function contextNote({ req, ctx, now, practice, tb, first }) {
    const lines = [
      `Practice: ${practice?.name || ''}. Now: ${now} (${practice?.timezone || 'practice time'}), ${new Date(`${now.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}.`,
      `Speaking: ${req.user.name || req.user.email || 'staff'} (${req.user.role}).`,
      ctx.patient_id ? `On screen: patient #${Number(ctx.patient_id)}'s chart${ctx.tab ? `, ${String(ctx.tab).slice(0, 20)} tab` : ''}.` : `On screen: ${String(ctx.screen || 'the app').slice(0, 40)}.`,
    ];
    const day = now.slice(0, 10);
    const minute = now.slice(0, 16);
    const safe = async (fn) => { try { return await fn(); } catch { return null; } };
    const pid = Number(ctx.patient_id) || null;
    const [setup, card, planned, visits, dayAppts] = await Promise.all([
      first || ctx.chair_id ? safe(() => tb.setup()) : null,
      pid ? safe(() => tb.readers.patient_summary({ patient_id: pid })) : null,
      pid ? safe(() => tb.readers.patient_treatment({ patient_id: pid })) : null,
      pid ? safe(() => tb.readers.patient_appointments({ patient_id: pid })) : null,
      ctx.chair_id ? safe(() => tb.readers.day_schedule({ date: day })) : null,
    ]);
    if (card) {
      lines.push(`Patient on screen: ${JSON.stringify({
        id: card.id, name: `${card.preferred_name || card.first_name} ${card.last_name}`, dob: card.dob, alerts: card.medical_alerts || undefined,
        balance: card.balance, insurance: card.insurance?.carrier || undefined, last_visit: card.last_visit || undefined,
      })}`);
    }
    if (visits?.length) lines.push(`Their upcoming visits: ${JSON.stringify(visits.slice(0, 4))}`);
    if (planned?.length) lines.push(`Their planned treatment: ${JSON.stringify(planned.slice(0, 12))}`);
    const chair = ctx.chair_id ? setup?.chairs.find((c) => c.id === Number(ctx.chair_id)) : null;
    if (chair) {
      const here = (dayAppts || []).filter((a) => a.chair === chair.name && !['cancelled', 'no_show', 'completed'].includes(a.status));
      const current = here.find((a) => a.start_time <= minute && a.end_time > minute) || here.find((a) => a.start_time > minute);
      lines.push(`This computer is in ${chair.name} (chair #${chair.id}).${current ? ` In that chair ${current.start_time <= minute ? 'now' : 'next'}: ${JSON.stringify(current)}` : ' Nobody else is booked there today.'}`);
    }
    if (setup && first) lines.push(`Practice setup: ${JSON.stringify(setup)}`);
    return lines.join('\n');
  }

  return r;
}
