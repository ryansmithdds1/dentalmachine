// Fee schedules FS1–FS3: % increases (now or scheduled), payer schedule imports (draft → a person approves),
// versions that are never overwritten, and estimates/claims priced from the version in effect on the date of service.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { harness } from './helpers.js';
import { PERMISSION_CATALOG } from '../src/auth.js';
import { roundFee, increaseFee, resolveFee, ensureBaseline } from '../src/feeversions.js';
import { createFeeReader, parseXlsx, rowsToItems, runFeeSchedules } from '../src/feeimport.js';
import { buildZip } from '../src/zip.js';
import { zonedToUtc } from '../src/util.js';
import { MIGRATIONS } from '../src/migrations.js';
import feeScheduleRoutes from '../src/routes/feeschedules.js';

// Until auth.js lists it (see the hand-off notes), the catalog entry is added here so a non-admin can be granted it.
if (!('fees:manage' in PERMISSION_CATALOG)) PERMISSION_CATALOG['fees:manage'] = 'Change fees: increases, fee schedule imports and approvals';

// A stand-in for the Anthropic API: answers with the fee_schedule tool call the test sets.
const seen = [];
let reply = null;
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'toolu_1', name: 'fee_schedule', input: reply }] }));
  });
});
await new Promise((r) => fake.listen(0, r));
after(() => fake.close());

const h = harness({ config: { ediMode: 'manual', assistant: { enabled: true, apiKey: 'k', baseURL: `http://127.0.0.1:${fake.address().port}`, model: 'claude-opus-5-5', effort: 'low' } } });
// Until app.js mounts the routes (see the hand-off notes), they're attached the way app.js will: inside the
// signed-in /api router, so sign-in, the actor, the AI guard and idempotency all apply as in production.
before(async () => {
  while (!h.origin) await new Promise((r) => setTimeout(r, 10));
  const has = (stack) => stack.some((l) => l.route?.path === '/fees/schedules' || (l.handle?.stack && has(l.handle.stack)));
  if (has(h.app.router.stack)) return;
  const api = h.app.router.stack.filter((l) => l.name === 'router' && l.handle?.stack).sort((a, b) => b.handle.stack.length - a.handle.stack.length)[0].handle;
  api.use(feeScheduleRoutes({ db: h.db, config: h.config }));
});
const DAY = 86400_000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => ymd(Date.parse(`${d}T12:00:00Z`) + n * DAY);
const localToday = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const person = async (api, role, extra = {}) => {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = (await api.post('/users', { email, name: `${role} person`, role, password: 'a-long-password-1', ...extra })).data;
  const token = (await h.client().post('/auth/login', { email, password: 'a-long-password-1' })).data.token;
  return { ...u, api: h.client(token), assistant: h.client(token, { 'X-Acting-For': 'assistant' }), approved: h.client(token, { 'X-Acting-For': 'assistant', 'X-Human-Approved': '1' }) };
};
const stdFee = async (practiceId, code) => (await h.db.get('SELECT fee FROM procedure_codes WHERE practice_id = ? AND code = ?', practiceId, code)).fee;
const ppo = async (api, name, items, carrierIds = []) => {
  const fs = (await api.post('/fee-schedules', { name, kind: 'ppo' })).data;
  const put = await api.put(`/fee-schedules/${fs.id}`, { items: Object.entries(items).map(([code, fee]) => ({ code, fee })), carrier_ids: carrierIds });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  return fs;
};
const completed = async ({ practiceId, patient, provider }, code, date, fee) => {
  const c = await h.db.get('SELECT id, description, category FROM procedure_codes WHERE practice_id = ? AND code = ?', practiceId, code);
  return (await h.db.get(
    "INSERT INTO procedures (practice_id, patient_id, provider_id, code_id, code, description, category, fee, status, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?) RETURNING id",
    practiceId, patient.id, provider.id, c.id, code, c.description, c.category, fee, `${date} 10:00:00`,
  )).id;
};

test('rounding: to the cent, nearest $1, nearest $5, up to .00 and up to .99', () => {
  // $99.25 + 5% = $104.2125 → 10421 cents.
  assert.equal(increaseFee(9925, 5, 'none'), 10421);
  assert.equal(increaseFee(9925, 5, 'dollar'), 10400);
  assert.equal(increaseFee(9925, 5, 'five'), 10500);
  assert.equal(increaseFee(9925, 5, 'up00'), 10500);
  assert.equal(increaseFee(9925, 5, 'up99'), 10499);
  assert.equal(roundFee(10499, 'up99'), 10499, 'already .99 stays');
  assert.equal(roundFee(10500, 'up00'), 10500, 'already whole stays');
  assert.equal(increaseFee(0, 5, 'five'), 0, 'a zero fee stays zero');
  assert.equal(increaseFee(10000, -10, 'none'), 9000, 'a decrease works the same way');
});

