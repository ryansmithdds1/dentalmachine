import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { HttpError, rateLimit } from '../auth.js';
import { audit, practiceNow } from '../util.js';

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
  // ---- Change the record (the user confirms first) ----
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

const SYSTEM = `You are the assistant built into Dental Machine, a dental practice management system. Dentists, hygienists, assistants and front-desk staff talk to you (usually by voice, mid-task) and you do the work in the software for them with the tools.

How to work:
- Resolve people and things with the look-up tools before acting: find_patient for patient ids, practice_setup for providers, chairs and appointment types, search_procedure_codes for CDT codes. Never invent an id.
- If a name matches more than one patient, ask which one (give each date of birth). If something needed is missing (which provider, which day), ask one short question.
- When a patient's chart is open on screen, "the patient" / "her" / "him" means that patient.
- Make the change with the matching tool. The person will be shown exactly what you are about to do and must confirm it, so don't ask "shall I?" first — just call the tool.
- Scheduling: look for open times with find_open_times, then book one. If they gave an exact time, book it directly; if it's taken the booking will fail and you can offer the nearest open times.
- Payments: amounts are in dollars. Card payments here are recorded, not charged.
- Clinical notes: write a clean, professional note from what was dictated, in the dictation's order. Do not add findings, diagnoses or treatment that were not said.
- Teeth use Universal numbering (1-32, primary A-T). Perio sites are DB, B, MB, DL, L, ML. "Buccal 3 2 3" means DB, B, MB; "lingual" means DL, L, ML.
- Replies are read aloud: keep them to one or two short sentences, with times in 12-hour form ("Tuesday the 3rd at 2:30 PM"). No lists or markdown unless showing several options.
- Only do what was asked. If a tool returns an error, say plainly what went wrong.`;

// Tool definitions as sent to Claude (the kind is ours, not the API's).
const API_TOOLS = TOOLS.map(({ kind: _kind, ...t }) => t);

export function assistantConfig(env = process.env) {
  return {
    apiKey: env.ANTHROPIC_API_KEY || null,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    model: env.ASSISTANT_MODEL || 'claude-opus-5',
    effort: ['low', 'medium', 'high'].includes(env.ASSISTANT_EFFORT) ? env.ASSISTANT_EFFORT : 'medium',
    enabled: env.ASSISTANT !== 'off' && !!env.ANTHROPIC_API_KEY,
  };
}

const MAX_MESSAGES = 60;
const MAX_CHARS = 200_000;

export default function assistantRoutes({ db, config }) {
  const r = Router();
  const cfg = config.assistant || assistantConfig();
  const client = cfg.enabled ? new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 2, timeout: 60_000 }) : null;
  const limiter = rateLimit({ windowMs: 60_000, max: 40, name: 'assistant' });

  r.get('/assistant', (req, res) => {
    res.json({ enabled: !!client, tools: TOOLS.map((t) => ({ name: t.name, kind: t.kind })) });
  });

  // One step of the conversation: the browser sends the history (user turns, Claude's turns exactly as
  // returned, and the results of the tools it ran) and gets Claude's next turn back.
  r.post('/assistant/turn', limiter, async (req, res) => {
    if (!client) throw new HttpError(503, 'The assistant isn’t set up on this server (ANTHROPIC_API_KEY)');
    const messages = req.body?.messages;
    if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) throw new HttpError(400, `messages must be a list of 1-${MAX_MESSAGES}`);
    if (JSON.stringify(messages).length > MAX_CHARS) throw new HttpError(413, 'This conversation is too long — start a new one');
    for (const m of messages) {
      if (!m || !['user', 'assistant'].includes(m.role) || (typeof m.content !== 'string' && !Array.isArray(m.content))) throw new HttpError(400, 'Each message needs a role (user or assistant) and content');
    }
    if (messages[0].role !== 'user') throw new HttpError(400, 'The conversation must start with the user');

    // Where the person is and what day it is ride along as an operator note, after the stable (cached) prefix.
    const ctx = req.body?.context || {};
    const now = await practiceNow(db, req.user.practice_id);
    const practice = await db.get('SELECT name, timezone FROM practices WHERE id = ?', req.user.practice_id);
    const screen = [
      `Now: ${now} (${practice?.timezone || 'practice time'}), ${new Date(`${now.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}.`,
      `Signed in: ${req.user.name || req.user.email || 'staff'} (${req.user.role}).`,
      ctx.patient_id ? `On screen: the chart of patient #${Number(ctx.patient_id)}${ctx.patient_name ? ` (${String(ctx.patient_name).slice(0, 80)})` : ''}${ctx.tab ? `, ${String(ctx.tab).slice(0, 20)} tab` : ''}.` : `On screen: ${String(ctx.screen || 'the app').slice(0, 40)}.`,
    ].join(' ');

    // Opus 5 / Fable take the screen note as a mid-conversation system message, so the instructions,
    // tools and history stay a cached prefix; other models get it in the system prompt.
    const midSystem = /^claude-(opus-5|fable-5)/.test(cfg.model);
    const note = `Practice: ${practice?.name || ''}. ${screen}`;
    let response;
    try {
      response = await client.beta.messages.create({
        model: cfg.model,
        max_tokens: 8000,
        ...(midSystem ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
        thinking: { type: 'adaptive' },
        output_config: { effort: cfg.effort },
        cache_control: { type: 'ephemeral' },
        system: midSystem ? SYSTEM : [{ type: 'text', text: SYSTEM }, { type: 'text', text: note }],
        tools: API_TOOLS,
        messages: midSystem ? [...messages, { role: 'system', content: note }] : messages,
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The assistant is busy — try again in a moment');
      if (err instanceof Anthropic.BadRequestError) throw new HttpError(400, 'The assistant couldn’t read that conversation — start a new one');
      if (err instanceof Anthropic.AuthenticationError) throw new HttpError(503, 'The assistant’s API key was rejected');
      if (err instanceof Anthropic.APIError) throw new HttpError(502, 'The assistant isn’t reachable right now');
      throw err;
    }
    await audit(db, req, 'assistant.turn', null, null, { tools: response.content.filter((b) => b.type === 'tool_use').map((b) => b.name) });
    res.json({
      content: response.content,
      stop_reason: response.stop_reason,
      refused: response.stop_reason === 'refusal',
    });
  });

  return r;
}
