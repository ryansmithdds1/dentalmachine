// Daily workflows, batch 4 (docs/workflows/specs/32-…44-*.md): the server pieces behind them.
// routes/daily.js is added inside the signed-in /api router until app.js mounts it (like the referral tracker).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import dailyRoutes from '../src/routes/daily.js';

// A clearinghouse the tests can switch between working, down and not set up (manual); the app uses it.
const ch = { name: 'Test clearinghouse', mode: 'sftp', sent: [], down: false, manual: false };
const batch = {
  transport: 'test',
  submit: async (file) => {
    if (ch.down) throw new Error('connection refused');
    ch.sent.push(file);
    return { reference: file.filename };
  },
};
Object.defineProperty(ch, 'batch', { get: () => (ch.manual ? null : batch) });
const h = harness({ clearinghouse: ch });
before(async () => {
  while (!h.origin) await new Promise((r) => setTimeout(r, 10));
  const has = (stack) => stack.some((l) => l.route?.path === '/daily/preauths/:aid/send' || (l.handle?.stack && has(l.handle.stack)));
  if (has(h.app.router.stack)) return;
  const api = h.app.router.stack.filter((l) => l.name === 'router' && l.handle?.stack).sort((a, b) => b.handle.stack.length - a.handle.stack.length)[0].handle;
  api.use(dailyRoutes({ db: h.db, config: h.config, clearinghouse: ch }));
});

async function login(api, role, name) {
  const email = `${role}${Math.random().toString(36).slice(2, 8)}@example.com`;
  const created = await api.post('/users', { name, email, password: 'correct-horse-battery', role });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return h.client((await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);
}
async function draftPreauth(api, patient, provider) {
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W123456', group_number: 'G1' })).data;
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '14', provider_id: provider.id })).data;
  const pa = await api.post('/preauths', { patient_insurance_id: policy.id, procedure_ids: [proc.id] });
  assert.equal(pa.status, 201, JSON.stringify(pa.data));
  return pa.data;
}

test('38 · a pre-authorization goes to the clearinghouse in one step, once, and is audited', async () => {
  const { api, patient, provider, practiceId } = await h.practice();
  const pa = await draftPreauth(api, patient, provider);
  const before = ch.sent.length;
  const sent = await api.post(`/daily/preauths/${pa.id}/send`);
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(sent.data.preauth.status, 'submitted');
  assert.equal(ch.sent.length, before + 1);
  const file = ch.sent.at(-1);
  assert.match(file.filename, new RegExp(`^DM${practiceId}_PD${pa.id}_\\d+\\.837$`));
  assert.match(file.content, /CLM\*PD\d+\*/);
  assert.match(file.content, /D2740/);
  // Asked again (double click, retry): nothing is sent twice.
  const again = await api.post(`/daily/preauths/${pa.id}/send`);
  assert.equal(again.status, 200);
  assert.equal(again.data.already_sent, true);
  assert.equal(ch.sent.length, before + 1);
  const audits = await h.db.all("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'preauth.submit'", practiceId);
  assert.equal(audits.length, 1);
  const log = await h.db.get("SELECT * FROM integration_log WHERE practice_id = ? AND operation = 'preauth.submit' ORDER BY id DESC", practiceId);
  assert.equal(log.ok, 1);
  assert.equal(log.external_id, file.filename);
});

test('38 · clearinghouse down: nothing changes, a Needs attention item is raised, and a later send clears it', async () => {
  const { api, patient, provider, practiceId } = await h.practice();
  const pa = await draftPreauth(api, patient, provider);
  ch.down = true;
  try {
    const failed = await api.post(`/daily/preauths/${pa.id}/send`);
    assert.equal(failed.status, 424);
    assert.match(failed.data.error, /Nothing was sent/);
  } finally {
    ch.down = false;
  }
  assert.equal((await h.db.get('SELECT status FROM preauths WHERE id = ?', pa.id)).status, 'draft');
  const issue = await h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ?", practiceId, `preauth-send:${pa.id}`);
  assert.equal(issue.status, 'open');
  assert.equal(issue.role, 'billing');
  const ok = await api.post(`/daily/preauths/${pa.id}/send`);
  assert.equal(ok.status, 201);
  assert.equal((await h.db.get('SELECT status FROM issues WHERE id = ?', issue.id)).status, 'resolved');
});