test('preview: old vs new by scope (category / codes / exclude) with the impact of the last 12 months', async () => {
  const ctx = await h.practice();
  const { api, practiceId } = ctx;
  const today = localToday('America/New_York');
  for (const d of [10, 40, 200]) await completed(ctx, 'D0120', addDays(today, -d), 5000);
  await completed(ctx, 'D0120', addDays(today, -500), 5000); // more than a year ago: not counted
  await completed(ctx, 'D1110', addDays(today, -30), 9000);

  const bad = await api.post('/fees/increase/preview', { percent: 0 });
  assert.equal(bad.status, 400);
  assert.equal((await api.post('/fees/increase/preview', { percent: 5, rounding: 'weird' })).status, 400);
  assert.equal((await api.post('/fees/increase/preview', { percent: 5, scope: { mode: 'codes', codes: ['X1'] } })).status, 400);

  const d0120 = await stdFee(practiceId, 'D0120');
  const one = (await api.post('/fees/increase/preview', { percent: 10, rounding: 'dollar', scope: { mode: 'codes', codes: ['D0120'] } })).data;
  const p = one.previews[0];
  assert.equal(p.schedule.name, 'Standard office fees');
  assert.deepEqual(p.rows.map((r) => r.code), ['D0120']);
  const next = Math.round((d0120 * 1.1) / 100) * 100;
  assert.equal(p.rows[0].new_fee, next);
  assert.equal(p.rows[0].used_12m, 3);
  assert.equal(p.summary.impact_12m, 3 * (next - d0120));
  assert.equal(one.totals.impact_12m, 3 * (next - d0120));

  const cat = (await api.post('/fees/increase/preview', { percent: 5, scope: { mode: 'categories', categories: ['preventive'], exclude: ['D1110'] } })).data.previews[0];
  const cats = await h.db.all("SELECT code FROM procedure_codes WHERE practice_id = ? AND category = 'preventive' AND code != 'D1110' AND fee > 0", practiceId);
  assert.equal(cat.summary.changed, cats.length);
  assert.ok(!cat.rows.some((r) => r.code === 'D1110'), 'excluded code left out');
  const prefix = (await api.post('/fees/increase/preview', { percent: 5, scope: { mode: 'codes', codes: ['D27*'] } })).data.previews[0];
  assert.ok(prefix.rows.length > 0 && prefix.rows.every((r) => r.code.startsWith('D27')), 'prefix D27* = all crowns');
  // Nothing was changed by previewing.
  assert.equal(await stdFee(practiceId, 'D0120'), d0120);
});

