import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { harness } from './helpers.js';

// A stand-in for the Anthropic API that plays back a queue of replies.
const seen = [];
const queue = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push(JSON.parse(body));
    const content = queue.shift();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 }, content }));
  });
});
await new Promise((r) => fake.listen(0, r));
after(() => fake.close());

const h = harness({ config: { assistant: { enabled: true, apiKey: 'k', baseURL: `http://127.0.0.1:${fake.address().port}`, model: 'claude-opus-5-5', effort: 'low' } } });

test('ask your data: Claude looks the numbers up with the tools the person may use, then answers', async () => {
  const { api, patient, provider } = await h.practice();
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true });
  queue.push(
    [{ type: 'tool_use', id: 'tu_1', name: 'practice_numbers', input: {} }, { type: 'tool_use', id: 'tu_2', name: 'find_patients', input: { query: 'jane' } }],
    [{ type: 'text', text: 'Production was **$1,000** over the last 30 days.' }],
  );
  const res = await api.post('/ask', { question: 'How much did we produce this month?' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.match(res.data.answer, /Production was/);
  assert.deepEqual(res.data.tools.map((t) => t.name), ['practice_numbers', 'find_patients']);
  // The second request carried the looked-up numbers back.
  const results = seen.at(-1).messages.at(-1).content;
  const numbers = JSON.parse(results[0].content);
  assert.ok(numbers.production > 0);
  assert.equal(numbers.completed_visits, 0);
  assert.match(results[1].content, /"first_name":"Jane"/);
  assert.ok(seen.at(-1).tools.some((t) => t.name === 'run_report'));
  assert.match(seen.at(-1).system, /Today is \d{4}-\d{2}-\d{2}/);
  // Logged: the question and the lookups, not the answer.
  const log = await h.db.get("SELECT details FROM audit_log WHERE action = 'ask.question' ORDER BY id DESC");
  assert.match(log.details, /How much did we produce/);
  assert.doesNotMatch(log.details, /\$1,000/);

  // A bad tool call comes back to Claude as an error, not a failure.
  queue.push([{ type: 'tool_use', id: 'tu_3', name: 'run_report', input: { dataset: 'nope' } }], [{ type: 'text', text: 'Sorry.' }]);
  assert.equal((await api.post('/ask', { question: 'x' })).data.answer, 'Sorry.');
  assert.equal(seen.at(-1).messages.at(-1).content[0].is_error, true);
  assert.equal((await api.post('/ask', { question: ' ' })).status, 400);
});

test('MCP server: an API key sees only the tools its scopes allow; the protocol handshake, calls and errors', async () => {
  const { api } = await h.practice();
  const key = (await api.post('/api-keys', { name: 'Claude Desktop', scopes: ['patients:read', 'reports:read'] })).data.key;
  const rpc = (body, k = key) => fetch(`${h.origin}/api/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(k ? { Authorization: `Bearer ${k}` } : {}) }, body: JSON.stringify(body) });

  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, null)).status, 401);
  const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

  const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('find_patients') && names.includes('run_report') && names.includes('practice_numbers'));
  assert.ok(!names.includes('business_costs') && !names.includes('schedule_for_day'), 'no finance or appointments scope');
  assert.equal(list.result.tools[0].annotations.readOnlyHint, true);

  const found = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'find_patients', arguments: { query: 'Jane' } } })).json();
  assert.equal(found.result.isError, false);
  assert.equal(found.result.structuredContent.patients[0].first_name, 'Jane');
  const report = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'run_report', arguments: { dataset: 'patients', group_by: 'status' } } })).json();
  assert.deepEqual(report.result.structuredContent.rows, [['active', 1]]);
  const bad = await (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_report', arguments: { dataset: 'nope' } } })).json();
  assert.equal(bad.result.isError, true);
  const denied = await (await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'business_costs', arguments: {} } })).json();
  assert.match(denied.error.message, /finance:read scope/);
  const batch = await (await rpc([{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', id: 8, method: 'nope' }])).json();
  assert.deepEqual([batch[0].result, batch[1].error.code], [{}, -32601]);

  // Another practice's key never sees this one.
  const other = await h.practice();
  const theirs = (await other.api.post('/api-keys', { name: 'x', scopes: ['patients:read'] })).data.key;
  const none = await (await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'find_patients', arguments: { query: 'Jane' } } }, theirs)).json();
  assert.ok(none.result.structuredContent.patients.every((p) => p.id !== found.result.structuredContent.patients[0].id));
});
