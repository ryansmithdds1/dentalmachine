import express, { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { requirePermission, HttpError, can, rateLimit } from '../auth.js';
import { hashToken, audit, practiceNow } from '../util.js';
import { requireAi } from '../ai.js';
import { DATA_TOOLS, toolByName } from '../datatools.js';

// "Ask your data": a question in plain words, answered by Claude from the practice's own numbers through the
// read-only data tools, as the person asking (a tool they couldn't open themselves isn't offered).
const MAX_TURNS = 8;
const SYSTEM = `You answer questions from a dental practice's staff about their own practice, using the tools to look things up. Today is {today} ({weekday}).
Look the numbers up; never guess or invent them. Money from tools is in cents: show dollars ($1,234). Keep answers short and direct: the answer first, then the few figures behind it. Say which dates the figures cover.
When a list or comparison helps, include one small markdown table. If the tools can't answer it, say what they can show instead.`;

export async function askData(db, config, { pid, allowed, question, history = [] }) {
  const { client, cfg } = requireAi(config);
  const tools = DATA_TOOLS.filter((t) => allowed(t));
  if (!tools.length) throw new HttpError(403, 'You don’t have access to any of the practice’s numbers');
  const now = await practiceNow(db, pid);
  const today = now.slice(0, 10);
  const weekday = new Date(`${today}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const messages = [...history.slice(-6).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) })), { role: 'user', content: question }];
  const used = [];
  let usage = { input_tokens: 0, output_tokens: 0 };
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response;
    try {
      response = await client.messages.create({
        model: cfg.model, max_tokens: 8000, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
        system: SYSTEM.replace('{today}', today).replace('{weekday}', weekday),
        tools: tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
        messages,
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The AI is busy — try again in a moment');
      if (err instanceof Anthropic.APIError) throw new HttpError(502, 'The AI isn’t reachable right now');
      throw err;
    }
    usage = { input_tokens: usage.input_tokens + (response.usage?.input_tokens || 0), output_tokens: usage.output_tokens + (response.usage?.output_tokens || 0) };
    if (response.stop_reason === 'refusal') throw new HttpError(422, 'The AI declined to answer that');
    const calls = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !calls.length) {
      const answer = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { answer: answer || 'I couldn’t find an answer to that.', tools: used, usage };
    }
    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.name);
      try {
        if (!tool) throw new HttpError(403, 'That tool isn’t available');
        const out = await tool.run(db, pid, call.input || {});
        used.push({ name: call.name, input: call.input });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out).slice(0, 60_000) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: err.message || 'That lookup failed', is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'That took more lookups than I’m allowed — try a narrower question.', tools: used, usage };
}

export default function askRoutes({ db, config }) {
  const r = Router();
  const limiter = rateLimit({ windowMs: 60_000, max: 20, name: 'ask' });
  r.get('/ask', requirePermission('reports:read'), (req, res) => {
    res.json({ enabled: !!(config.assistant || {}).enabled, tools: DATA_TOOLS.filter((t) => can(req.user, t.permission)).map((t) => t.name) });
  });
  r.post('/ask', limiter, requirePermission('reports:read'), async (req, res) => {
    const question = String(req.body?.question || '').trim().slice(0, 2000);
    if (!question) throw new HttpError(400, 'Ask a question');
    const out = await askData(db, config, { pid: req.user.practice_id, allowed: (t) => can(req.user, t.permission), question, history: Array.isArray(req.body.history) ? req.body.history : [] });
    // The question and which lookups ran; the answer itself isn't kept.
    await audit(db, req, 'ask.question', 'practices', req.user.practice_id, { question: question.slice(0, 300), tools: out.tools.map((t) => t.name) });
    res.json(out);
  });
  return r;
}

// MCP (Model Context Protocol) server, so an outside AI app (Claude Desktop, Claude Code, others) can use the
// same read-only tools with an API key: POST /mcp, JSON-RPC 2.0 over Streamable HTTP (JSON responses).
// Each tool needs its scope on the key.
const PROTOCOL = '2025-06-18';
export function mcpRoutes({ db }) {
  const r = Router();
  r.use(express.json({ limit: '256kb' }));
  const limiter = rateLimit({ windowMs: 60_000, max: 300, name: 'mcp' });
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  r.get('/', (_req, res) => res.status(405).set('Allow', 'POST').json(rpcError(null, -32000, 'Use POST')));
  r.delete('/', (_req, res) => res.status(405).end());
  r.post('/', limiter, async (req, res) => {
    const h = String(req.headers.authorization || '');
    const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    const k = key.startsWith('dm_live_') ? await db.get('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', hashToken(key)) : null;
    if (!k) return res.status(401).set('WWW-Authenticate', 'Bearer').json(rpcError(req.body?.id, -32001, 'Send an API key from Settings → API & webhooks: Authorization: Bearer dm_live_…'));
    const scopes = JSON.parse(k.scopes);
    const tools = DATA_TOOLS.filter((t) => scopes.includes(t.scope));
    await db.run("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?", k.id);

    const handle = async (msg) => {
      if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid request');
      const isNotice = msg.id === undefined;
      const reply = (result) => (isNotice ? null : { jsonrpc: '2.0', id: msg.id, result });
      switch (msg.method) {
        case 'initialize': {
          const practice = await db.get('SELECT name FROM practices WHERE id = ?', k.practice_id);
          return reply({
            protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'dental-machine', title: `Dental Machine — ${practice.name}`, version: '1.0.0' },
            instructions: `Read-only access to ${practice.name}'s practice data. Money values are in cents.`,
          });
        }
        case 'notifications/initialized': case 'notifications/cancelled': return null;
        case 'ping': return reply({});
        case 'tools/list':
          return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema, annotations: { readOnlyHint: true, openWorldHint: false } })) });
        case 'tools/call': {
          const tool = tools.find((t) => t.name === msg.params?.name);
          if (!tool) return rpcError(msg.id, -32602, toolByName(msg.params?.name) ? `This key doesn't have the ${toolByName(msg.params.name).scope} scope` : 'Unknown tool');
          try {
            const out = await tool.run(db, k.practice_id, msg.params.arguments || {});
            await audit(db, { user: { id: null, practice_id: k.practice_id, role: 'api', name: `MCP: ${k.name}` }, ip: req.ip, headers: req.headers }, 'mcp.tool', 'api_keys', k.id, { tool: tool.name });
            return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false });
          } catch (err) {
            return reply({ content: [{ type: 'text', text: err.message || 'That lookup failed' }], isError: true });
          }
        }
        default:
          return isNotice ? null : rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    };
    const batch = Array.isArray(req.body);
    const out = (await Promise.all((batch ? req.body : [req.body]).map(handle))).filter(Boolean);
    if (!out.length) return res.status(202).end();
    res.json(batch ? out : out[0]);
  });
  return r;
}