test('a scheduled 5% increase applies once at the practice’s local midnight, records who scheduled it, and can be edited or cancelled before', async () => {
  const tz = 'America/Los_Angeles';
  const ctx = await h.practice({ timezone: tz });
  const { api, practiceId } = ctx;
  const eff = addDays(localToday(tz), 10);
  const d2740 = await stdFee(practiceId, 'D2740');
  assert.equal((await api.post('/fees/increases', { percent: 5, rounding: 'none', effective_date: addDays(localToday(tz), -1) })).status, 400, 'no increases in the past');
  const made = await api.post('/fees/increases', { percent: 5, rounding: 'none', scope: { mode: 'codes', codes: ['D2740', 'D0120'] }, effective_date: eff, note: 'Annual increase' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.applied, false);
  const change = made.data.changes[0];
  assert.equal(change.status, 'scheduled');
  assert.equal(await stdFee(practiceId, 'D2740'), d2740, 'nothing changes until the date');
  assert.deepEqual((await api.get('/fees/changes')).data.map((c) => c.id), [change.id]);

  // Edited while scheduled: 5% → 10%, recomputed.
  const edited = await api.put(`/fees/changes/${change.id}`, { percent: 10 });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.items.find((i) => i.code === 'D2740').new_fee, Math.round(d2740 * 1.1));
  // And a second one, cancelled.
  const other = (await api.post('/fees/increases', { percent: 3, scope: { mode: 'codes', codes: ['D1110'] }, effective_date: eff })).data.changes[0];
  const cancelled = await api.post(`/fees/changes/${other.id}/cancel`, { reason: 'Changed our mind' });
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal((await api.put(`/fees/changes/${other.id}`, { percent: 4 })).status, 409, 'a cancelled change can’t be edited');
  const d1110 = await stdFee(practiceId, 'D1110');

  // One minute before local midnight: not yet. One minute after: applied. Again: nothing more.
  const midnight = Date.parse(`${zonedToUtc(tz, eff).replace(' ', 'T')}Z`);
  let r = await runFeeSchedules(h.db, { config: h.config, now: new Date(midnight - 60_000) });
  assert.ok(!r.applied.some((a) => a.id === change.id));
  assert.equal(await stdFee(practiceId, 'D2740'), d2740);
  r = await runFeeSchedules(h.db, { config: h.config, now: new Date(midnight + 60_000) });
  assert.ok(r.applied.some((a) => a.id === change.id));
  r = await runFeeSchedules(h.db, { config: h.config, now: new Date(midnight + 120_000) });
  assert.ok(!r.applied.some((a) => a.id === change.id), 'applied exactly once');
  assert.equal(await stdFee(practiceId, 'D2740'), Math.round(d2740 * 1.1));
  assert.equal(await stdFee(practiceId, 'D1110'), d1110, 'the cancelled change never applied');

  const done = (await api.get(`/fees/changes/${change.id}`)).data;
  assert.equal(done.status, 'applied');
  assert.ok(done.applied_version_id);
  assert.equal(done.created_by_name, 'Admin');
  assert.equal(done.approved_by_name, 'Admin');
  const versions = (await api.get('/fees/schedules/standard/versions')).data.versions;
  assert.deepEqual(versions.map((v) => [v.version_no, v.effective_from, v.source]), [[2, eff, 'increase +10%'], [1, '1900-01-01', 'baseline']]);
  assert.equal(versions[0].created_by_name, 'Admin');
  assert.equal(versions[0].approved_by_name, 'Admin');
  // Who and what: the job's audit entry carries before → after per code and the approver.
  const a = await h.db.get("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'fee_schedule.version_applied' ORDER BY id DESC LIMIT 1", practiceId);
  assert.equal(a.source, 'automation');
  assert.deepEqual(JSON.parse(a.changes).D2740, [d2740, Math.round(d2740 * 1.1)]);
  assert.equal(JSON.parse(a.details).approved_by, ctx.provider && (await h.db.get('SELECT id FROM users WHERE practice_id = ? AND role = ?', practiceId, 'admin')).id);
  const sched = await h.db.get("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'fee_change.scheduled' ORDER BY id LIMIT 1", practiceId);
  assert.equal(sched.source, 'human');
  assert.ok(sched.user_id);
  // "Last updated" on the schedule list.
  const list = (await api.get('/fees/schedules')).data;
  assert.equal(list[0].key, 'standard');
  assert.ok(list[0].last_updated_at);
  assert.equal(list[0].current_version.version_no, 2);
});

test('apply now: an increase effective today changes the fees straight away (and a repeat with the same key is safe)', async () => {
  const ctx = await h.practice();
  const { practiceId, token } = ctx;
  const before = await stdFee(practiceId, 'D0140');
  const api = h.client(token, { 'Idempotency-Key': 'raise-d0140-once' });
  const body = { percent: 4, rounding: 'up00', scope: { mode: 'codes', codes: ['D0140'] } };
  const first = await api.post('/fees/increases', body);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.applied, true);
  const again = await api.post('/fees/increases', body);
  assert.equal(again.data.changes[0].id, first.data.changes[0].id, 'the repeat returns the first answer');
  assert.equal(await stdFee(practiceId, 'D0140'), Math.ceil((before * 1.04) / 100) * 100);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM fee_changes WHERE practice_id = ? AND kind = 'increase'", practiceId)).n, 1);
});

