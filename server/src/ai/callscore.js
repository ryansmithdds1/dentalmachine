import { structured, aiClient } from '../ai.js';
import { sandboxStepResults, detectCallType, detectUpset, suggestNoBookReason, CALL_TYPES, NO_BOOK_REASONS } from '../phonecoach.js';

// The AI's read of a phone call against the office's protocol (PH3), the reason a caller didn't book (PH4) and the
// caller's mood (PH5). It only reports, with the transcript's own words for everything it relies on (the caller
// of this adapter drops any quote that isn't really in the transcript). Coaching only: nothing acts on it alone.
//   CALL_SCORE=sandbox (or config.callScore = 'sandbox'): a deterministic stand-in for demos and tests.
//   Otherwise Claude, when AI is on for the server (ANTHROPIC_API_KEY); off when it isn't.
const SYSTEM = `You review a phone call to a dental office for coaching, against the office's own phone protocol.
- Decide the kind of call: general, new_patient, emergency, scheduling or billing.
- For each protocol step, say whether the office staff member did it. If they did, quote their words exactly as they appear in the transcript (one sentence). If not, leave the quote empty.
- If the caller did not book a visit, give the main reason from their own words (cost, time, insurance, shopping, think, other) with an exact quote; leave it empty if they booked or it isn't a booking call.
- Say whether the caller sounded upset (angry, frustrated, threatening to leave or complain), with their exact words.
- Be fair and specific. This is for coaching, never discipline. One short plain summary sentence.`;

const TOOL = {
  name: 'review_call',
  description: 'How the call went against the office protocol, with quotes from the transcript.',
  input_schema: {
    type: 'object',
    properties: {
      call_type: { type: 'string', enum: CALL_TYPES },
      steps: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, met: { type: 'boolean' }, quote: { type: 'string', description: 'Exact words from the transcript' }, note: { type: 'string' } }, required: ['key', 'met'] } },
      no_book: { type: 'object', properties: { reason: { type: 'string', enum: [...Object.keys(NO_BOOK_REASONS), ''] }, quote: { type: 'string' } } },
      upset: { type: 'object', properties: { upset: { type: 'boolean' }, quote: { type: 'string' } }, required: ['upset'] },
      summary: { type: 'string' },
    },
    required: ['call_type', 'steps', 'upset', 'summary'],
  },
};

function sandboxScore({ transcript, callType, steps }) {
  const mood = detectUpset(transcript);
  const reason = suggestNoBookReason(transcript);
  return {
    call_type: callType || detectCallType(transcript),
    steps: sandboxStepResults(steps, transcript),
    no_book: reason.reason ? reason : null,
    upset: { upset: mood.upset, quote: mood.quote },
    summary: 'Scored by the sandbox reviewer (keyword matching), for demos and tests.',
  };
}

export function createCallScorer({ config = {}, mode } = {}) {
  mode ??= config.callScore || process.env.CALL_SCORE || (aiClient(config) ? 'claude' : null);
  if (mode === 'sandbox') return { mode, label: 'AI (sandbox)', score: async (input) => sandboxScore(input) };
  if (mode === 'claude' && aiClient(config)) {
    return {
      mode,
      label: 'Claude',
      async score({ transcript, callType, steps, philosophy }) {
        const out = await structured(config, {
          system: SYSTEM, tool: TOOL, effort: 'low', maxTokens: 4000,
          content: `The office's philosophy: ${philosophy || '(none written)'}\nLikely kind of call: ${callType}\n\nProtocol steps (key: what good looks like):\n${steps.map((st) => `- ${st.key}: ${st.label}${st.required ? ' (required)' : ''}`).join('\n')}\n\nTranscript ("Caller:" is the patient, "Office:" is the staff member):\n"""\n${String(transcript).slice(0, 40_000)}\n"""`,
        });
        return { call_type: out.call_type, steps: out.steps || [], no_book: out.no_book?.reason ? out.no_book : null, upset: out.upset || { upset: false }, summary: out.summary || null };
      },
    };
  }
  return null;
}
