import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from './auth.js';
import { assistantConfig } from './routes/assistant.js';

// One place for the single-shot Claude calls (the scribe, reading documents, answering questions about the
// practice's numbers): the same key and model as the assistant, and plain errors for the office.
let cached = null;
export function aiClient(config) {
  const cfg = config.assistant || assistantConfig();
  if (!cfg.enabled) return null;
  if (!cached || cached.key !== `${cfg.apiKey}|${cfg.baseURL}`) {
    cached = { key: `${cfg.apiKey}|${cfg.baseURL}`, client: new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 2, timeout: 120_000 }) };
  }
  return { client: cached.client, cfg };
}

export function requireAi(config) {
  const ai = aiClient(config);
  if (!ai) throw new HttpError(503, 'AI features are off on this server (ANTHROPIC_API_KEY is not set)');
  return ai;
}

// Asks Claude to answer by calling one tool (its input is the structured answer). Opus 5.5 doesn't take a
// forced tool choice, so the instructions ask for it and a text-only answer comes back as { text }.
export async function structured(config, { system, content, tool, effort, maxTokens = 8000 }) {
  const { client, cfg } = requireAi(config);
  let response;
  try {
    response = await client.messages.create({
      model: cfg.model,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: effort || cfg.effort },
      system: `${system}\n\nAnswer by calling the ${tool.name} tool once.`,
      tools: [tool],
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The AI is busy — try again in a moment');
    if (err instanceof Anthropic.AuthenticationError) throw new HttpError(503, 'The AI key was rejected');
    if (err instanceof Anthropic.BadRequestError) throw new HttpError(400, `The AI couldn’t read that: ${err.message}`.slice(0, 300));
    if (err instanceof Anthropic.APIError) throw new HttpError(502, 'The AI isn’t reachable right now');
    throw err;
  }
  if (response.stop_reason === 'refusal') throw new HttpError(422, 'The AI declined to answer that');
  const use = response.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return use ? { ...use.input, _usage: response.usage } : { text, _usage: response.usage };
}