test('import: a CSV becomes a draft with new / changed / missing / suspicious lines; nothing changes until someone with fees:manage approves', async () => {
  const ctx = await h.practice();
  const { api, practiceId } = ctx;
  const fs = await ppo(api, 'Delta PPO', { D0120: 4000, D1110: 7000, D2740: 90000 });
  const ucr0150 = await stdFee(practiceId, 'D0150');
  const ucr0140 = await stdFee(practiceId, 'D0140');
  const csv = ['Delta Dental PPO — 2027 maximum plan allowances', 'Code,Description,Fee',
    'D0120,Periodic oral evaluation,$42.00', 'D1110,Prophylaxis - adult,70.00',
    `D0150,Comprehensive evaluation,${((ucr0150 * 4) / 100).toFixed(2)}`, `D0140,Limited evaluation,${((ucr0140 / 4) / 100).toFixed(2)}`,
    'D9999,Unknown thing,10.00', 'X123,not a code,5.00'].join('\n');
  const up = await api.post('/fees/imports', { fee_schedule_id: fs.id, text: csv, file_name: 'delta-2027.csv' });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const d = up.data;
  assert.equal(d.status, 'draft');
  assert.equal(d.reader, 'csv');
  const by = Object.fromEntries(d.items.map((i) => [i.code, i]));
  assert.deepEqual([by.D0120.flag, by.D0120.change, by.D0120.pct], ['changed', 200, 5]);
  assert.equal(by.D1110.flag, 'same');
  assert.deepEqual([by.D0150.flag, by.D0150.warn], ['new', 'high'], 'over 3× the office fee');
  assert.deepEqual([by.D0140.flag, by.D0140.warn], ['new', 'low'], 'under a third of the office fee');
  assert.equal(by.D9999.warn, 'unknown_code');
  assert.deepEqual([by.D2740.flag, by.D2740.new_fee], ['missing', null]);
  assert.ok(!by.X123, 'not a CDT code: skipped');
  assert.deepEqual([d.summary.changed, d.summary.new, d.summary.missing, d.summary.suspicious], [1, 3, 1, 2]);
  const live = async (code) => (await h.db.get('SELECT fee FROM fee_schedule_items WHERE fee_schedule_id = ? AND code = ?', fs.id, code))?.fee;
  assert.equal(await live('D0120'), 4000, 'a draft changes nothing');
  // The same file again is the same draft.
  const dup = await api.post('/fees/imports', { fee_schedule_id: fs.id, text: csv, file_name: 'delta-2027.csv' });
  assert.equal(dup.data.id, d.id);
  assert.equal(dup.data.duplicate, true);

  // Billing staff can upload, not approve; the assistant needs the person's OK.
  const billing = await person(api, 'billing');
  assert.equal((await billing.api.post(`/fees/changes/${d.id}/approve`, {})).status, 403);
  const mgr = await person(api, 'billing', { permissions_add: ['fees:manage'] });
  const asked = await mgr.assistant.post(`/fees/changes/${d.id}/approve`, {});
  assert.equal(asked.status, 428);
  assert.equal(asked.data.needs_approval, true);
  const ok = await mgr.approved.post(`/fees/changes/${d.id}/approve`, { skip_codes: ['D0150', 'D9999'], note: 'Checked against the contract' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, 'applied');
  assert.equal(ok.data.applied_now, true);
  assert.equal(ok.data.approved_by_name, mgr.name);
  assert.equal(await live('D0120'), 4200);
  assert.equal(await live('D0140'), Math.round(ucr0140 / 4));
  assert.equal(await live('D0150'), undefined, 'left out by the person');
  assert.equal(await live('D2740'), 90000, 'missing codes are kept unless the person chose to drop them');
  const aud = await h.db.get("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'fee_import.approved'", practiceId);
  assert.equal(aud.source, 'ai', 'the assistant carried it');
  assert.match(aud.actor, /approved by/);
  assert.equal((await api.post(`/fees/changes/${d.id}/approve`, {})).status, 409, 'approved once');
});

test('XLSX spreadsheets are read without extra libraries; the sandbox reader picks lines out of a PDF', async () => {
  const shared = '<sst><si><t>CDT Code</t></si><si><t>Allowed</t></si><si><t>D0120</t></si><si><t>D1110</t></si></sst>';
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>41.5</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>77</v></c></row></sheetData></worksheet>';
  const xlsx = buildZip([{ name: 'xl/sharedStrings.xml', data: shared }, { name: 'xl/worksheets/sheet1.xml', data: sheet }]);
  assert.deepEqual(rowsToItems(parseXlsx(xlsx)).items, [{ code: 'D0120', fee: 4150 }, { code: 'D1110', fee: 7700 }]);

  const reader = createFeeReader({ config: { feeReader: 'sandbox' } });
  assert.equal(reader.mode, 'sandbox');
  const pdf = Buffer.from('%PDF-1.4\nAcme PPO fee schedule, effective 2027-01-01\nD0120 Periodic eval $38.00\nD2740 Crown porcelain 812.50\n').toString('base64');
  const out = await reader.read({ base64: pdf, mime: 'application/pdf', name: 'acme.pdf' });
  assert.equal(out.reader, 'sandbox');
  assert.deepEqual(out.items, [{ code: 'D0120', fee: 3800 }, { code: 'D2740', fee: 81250 }]);
  assert.equal(out.effective_date, '2027-01-01');
  const off = createFeeReader({ config: { ediMode: 'manual' } });
  await assert.rejects(off.read({ base64: pdf, mime: 'application/pdf' }), /needs the AI/);
});

test('a PDF is read by the AI into a draft (recorded as the AI’s reading, with its reason) — never applied by it', async () => {
  const ctx = await h.practice();
  const { api, practiceId } = ctx;
  const fs = await ppo(api, 'MetLife PDP', { D0120: 3500 });
  reply = { payer_name: 'MetLife', effective_date: '2027-01-01', items: [{ code: 'd0120', fee: 36.5 }, { code: 'D1110', fee: 71 }], unreadable: ['D4910 row smudged'] };
  const pdf = Buffer.from('%PDF-1.4 fee schedule').toString('base64');
  const up = await api.post('/fees/imports', { fee_schedule_id: fs.id, file_base64: pdf, mime: 'application/pdf', file_name: 'metlife.pdf' });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(seen.at(-1).tools[0].name, 'fee_schedule');
  assert.equal(seen.at(-1).messages[0].content[0].type, 'document');
  assert.equal(up.data.reader, 'ai');
  assert.equal(up.data.effective_date, '2027-01-01', 'the date printed on the schedule');
  assert.match(up.data.ai_reason, /AI read 2 codes/);
  assert.ok(up.data.summary.warnings.some((w) => /D4910/.test(w)));
  assert.deepEqual(up.data.items.map((i) => [i.code, i.flag, i.new_fee]), [['D0120', 'changed', 3650], ['D1110', 'new', 7100]]);
  const a = await h.db.get("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'fee_import.draft'", practiceId);
  assert.equal(a.source, 'ai');
  assert.match(a.reason, /AI read/);
  assert.equal((await h.db.get('SELECT fee FROM fee_schedule_items WHERE fee_schedule_id = ? AND code = ?', fs.id, 'D0120')).fee, 3500, 'still the old fee');
  // Approved for its future date: scheduled, not live yet.
  const ok = await api.post(`/fees/changes/${up.data.id}/approve`, {});
  assert.equal(ok.data.status, 'scheduled');
  assert.equal((await h.db.get('SELECT fee FROM fee_schedule_items WHERE fee_schedule_id = ? AND code = ?', fs.id, 'D0120')).fee, 3500);
});

test('a schedule’s inbox: the job reads files into drafts awaiting approval (in Needs attention), never applies them, and a bad file becomes a work item', async () => {
  const ctx = await h.practice();
  const { api, practiceId } = ctx;
  const fs = await ppo(api, 'Cigna DPPO', { D0120: 3000 });
  const put = await api.post(`/fees/inbox/${fs.id}`, { text: 'code,fee\nD0120,33.00\nD0140,50.00\n', file_name: 'cigna-2027.csv' });
  assert.equal(put.status, 201, JSON.stringify(put.data));
  assert.equal((await api.post(`/fees/inbox/${fs.id}`, { text: 'code,fee\nD0120,33.00\nD0140,50.00\n', file_name: 'cigna-2027.csv' })).data.duplicate, true);
  const bad = await api.post(`/fees/inbox/${fs.id}`, { text: 'nothing useful here\n', file_name: 'junk.csv' });
  const r = await runFeeSchedules(h.db, { config: h.config });
  assert.equal(r.drafts.length, 1);
  const draft = (await api.get(`/fees/changes/${r.drafts[0]}`)).data;
  assert.deepEqual([draft.status, draft.source, draft.kind], ['draft', 'inbox', 'import']);
  assert.equal((await h.db.get('SELECT fee FROM fee_schedule_items WHERE fee_schedule_id = ? AND code = ?', fs.id, 'D0120')).fee, 3000, 'never applied by the job');
  const inbox = (await api.get('/fees/inbox')).data;
  assert.equal(inbox.find((i) => i.id === put.data.id).status, 'processed');
  assert.equal(inbox.find((i) => i.id === bad.data.id).status, 'failed');
  assert.equal((await h.db.get('SELECT content FROM fee_import_inbox WHERE id = ?', put.data.id)).content, null, 'the file is scratch once read');
  const issues = await h.db.all("SELECT dedupe_key, status FROM issues WHERE practice_id = ? AND dedupe_key LIKE 'fee-%'", practiceId);
  assert.ok(issues.some((i) => i.dedupe_key === `fee-import-review:${draft.id}` && i.status === 'open'), 'waiting for a person');
  assert.ok(issues.some((i) => i.dedupe_key === `fee-inbox:${bad.data.id}` && i.status === 'open'), 'the unreadable file');
  // Rejecting the draft closes its review item.
  await api.post(`/fees/changes/${draft.id}/cancel`, { reason: 'Wrong year' });
  assert.equal((await h.db.get('SELECT status FROM issues WHERE practice_id = ? AND dedupe_key = ?', practiceId, `fee-import-review:${draft.id}`)).status, 'resolved');
  assert.equal((await api.get(`/fees/changes/${draft.id}`)).data.status, 'rejected');
});

test('a scheduled change that fails to apply stays scheduled, is retried, and shows in Needs attention', async () => {
  const ctx = await h.practice();
  const { practiceId } = ctx;
  const today = localToday('America/New_York');
  const { id } = await h.db.get(
    "INSERT INTO fee_changes (practice_id, schedule_key, kind, status, effective_date, params) VALUES (?, 'standard', 'increase', 'scheduled', ?, '{}') RETURNING id", practiceId, today);
  const before = await stdFee(practiceId, 'D0120');
  const r = await runFeeSchedules(h.db, { config: h.config });
  assert.ok(r.failed.some((f) => f.id === id));
  const ch = await h.db.get('SELECT * FROM fee_changes WHERE id = ?', id);
  assert.equal(ch.status, 'scheduled', 'rolled back, tried again next time');
  assert.ok(ch.last_error);
  assert.equal(await stdFee(practiceId, 'D0120'), before);
  const issue = await h.db.get('SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ?', practiceId, `fee-change:${id}`);
  assert.equal(issue.status, 'open');
  assert.match(issue.title, /didn’t apply/);
  // Cancelling it closes the item.
  await ctx.api.post(`/fees/changes/${id}/cancel`, {});
  assert.equal((await h.db.get('SELECT status FROM issues WHERE id = ?', issue.id)).status, 'resolved');
});

test('versions are never overwritten; any two can be compared side by side; hand edits make versions too', async () => {
  const ctx = await h.practice();
  const { api, practiceId } = ctx;
  const fs = await ppo(api, 'Aetna PPO', { D0120: 3000, D1110: 6000 });
  let versions = (await api.get(`/fees/schedules/${fs.id}/versions`)).data.versions;
  assert.equal(versions.length, 1, 'a new schedule’s first fees are its first version');
  const v1 = versions[0];
  assert.equal(v1.effective_from, '1900-01-01');
  const v1Items = (await api.get(`/fees/versions/${v1.id}`)).data.items;

  await api.put(`/fee-schedules/${fs.id}`, { items: [{ code: 'D0120', fee: 3100 }, { code: 'D1110', fee: null }] });
  await api.post('/fees/imports', { fee_schedule_id: fs.id, text: 'code,fee\nD0120,32.00\nD2740,700.00', file_name: 'a.csv' })
    .then((r) => api.post(`/fees/changes/${r.data.id}/approve`, {}));
  versions = (await api.get(`/fees/schedules/${fs.id}/versions`)).data.versions;
  assert.deepEqual(versions.map((v) => v.version_no), [3, 2, 1]);
  assert.equal(versions[0].current, true);
  assert.deepEqual((await api.get(`/fees/versions/${v1.id}`)).data.items, v1Items, 'version 1 unchanged');
  const cmp = (await api.get(`/fees/compare?a=${v1.id}&b=${versions[0].id}`)).data;
  const row = (c) => cmp.rows.find((x) => x.code === c);
  assert.deepEqual([row('D0120').a, row('D0120').b, row('D0120').status], [3000, 3200, 'changed']);
  assert.equal(row('D1110').status, 'removed');
  assert.equal(row('D2740').status, 'added');
  assert.deepEqual(cmp.summary, { changed: 1, added: 1, removed: 1, same: 0 });
  // The stored rows themselves are never edited: one set of items per version.
  const counts = await h.db.all('SELECT version_id, COUNT(*) AS n FROM fee_schedule_version_items WHERE version_id IN (?, ?, ?) GROUP BY version_id ORDER BY version_id', ...versions.map((v) => v.id));
  assert.deepEqual(counts.map((c) => Number(c.n)), [2, 1, 2]);

  // Standard fees edited in Settings: the old fee is kept in a baseline, the new one is a version.
  const code = await h.db.get("SELECT id, fee FROM procedure_codes WHERE practice_id = ? AND code = 'D0220'", practiceId);
  await api.put(`/procedure-codes/${code.id}`, { fee: code.fee + 500 });
  const std = (await api.get('/fees/schedules/standard/versions')).data.versions;
  assert.equal(std.length, 2);
  const base = (await api.get(`/fees/versions/${std[1].id}`)).data.items.find((i) => i.code === 'D0220');
  assert.equal(base.fee, code.fee, 'the fee before the edit');
});

test('estimates and claims use the fee schedule version in effect on the date of service; historic claims keep their fees', async () => {
  const ctx = await h.practice();
  const { api, patient, practiceId } = ctx;
  const carrier = (await api.post('/carriers', { name: 'Delta Dental' })).data;
  const fs = await ppo(api, 'Delta PPO', { D2740: 70000 }, [carrier.id]);
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', annual_max: 500000, deductible: 0, pct_basic: 80, pct_major: 50 })).data;
  const today = localToday('America/New_York');
  const old = await completed(ctx, 'D2740', addDays(today, -200), 120000);
  const oldToo = await completed(ctx, 'D2740', addDays(today, -190), 120000);
  const claimBefore = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [oldToo] })).data;
  const itemBefore = await h.db.get('SELECT fee, write_off, estimated_amount FROM claim_items WHERE claim_id = ?', claimBefore.id);
  assert.equal(itemBefore.write_off, 50000);

  // The payer's new schedule, effective 60 days ago, approved today.
  const eff = addDays(today, -60);
  const up = (await api.post('/fees/imports', { fee_schedule_id: fs.id, text: 'code,fee\nD2740,800.00', file_name: 'delta-new.csv', effective_date: eff })).data;
  const ok = await api.post(`/fees/changes/${up.id}/approve`, {});
  assert.equal(ok.data.status, 'applied', JSON.stringify(ok.data));
  assert.equal(await resolveFee(h.db, practiceId, fs.id, 'D2740', addDays(today, -200)), 70000);
  assert.equal(await resolveFee(h.db, practiceId, fs.id, 'D2740', addDays(today, -59)), 80000);
  assert.equal((await api.get(`/fees/resolve?fee_schedule_id=${fs.id}&code=D2740&date=${addDays(today, -61)}`)).data.fee, 70000);

  // Estimate: last year's work at last year's allowance; new work at the new one.
  const est = (await api.post(`/patients/${patient.id}/estimate`, { patient_insurance_id: policy.id, procedure_ids: [old], items: [{ code: 'D2740', tooth: '3' }] })).data;
  assert.equal(est.items[0].allowed, 70000);
  assert.equal(est.items[0].write_off, 50000);
  assert.equal(est.items[1].allowed, 80000);
  // A claim made now for the old visit uses the version in effect on its date of service.
  const claim = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [old] })).data;
  assert.equal((await h.db.get('SELECT write_off FROM claim_items WHERE claim_id = ?', claim.id)).write_off, 50000);
  // The claim made before the import is untouched.
  assert.deepEqual(await h.db.get('SELECT fee, write_off, estimated_amount FROM claim_items WHERE claim_id = ?', claimBefore.id), itemBefore);
  // New work done after the effective date uses the new allowance.
  const recent = await completed(ctx, 'D2740', addDays(today, -10), 120000);
  const claimNew = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [recent] })).data;
  assert.equal((await h.db.get('SELECT write_off FROM claim_items WHERE claim_id = ?', claimNew.id)).write_off, 40000);

  // Write-offs compared by version.
  const rep = (await api.get(`/fees/reports/write-offs?fee_schedule_id=${fs.id}`)).data;
  assert.deepEqual(rep.rows.map((r) => [r.version_no, r.procedures, r.write_off_estimated]), [[1, 2, 100000], [2, 1, 40000]]);
});

