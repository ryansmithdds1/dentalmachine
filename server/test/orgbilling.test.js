import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

// A group of two practices (North, South) and an outside practice with the same kinds of work in it.
async function world() {
  const north = await h.practice();
  const south = await h.practice();
  const outsider = await h.practice();
  await north.api.post('/org', { name: 'Bright Smiles Group' });
  const { code } = (await north.api.post('/org/join-code')).data;
  assert.equal((await south.api.post('/org/join', { code })).status, 200);

  const claimsAt = async (ctx) => {
    const { api, patient } = ctx;
    const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
    const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', annual_max: 150000, deductible: 0, pct_basic: 80, pct_major: 50 })).data;
    const claim = async (code, tooth, surfaces) => {
      const p = (await api.post(`/patients/${patient.id}/procedures`, { code, tooth, surfaces, provider_id: ctx.provider.id, complete: true })).data;
      const c = await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [p.id] });
      assert.equal(c.status, 201, JSON.stringify(c.data));
      return c.data;
    };
    const unsent = await claim('D2391', '19', 'O');
    const out = await claim('D2740', '3');
    await api.post(`/claims/${out.id}/submit`);
    await h.db.run('UPDATE claims SET submitted_at = ? WHERE id = ?', new Date(Date.now() - 50 * 86400_000).toISOString(), out.id);
    const denied = await claim('D2392', '30', 'MO');
    await api.post(`/claims/${denied.id}/submit`);
    await api.post(`/claims/${denied.id}/deny`, { reason: 'Missing tooth number' });
    // A patient who paid more than they owe (credit balance), and a remittance line that matched no claim.
    const payer = (await api.post('/patients', { first_name: 'Carl', last_name: 'Credit', dob: '1970-01-01', phone: '(512) 555-0177' })).data;
    await api.post(`/patients/${payer.id}/payments`, { amount: 40, method: 'cash' });
    const era = (await h.db.run(
      "INSERT INTO era_imports (practice_id, payer_name, check_number, payment_date, total_paid, claims_matched, claims_unmatched, details, raw) VALUES (?, 'Delta Dental', ?, '2026-01-05', 12300, 0, 1, ?, 'x')",
      ctx.practiceId, `EFT${ctx.practiceId}`, JSON.stringify([{ control_number: 'ZZ999', billed: 20000, paid: 12300, result: 'unmatched' }]),
    )).id;
    return { unsent, out, denied, payer, era };
  };
  const work = { north: await claimsAt(north), south: await claimsAt(south), outsider: await claimsAt(outsider) };
  return { north, south, outsider, work };
}

const login = async (email, password) => h.client((await h.client().post('/auth/login', { email, password })).data.token);

