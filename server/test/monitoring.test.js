import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { createLogger, createErrorReporter, parseDsn } from '../src/monitoring.js';

const reports = [];
const h = harness({ config: { reporter: { enabled: true, capture: (err, ctx) => { reports.push({ err, ctx }); return 'evt'; } } } });

test('structured logs: one JSON line per event with fields, errors carry their stack', () => {
  const lines = [];
  const log = createLogger({ format: 'json', level: 'info', write: (_lvl, line) => lines.push(JSON.parse(line)) });
  log.debug('hidden');
  log.info('Sent reminders', { count: 3 });
  log.error('Backup failed:', new Error('disk full'));
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[0].level, lines[0].msg, lines[0].count], ['info', 'Sent reminders', 3]);
  assert.equal(lines[1].error, 'disk full');
  assert.match(lines[1].stack, /disk full/);
  assert.ok(lines[1].time);
});

test('error reports: Sentry envelope to the DSN endpoint, rate limited and de-duplicated', async () => {
  assert.deepEqual(parseDsn('https://abc123@o1.ingest.sentry.io/4507'), { key: 'abc123', endpoint: 'https://o1.ingest.sentry.io/api/4507/envelope/', dsn: 'https://abc123@o1.ingest.sentry.io/4507' });
  assert.equal(parseDsn('nonsense'), null);
  const sent = [];
  const reporter = createErrorReporter({ dsn: 'https://abc123@errors.example.com/7', environment: 'test', fetchImpl: async (url, opts) => { sent.push({ url, opts }); return { ok: true }; }, logger: createLogger({ write: () => {} }) });
  assert.equal(reporter.enabled, true);
  const err = new Error('boom');
  assert.ok(reporter.capture(err, { tags: { route: '/api/x', practice_id: 4 }, user: { id: '9' } }));
  assert.equal(reporter.capture(err, { tags: { route: '/api/x' } }), null, 'the same error again within a minute is dropped');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://errors.example.com/api/7/envelope/');
  assert.match(sent[0].opts.headers['X-Sentry-Auth'], /sentry_key=abc123/);
  const [, itemHeader, payload] = sent[0].opts.body.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(itemHeader.type, 'event');
  assert.equal(payload.exception.values[0].value, 'boom');
  assert.ok(payload.exception.values[0].stacktrace.frames.length > 0);
  assert.deepEqual(payload.tags, { route: '/api/x', practice_id: '4' });
  assert.equal(payload.environment, 'test');
  for (let i = 0; i < 40; i++) reporter.capture(new Error(`e${i}`));
  assert.equal(sent.length, 30, 'at most 30 a minute');
  assert.equal(createErrorReporter({ dsn: null }).capture(err), null, 'off without a DSN');
});

test('unexpected errors: 500 with a request id, logged and reported without request data', async () => {
  const { api, patient } = await h.practice();
  const ok = await fetch(`${h.origin}/api/health`, { headers: { 'X-Request-Id': 'req-12345678' } });
  assert.equal(ok.headers.get('x-request-id'), 'req-12345678');

  const all = h.db.all;
  h.db.all = async () => { throw new Error('database went away'); };
  let res;
  try { res = await api.get(`/patients/${patient.id}/documents`); } finally { h.db.all = all; }
  assert.equal(res.status, 500);
  assert.equal(res.data.error, 'Internal server error');
  assert.ok(res.data.request_id);
  const r = reports.at(-1);
  assert.equal(r.err.message, 'database went away');
  assert.equal(r.ctx.tags.route, '/patients/:id/documents');
  assert.equal(r.ctx.tags.request_id, res.data.request_id);
  assert.ok(r.ctx.tags.practice_id);
  assert.ok(!JSON.stringify(r.ctx).includes('Jane'), 'no patient details');

  // Errors from the browser are passed on (message, stack, page with ids masked).
  const before = reports.length;
  const c = await fetch(`${h.origin}/api/client-errors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'TypeError', message: 'x is undefined', stack: 'TypeError: x is undefined\n    at render (app.js:1:2)', path: `/patients/${patient.id}?tab=ledger` }) });
  assert.equal(c.status, 202);
  assert.equal(reports.length, before + 1);
  assert.equal(reports.at(-1).ctx.tags.route, '/patients/:id');
  assert.equal(reports.at(-1).ctx.platform, 'javascript');
  assert.equal((await fetch(`${h.origin}/api/client-errors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
});