test('office fee schedules: planned work is priced from the version in effect (officeFee through the resolver)', async () => {
  const ctx = await h.practice();
  const { api, patient, provider, practiceId } = ctx;
  const cash = (await api.post('/fee-schedules', { name: 'Cash', kind: 'office' })).data;
  await api.put(`/fee-schedules/${cash.id}`, { items: [{ code: 'D0120', fee: 4000 }] });
  await api.put(`/patients/${patient.id}`, { fee_schedule_id: cash.id });
  const r = await api.post('/fees/increases', { fee_schedule_ids: [cash.id, 'standard'], percent: 10, rounding: 'dollar', scope: { mode: 'codes', codes: ['D0120'] } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.changes.length, 2);
  assert.ok(r.data.changes[0].group_id && r.data.changes[0].group_id === r.data.changes[1].group_id, 'one increase across two schedules');
  const p = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D0120', provider_id: provider.id })).data;
  assert.equal(p.fee, 4400);
  const { officeFee } = await import('../src/fees.js');
  const code = await h.db.get("SELECT * FROM procedure_codes WHERE practice_id = ? AND code = 'D0120'", practiceId);
  assert.equal(await officeFee(h.db, practiceId, code, { patientId: patient.id, date: '2001-01-01' }), 4000, 'as it was before');
});

test('permissions: viewing needs billing:read, uploading billing:write, changing fees fees:manage', async () => {
  const ctx = await h.practice();
  const { api } = ctx;
  const fs = await ppo(api, 'Guardian', { D0120: 3000 });
  const assistant = await person(api, 'assistant');
  const billing = await person(api, 'billing');
  assert.equal((await assistant.api.get('/fees/schedules')).status, 403);
  assert.equal((await billing.api.get('/fees/schedules')).status, 200);
  assert.equal((await billing.api.post('/fees/increase/preview', { percent: 5 })).status, 200, 'previewing changes nothing');
  assert.equal((await billing.api.post('/fees/increases', { percent: 5 })).status, 403);
  const up = await billing.api.post('/fees/imports', { fee_schedule_id: fs.id, text: 'code,fee\nD0120,31.00', file_name: 'g.csv' });
  assert.equal(up.status, 201);
  for (const [m, p, b] of [['put', `/fees/changes/${up.data.id}`, { note: 'x' }], ['post', `/fees/changes/${up.data.id}/approve`, {}], ['post', `/fees/changes/${up.data.id}/cancel`, {}]]) {
    assert.equal((await billing.api[m](p, b)).status, 403, `${m} ${p}`);
  }
  assert.equal((await assistant.api.post('/fees/imports', { fee_schedule_id: fs.id, text: 'code,fee\nD0120,31.00' })).status, 403);
  // The assistant (for an admin) can schedule only with the person's OK.
  const admin = h.client(ctx.token, { 'X-Acting-For': 'assistant' });
  assert.equal((await admin.post('/fees/increases', { percent: 5, effective_date: addDays(localToday('America/New_York'), 30) })).status, 428);
});

test('practice isolation: another practice can’t see, change or compare this one’s fee schedules', async () => {
  const a = await h.practice();
  const b = await h.practice();
  const fs = await ppo(a.api, 'Private PPO', { D0120: 3000 });
  const draft = (await a.api.post('/fees/imports', { fee_schedule_id: fs.id, text: 'code,fee\nD0120,31.00', file_name: 'p.csv' })).data;
  const v = (await a.api.get(`/fees/schedules/${fs.id}/versions`)).data.versions[0];
  assert.equal((await b.api.get(`/fees/changes/${draft.id}`)).status, 404);
  assert.equal((await b.api.post(`/fees/changes/${draft.id}/approve`, {})).status, 404);
  assert.equal((await b.api.post(`/fees/changes/${draft.id}/cancel`, {})).status, 404);
  assert.equal((await b.api.post('/fees/imports', { fee_schedule_id: fs.id, text: 'code,fee\nD0120,1.00' })).status, 404);
  assert.equal((await b.api.post(`/fees/inbox/${fs.id}`, { text: 'code,fee\nD0120,1.00', file_name: 'x.csv' })).status, 404);
  assert.equal((await b.api.get(`/fees/schedules/${fs.id}/versions`)).status, 404);
  assert.equal((await b.api.get(`/fees/versions/${v.id}`)).status, 404);
  assert.equal((await b.api.get(`/fees/compare?a=${v.id}&b=${v.id}`)).status, 404);
  assert.equal((await b.api.post('/fees/increase/preview', { fee_schedule_ids: [fs.id], percent: 5 })).status, 404);
  assert.ok(!(await b.api.get('/fees/schedules')).data.some((s) => s.id === fs.id));
  assert.deepEqual((await b.api.get('/fees/changes')).data, []);
});

test('the migration keeps the fees on file as version 1, once', async () => {
  const ctx = await h.practice();
  const { practiceId } = ctx;
  const fs = (await ctx.api.post('/fee-schedules', { name: 'Old PPO', kind: 'ppo' })).data;
  await h.db.run('INSERT INTO fee_schedule_items (fee_schedule_id, code, fee) VALUES (?, ?, ?)', fs.id, 'D0120', 2500); // as an old install had it
  const step = MIGRATIONS.find((m) => m.id === 2);
  await step.up(h.db);
  await step.up(h.db);
  const rows = await h.db.all("SELECT schedule_key, version_no, source FROM fee_schedule_versions WHERE practice_id = ? ORDER BY schedule_key", practiceId);
  assert.deepEqual(rows.map((r) => [r.schedule_key, r.version_no, r.source]), [[`fs${fs.id}`, 1, 'baseline'], ['standard', 1, 'baseline']]);
  assert.equal(await ensureBaseline(h.db, practiceId, fs.id) > 0, true, 'already there: returns it');
});