test('central billing queues: only the group’s practices, read-only outside your own, bulk assignment', async () => {
  const { north, south, outsider, work } = await world();
  const pids = new Set([north.practiceId, south.practiceId]);

  // Not in a group (the outsider), or in it without the billing role (South's admin): no queues.
  assert.equal((await outsider.api.get('/org/billing/queue?queue=outstanding')).status, 403);
  assert.equal((await outsider.api.get('/org/billing/summary')).status, 403);
  assert.equal((await south.api.get('/org/billing/queue?queue=outstanding')).status, 403);

  // The owner (North's admin) sees every queue across both practices, never the outsider's rows.
  const queues = {};
  for (const q of ['outstanding', 'denied', 'unsent', 'era', 'credits']) {
    const res = await north.api.get(`/org/billing/queue?queue=${q}`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    queues[q] = res.data.rows;
    assert.ok(res.data.rows.length >= 2, `${q} has both practices`);
    assert.ok(res.data.rows.every((r) => pids.has(r.practice_id)), `${q}: only member practices`);
    assert.deepEqual(new Set(res.data.rows.map((r) => r.practice_id)), pids);
  }
  const keys = Object.values(queues).flat().map((r) => r.key);
  for (const c of [work.outsider.unsent, work.outsider.out, work.outsider.denied]) assert.ok(!keys.includes(`claim:${c.id}`), 'outsider claim never shows');
  assert.ok(!keys.includes(`era:${work.outsider.era}:0`) && !keys.includes(`credit:${work.outsider.payer.id}`));
  assert.ok(keys.includes(`claim:${work.south.out.id}`) && keys.includes(`claim:${work.north.denied.id}`) && keys.includes(`claim:${work.south.unsent.id}`));
  assert.ok(keys.includes(`era:${work.south.era}:0`) && keys.includes(`credit:${work.north.payer.id}`));

  // Each row: practice, patient, amount, age. Rows at your own practice open there; the others are read-only.
  const southOut = queues.outstanding.find((r) => r.key === `claim:${work.south.out.id}`);
  assert.equal(southOut.patient, 'Doe, Jane');
  assert.ok(southOut.amount > 0);
  assert.ok(southOut.age_days >= 49 && southOut.age_days <= 51);
  assert.deepEqual([southOut.can_open, southOut.link], [false, null]);
  const northOut = queues.outstanding.find((r) => r.key === `claim:${work.north.out.id}`);
  assert.deepEqual([northOut.can_open, northOut.link], [true, `/claims/${work.north.out.id}`]);
  // Credit amounts come from the ledger.
  const credit = queues.credits.find((r) => r.key === `credit:${work.north.payer.id}`);
  assert.equal(credit.amount, -(await h.db.get('SELECT SUM(amount) AS n FROM ledger_entries WHERE patient_id = ?', work.north.payer.id)).n);

  // Practice filter: a member practice narrows; an outside one is refused.
  const onlySouth = (await north.api.get(`/org/billing/queue?queue=outstanding&practice_id=${south.practiceId}`)).data.rows;
  assert.ok(onlySouth.length && onlySouth.every((r) => r.practice_id === south.practiceId));
  assert.equal((await north.api.get(`/org/billing/queue?queue=outstanding&practice_id=${outsider.practiceId}`)).status, 404);

  // Summary tiles add up to the rows.
  const sum = (await north.api.get('/org/billing/summary')).data;
  assert.equal(sum.practices.length, 2);
  assert.equal(sum.totals.queues.outstanding.count, queues.outstanding.length);
  assert.equal(sum.totals.queues.credits.amount, queues.credits.reduce((s, r) => s + r.amount, 0));

  // South's billing person joins the billing team (owners only), then works from South.
  await south.api.post('/users', { email: `sb${south.practiceId}@example.com`, name: 'Sam Biller', role: 'billing', password: 'billing-password-1' });
  const sam = await login(`sb${south.practiceId}@example.com`, 'billing-password-1');
  const samId = (await h.db.get('SELECT id FROM users WHERE email = ?', `sb${south.practiceId}@example.com`)).id;
  assert.equal((await north.api.post('/org/members', { email: `sb${south.practiceId}@example.com`, role: 'viewer' })).status, 200);
  assert.equal((await sam.get('/org/billing/queue?queue=denied')).status, 403, 'a viewer isn’t on the billing team');
  assert.equal((await sam.put(`/org/members/${samId}`, { billing: true })).status, 403, 'only owners grant it');
  assert.equal((await north.api.put(`/org/members/${samId}`, { billing: true })).status, 200);
  const samDenied = (await sam.get('/org/billing/queue?queue=denied')).data.rows;
  assert.equal(samDenied.find((r) => r.practice_id === south.practiceId).can_open, true);
  assert.equal(samDenied.find((r) => r.practice_id === north.practiceId).can_open, false);
  assert.ok((await h.db.get("SELECT id FROM audit_log WHERE action = 'org.member_billing' AND practice_id = ?", north.practiceId)));

  // Bulk assign to me, then to a teammate; the outsider's items and non-team assignees are refused.
  const two = [`claim:${work.north.out.id}`, `claim:${work.south.out.id}`];
  assert.equal((await sam.post('/org/billing/assign', { keys: two, user_id: samId })).status, 200);
  let rows = (await sam.get('/org/billing/queue?queue=outstanding&assigned=me')).data.rows;
  assert.deepEqual(rows.map((r) => r.key).sort(), [...two].sort());
  assert.equal(rows[0].assigned_name, 'Sam Biller');
  const northAdminId = (await h.db.get('SELECT id FROM users WHERE email = ?', north.email)).id;
  assert.equal((await sam.post('/org/billing/assign', { keys: [two[0]], user_id: northAdminId })).status, 200);
  rows = (await north.api.get('/org/billing/queue?queue=outstanding&assigned=me')).data.rows;
  assert.deepEqual(rows.map((r) => r.key), [two[0]]);
  assert.equal((await sam.post('/org/billing/assign', { keys: [`claim:${work.outsider.out.id}`], user_id: samId })).status, 404);
  assert.equal((await sam.post('/org/billing/assign', { keys: [`credit:${work.outsider.payer.id}`], user_id: samId })).status, 404);
  assert.equal((await sam.post('/org/billing/assign', { keys: ['bogus:1'], user_id: samId })).status, 404);
  const outsiderAdmin = (await h.db.get('SELECT id FROM users WHERE email = ?', outsider.email)).id;
  assert.equal((await sam.post('/org/billing/assign', { keys: two, user_id: outsiderAdmin })).status, 400);
  // Twice is the same as once (double clicks).
  assert.equal((await sam.post('/org/billing/assign', { keys: [two[1]], user_id: samId })).data.changed, 0);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM org_assignments WHERE item_key = ?', two[1])).n, 1);
  // Unassign.
  await sam.post('/org/billing/assign', { keys: two, user_id: null });
  assert.equal((await north.api.get('/org/billing/queue?queue=outstanding&assigned=unassigned')).data.rows.filter((r) => two.includes(r.key)).length, 2);
  const assignAudit = await h.db.all("SELECT practice_id FROM audit_log WHERE action = 'org.billing_assign'");
  assert.ok(assignAudit.some((a) => a.practice_id === north.practiceId) && assignAudit.some((a) => a.practice_id === south.practiceId));
  assert.ok(!assignAudit.some((a) => a.practice_id === outsider.practiceId));

  // Resolving the ERA's Needs attention item takes its lines off the queue.
  await h.db.run("INSERT INTO issues (practice_id, kind, dedupe_key, title, status) VALUES (?, 'era', ?, 'ERA', 'resolved')", south.practiceId, `era:${work.south.era}`);
  assert.ok(!(await north.api.get('/org/billing/queue?queue=era')).data.rows.some((r) => r.key === `era:${work.south.era}:0`));

  // A practice that leaves the group drops out of the queues, and its people lose access.
  assert.equal((await south.api.post('/org/leave')).status, 200);
  const after = (await north.api.get('/org/billing/queue?queue=outstanding')).data.rows;
  assert.ok(after.length && after.every((r) => r.practice_id === north.practiceId));
  assert.equal((await sam.get('/org/billing/summary')).status, 403);
});

test('cross-practice patient lookup: group only, needs enough to identify someone, audited in each practice', async () => {
  const { north, south, outsider } = await world();
  assert.equal((await outsider.api.get('/org/billing/lookup?name=jane%20doe')).status, 403);
  assert.equal((await north.api.get('/org/billing/lookup?name=jane')).status, 400, 'one name alone is browsing');
  assert.equal((await north.api.get('/org/billing/lookup?dob=1985-02-31&name=jane')).status, 400);
  const res = await north.api.get('/org/billing/lookup?name=Jane&dob=1985-04-12');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  // Every practice has a Jane Doe born 1985-04-12 (the harness patient); only the group's two come back.
  assert.deepEqual(new Set(res.data.rows.map((r) => r.practice_id)), new Set([north.practiceId, south.practiceId]));
  const southRow = res.data.rows.find((r) => r.practice_id === south.practiceId);
  assert.deepEqual([southRow.patient_id, southRow.can_open, southRow.link], [south.patient.id, false, null]);
  assert.ok(southRow.balance > 0 && southRow.open_claims === 3);
  assert.equal(res.data.rows.find((r) => r.practice_id === north.practiceId).link, `/patients/${north.patient.id}`);
  const byPhone = (await north.api.get('/org/billing/lookup?phone=512-555-0177')).data.rows;
  assert.equal(byPhone.length, 2);

  // Audited: a summary in the searcher's practice, and each patient shown in their own practice's log.
  const summary = await h.db.get("SELECT details FROM audit_log WHERE action = 'org.patient_lookup' AND practice_id = ? AND entity = 'organizations' ORDER BY id LIMIT 1", north.practiceId);
  assert.deepEqual(JSON.parse(summary.details).fields, ['name', 'dob']);
  const seen = await h.db.get("SELECT user_id, details FROM audit_log WHERE action = 'org.patient_lookup' AND practice_id = ? AND patient_id = ?", south.practiceId, south.patient.id);
  assert.equal(JSON.parse(seen.details).by_practice_id, north.practiceId);
  assert.ok(!(await h.db.get("SELECT id FROM audit_log WHERE action = 'org.patient_lookup' AND practice_id = ?", outsider.practiceId)));
});

test('group reports: per-practice numbers with totals that add up, CSV export audited', async () => {
  const { north, south, outsider } = await world();
  const today = new Date().toISOString().slice(0, 10);
  const from = `${today.slice(0, 4)}-01-01`;
  assert.equal((await outsider.api.get('/org/reports')).status, 403);
  assert.equal((await north.api.get('/org/reports?from=2026-05-01&to=2026-04-01')).status, 400);
  const rep = (await north.api.get(`/org/reports?from=${from}&to=${today}`)).data;
  assert.equal(rep.practices.length, 2);
  // Independently: production and collections straight from each practice's ledger; A/R as the ledger balance owed.
  for (const p of rep.practices) {
    const prod = (await h.db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'charge' AND voided_at IS NULL AND reverses_id IS NULL AND entry_date BETWEEN ? AND ?", p.practice_id, from, today)).n;
    const coll = -(await h.db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE practice_id = ? AND type IN ('payment','insurance_payment','refund') AND voided_at IS NULL AND reverses_id IS NULL AND entry_date BETWEEN ? AND ?", p.practice_id, from, today)).n;
    const owed = (await h.db.all('SELECT SUM(amount) AS b FROM ledger_entries WHERE practice_id = ? GROUP BY patient_id', p.practice_id)).map((x) => Number(x.b)).filter((b) => b > 0).reduce((s, b) => s + b, 0);
    assert.equal(p.production, Number(prod));
    assert.equal(p.collections, Number(coll));
    assert.equal(p.ar_total, owed);
    assert.equal(p.ar_current + p.ar_31_60 + p.ar_61_90 + p.ar_90_plus, p.ar_total);
    assert.ok(p.production > 0 && p.collections > 0);
    assert.equal(p.collection_pct, Math.round((p.collections / p.production) * 1000) / 10);
  }
  for (const k of ['production', 'collections', 'ar_total', 'ar_90_plus', 'new_patients', 'treatment_presented', 'hygiene_visits']) {
    assert.equal(rep.totals[k], rep.practices.reduce((s, p) => s + p[k], 0), k);
  }
  assert.equal(rep.totals.collection_pct, Math.round((rep.totals.collections / rep.totals.production) * 1000) / 10);
  // The outsider's numbers are in neither.
  const outsiderProd = Number((await h.db.get("SELECT SUM(amount) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'charge'", outsider.practiceId)).n);
  assert.ok(outsiderProd > 0);
  assert.equal(rep.totals.production, rep.practices.reduce((s, p) => s + p.production, 0));
  // Filtered to one practice.
  const one = (await north.api.get(`/org/reports?from=${from}&to=${today}&practice_id=${south.practiceId}`)).data;
  assert.deepEqual(one.practices.map((p) => p.practice_id), [south.practiceId]);
  assert.equal((await north.api.get(`/org/reports?practice_id=${outsider.practiceId}`)).status, 404);

  const csv = await north.api.get(`/org/reports.csv?from=${from}&to=${today}`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = csv.data.trim().split(/\r\n/);
  assert.equal(lines.length, 4, 'header, two practices, group total');
  assert.match(lines[3], /^Group total,/);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'org.report_export' AND practice_id = ?", north.practiceId));
});

test('role templates: owners apply one role to people across the group’s practices; audited; nobody else can', async () => {
  const { north, south, outsider } = await world();
  const mk = async (ctx, name, role) => {
    const email = `${name.toLowerCase().replace(/\W/g, '')}${ctx.practiceId}@example.com`;
    await ctx.api.post('/users', { email, name, role, password: 'staff-password-99' });
    return (await h.db.get('SELECT id FROM users WHERE email = ?', email)).id;
  };
  const nFront = await mk(north, 'Nora Front', 'assistant');
  const sFront = await mk(south, 'Sid Front', 'hygienist');
  const oFront = await mk(outsider, 'Otto Front', 'assistant');

  const perms = ['patients:read', 'patients:write', 'schedule:read', 'schedule:write', 'billing:read'];
  assert.equal((await south.api.post('/org/role-templates', { name: 'Front desk', base_role: 'front_desk', permissions: perms })).status, 403, 'not an owner');
  assert.equal((await outsider.api.post('/org/role-templates', { name: 'Front desk', base_role: 'front_desk', permissions: perms })).status, 403);
  assert.equal((await north.api.post('/org/role-templates', { name: 'Boss', base_role: 'admin', permissions: [] })).status, 400);
  assert.equal((await north.api.post('/org/role-templates', { name: 'X', base_role: 'billing', permissions: ['nope:x'] })).status, 400);
  const t = (await north.api.post('/org/role-templates', { name: 'Front desk', base_role: 'front_desk', permissions: perms })).data;
  assert.equal((await north.api.post('/org/role-templates', { name: 'front desk', base_role: 'front_desk', permissions: perms })).status, 409);

  // Only the group's people; never an administrator; never the outsider.
  assert.equal((await north.api.post(`/org/role-templates/${t.id}/apply`, { user_ids: [oFront] })).status, 404);
  const southAdmin = (await h.db.get('SELECT id FROM users WHERE email = ?', south.email)).id;
  assert.equal((await north.api.post(`/org/role-templates/${t.id}/apply`, { user_ids: [southAdmin] })).status, 400);
  assert.equal((await south.api.post(`/org/role-templates/${t.id}/apply`, { user_ids: [sFront] })).status, 403, 'only owners');
  // The assistant can't do it on its own.
  const aiTry = await h.client(north.token, { 'X-Acting-For': 'assistant' }).post(`/org/role-templates/${t.id}/apply`, { user_ids: [nFront] });
  assert.equal(aiTry.status, 428);

  const people = (await north.api.get('/org/people')).data;
  assert.ok(people.some((p) => p.id === sFront) && !people.some((p) => p.id === oFront));

  const applied = await north.api.post(`/org/role-templates/${t.id}/apply`, { user_ids: [nFront, sFront], reason: 'New front desk setup' });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  for (const [uid, pid] of [[nFront, north.practiceId], [sFront, south.practiceId]]) {
    const u = await h.db.get('SELECT u.role, u.practice_id, cr.permissions, cr.org_template_id, cr.practice_id AS role_practice FROM users u JOIN custom_roles cr ON cr.id = u.custom_role_id WHERE u.id = ?', uid);
    assert.deepEqual([u.role, u.role_practice, u.org_template_id], ['front_desk', pid, t.id]);
    assert.deepEqual(JSON.parse(u.permissions), [...perms].sort());
    const a = await h.db.get("SELECT user_id, changes, reason FROM audit_log WHERE action = 'org.role_template_apply' AND entity_id = ? AND practice_id = ?", uid, pid);
    assert.ok(a, 'audited in the person’s own practice');
    assert.equal(a.reason, 'New front desk setup');
    assert.match(a.changes, /front_desk/);
  }
  // The person's session reflects it: Sid (South) now has the template's permissions there.
  const sid = await login(`sidfront${south.practiceId}@example.com`, 'staff-password-99');
  const me = (await sid.get('/auth/me')).data.user;
  assert.deepEqual([...me.permissions].sort(), [...perms].sort());
  // Outsider untouched.
  assert.equal((await h.db.get('SELECT role, custom_role_id FROM users WHERE id = ?', oFront)).custom_role_id, null);

  // Applying again changes nothing new; updating the template carries to every practice's linked role.
  const again = (await north.api.post(`/org/role-templates/${t.id}/apply`, { user_ids: [nFront, sFront] })).data;
  assert.ok(again.results.every((r) => !r.changed));
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM custom_roles WHERE org_template_id = ?', t.id)).n, 2);
  const upd = await north.api.put(`/org/role-templates/${t.id}`, { permissions: [...perms, 'billing:write'] });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  for (const r of await h.db.all('SELECT permissions FROM custom_roles WHERE org_template_id = ?', t.id)) assert.ok(JSON.parse(r.permissions).includes('billing:write'));
  const list = (await north.api.get('/org/role-templates')).data;
  assert.equal(list.templates.find((x) => x.id === t.id).people, 2);
  // Retired, not deleted.
  assert.equal((await north.api.post(`/org/role-templates/${t.id}/retire`)).status, 200);
  assert.equal((await h.db.get('SELECT active FROM org_role_templates WHERE id = ?', t.id)).active, 0);
  assert.equal((await north.api.post(`/org/role-templates/${t.id}/apply`, { user_ids: [nFront] })).status, 409);
});