test('38 · no clearinghouse set up: 409 asking for the file; permissions and other practices refused', async () => {
  const { api, patient, provider } = await h.practice();
  const pa = await draftPreauth(api, patient, provider);
  ch.manual = true;
  try {
    const manual = await api.post(`/daily/preauths/${pa.id}/send`);
    assert.equal(manual.status, 409);
    assert.equal(manual.data.details?.download ?? manual.data.download, true, JSON.stringify(manual.data));
  } finally {
    ch.manual = false;
  }
  const hygienist = await login(api, 'hygienist', 'Hy Gienist');
  assert.equal((await hygienist.post(`/daily/preauths/${pa.id}/send`)).status, 403);
  const other = await h.practice();
  assert.equal((await other.api.post(`/daily/preauths/${pa.id}/send`)).status, 404);
  assert.equal((await h.client().post(`/daily/preauths/${pa.id}/send`)).status, 401);
  assert.equal((await h.db.get('SELECT status FROM preauths WHERE id = ?', pa.id)).status, 'draft');
});

test('43 · review requests sent are counted on the reputation page (they are saved as kind "review")', async () => {
  const { api, patient } = await h.practice({ review_url: 'https://g.page/r/example/review' });
  const before = (await api.get('/reputation')).data.summary.requests_sent_90;
  const ask = await api.post(`/patients/${patient.id}/review-request`, { source: 'chart' });
  assert.ok([200, 201].includes(ask.status), JSON.stringify(ask.data));
  const kind = await h.db.get('SELECT kind FROM messages WHERE patient_id = ? ORDER BY id DESC', patient.id);
  assert.equal(kind.kind, 'review');
  assert.equal((await api.get('/reputation')).data.summary.requests_sent_90, before + 1);
});

test('40 · an adjustment needs a reason, is audited, and is undone by a reversal (never deleted)', async () => {
  const { api, patient, practiceId } = await h.practice();
  assert.equal((await api.post(`/patients/${patient.id}/adjustments`, { amount: -1000 })).status, 400, 'no reason, no write-off');
  const adj = await api.post(`/patients/${patient.id}/adjustments`, { amount: -1000, description: 'Courtesy discount', adjustment_type: 'Courtesy discount' });
  assert.equal(adj.status, 201, JSON.stringify(adj.data));
  const undo = await api.post(`/ledger/${adj.data.entry.id}/void`, { reason: 'Undone right after posting' });
  assert.ok([200, 201].includes(undo.status), JSON.stringify(undo.data));
  const rows = await h.db.all("SELECT * FROM ledger_entries WHERE patient_id = ? AND type = 'adjustment' ORDER BY id", patient.id);
  assert.equal(rows.length, 2, 'the original stays, with its reversal');
  assert.ok(rows[0].voided_at);
  assert.equal(rows[1].reverses_id, rows[0].id);
  assert.equal(rows.reduce((s, r) => s + r.amount, 0), 0);
  assert.equal((await h.db.all("SELECT * FROM audit_log WHERE practice_id = ? AND action IN ('ledger.adjustment','ledger.void')", practiceId)).length, 2);
  // Hygienists can't write money off.
  const hygienist = await login(api, 'hygienist', 'Hy Gienist');
  assert.equal((await hygienist.post(`/patients/${patient.id}/adjustments`, { amount: -500, description: 'x' })).status, 403);
});

test('32 · a new patient typed in one line is split into the chart fields and the policy', async () => {
  const { parseNewPatient } = await import('../../client/src/components/newPatientLine.js');
  const carriers = [{ id: 7, name: 'Delta Dental' }, { id: 8, name: 'Cigna Dental' }, { id: 9, name: 'MetLife' }];
  const today = '2026-09-24';
  assert.deepEqual(parseNewPatient('jane doe 3/14/1985 512-555-0100 Jane@Example.com delta w123456789', { carriers, today }), {
    email: 'jane@example.com', dob: '1985-03-14', phone: '(512) 555-0100', carrier_id: 7, carrier_name: 'Delta Dental', subscriber_id: 'W123456789', first_name: 'Jane', last_name: 'Doe',
  });
  // "Last, First", an ISO date, no insurance: no member ID is guessed without a carrier.
  assert.deepEqual(parseNewPatient('McDonald, Mary Ann 1990-01-02 (512) 555 0101 A12345', { carriers, today }), {
    dob: '1990-01-02', phone: '(512) 555-0101', first_name: 'Mary Ann', last_name: 'McDonald',
  });
  // Impossible or future birth dates are left for the person to fix, not guessed.
  assert.equal(parseNewPatient('Tom Lee 2/30/1980', { carriers, today }).dob, undefined);
  assert.equal(parseNewPatient('Tom Lee 1/1/2030', { carriers, today }).dob, undefined);
  // Two-digit years: past century unless that would be in the future.
  assert.equal(parseNewPatient('Tom Lee 1/2/85', { carriers, today }).dob, '1985-01-02');
  assert.equal(parseNewPatient('Tom Lee 1/2/19', { carriers, today }).dob, '2019-01-02');
  assert.equal(parseNewPatient('Ann Smith cigna U99887766', { carriers, today }).carrier_id, 8);
  assert.deepEqual(parseNewPatient('', { carriers, today }), {});
});
