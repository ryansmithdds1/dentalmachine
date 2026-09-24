import { structured, aiClient } from '../ai.js';

// The optimizer's optional AI note (OPT, docs/workflows/specs/OPT-optimizer.md): given only what the engine already
// found and priced, a short plain-words ranking of what to do first and why. It never changes the schedule, adds no
// opportunities of its own, and sees no more about a patient than first name and last initial (plus the times,
// providers, $ and reasons the engine computed). Its answer is labelled as AI wherever it's shown.
//   OPTIMIZER_AI=sandbox (or config.optimizerAi = 'sandbox'): a deterministic stand-in for demos and tests.
//   OPTIMIZER_AI=off: never. Otherwise Claude when AI is on for the server — and only for practices that turned it on.
const SYSTEM = `You help a dental office's morning huddle. You get the day's schedule opportunities, already found and priced by the practice software, and each provider's goal.
- Rank the opportunities worth doing first (at most 6) and give each one short plain reason for office staff (what to say or do, why it matters).
- Then one or two sentences on the day overall.
- Use only the facts given. Never invent patients, times, amounts or clinical facts. Never recommend a diagnosis or treatment that isn't in the list. Refer to people only as given (first name and last initial).`;
const TOOL = {
  name: 'huddle_advice',
  description: 'The ranked opportunities and a short summary.',
  input_schema: {
    type: 'object',
    properties: {
      ranked: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, why: { type: 'string', description: 'One plain sentence.' } }, required: ['key', 'why'] } },
      summary: { type: 'string', description: 'One or two plain sentences.' },
    },
    required: ['ranked', 'summary'],
  },
};

const money = (c) => `$${Math.round(Number(c || 0) / 100).toLocaleString('en-US')}`;
// The only thing the model sees: built from the engine's own fields, never from patient rows.
export function aiInput({ providers = [], opportunities = [] }) {
  const lines = ['Providers today:'];
  for (const p of providers) lines.push(`- ${p.name}: goal ${money(p.goal)}, booked ${money(p.scheduled)}${p.headline ? ` (${p.headline})` : ''}`);
  lines.push('', 'Opportunities (key | what | $ office fee | $ expected to collect | minutes | in plan):');
  for (const o of opportunities.filter((x) => x.fits).slice(0, 25)) {
    lines.push(`- ${o.key} | ${o.title} | ${money(o.fee)} | ${money(o.collectible)} | ${o.minutes} | ${o.in_plan ? 'yes' : 'no'}`);
  }
  return lines.join('\n');
}

export function explainMode(config = {}) {
  const want = config.optimizerAi ?? process.env.OPTIMIZER_AI;
  if (want === 'off') return null;
  if (want === 'sandbox') return 'sandbox';
  return aiClient(config) ? 'claude' : null;
}

// Keeps only keys the engine produced and plain, short text.
export function cleanAnswer(out, opportunities) {
  const known = new Set(opportunities.map((o) => o.key));
  const seen = new Set();
  const ranked = (Array.isArray(out?.ranked) ? out.ranked : [])
    .filter((r) => r && known.has(String(r.key)) && !seen.has(String(r.key)) && seen.add(String(r.key)))
    .slice(0, 6).map((r) => ({ key: String(r.key), why: String(r.why || '').replace(/\s+/g, ' ').trim().slice(0, 240) }));
  return { ranked, summary: String(out?.summary || out?.text || '').replace(/\s+/g, ' ').trim().slice(0, 500) };
}

export async function explainPlan(config, { providers, opportunities }, { mode = explainMode(config) } = {}) {
  if (!mode) return null;
  const input = aiInput({ providers, opportunities });
  if (mode === 'sandbox') {
    const top = opportunities.filter((o) => o.fits && o.in_plan).concat(opportunities.filter((o) => o.fits && !o.in_plan)).slice(0, 3);
    return {
      label: 'AI (sandbox)', sandbox: true, input,
      ...cleanAnswer({
        ranked: top.map((o) => ({ key: o.key, why: `Sample reason (AI sandbox): ${o.kind === 'confirm' ? 'protects what is booked' : `adds ${money(o.fee)} in ${o.minutes} min`}.` })),
        summary: `Sample summary (AI sandbox): ${top.length} ${top.length === 1 ? 'opportunity stands' : 'opportunities stand'} out today.`,
      }, opportunities),
    };
  }
  const out = await structured(config, { system: SYSTEM, content: input, tool: TOOL, effort: 'low', maxTokens: 2000 });
  return { label: 'AI', sandbox: false, ...cleanAnswer(out, opportunities) };
}
