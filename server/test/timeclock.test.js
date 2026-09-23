import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { payrollSummary } from '../src/routes/timeclock.js';

const h = harness();

test('payroll: weekly overtime past 40 hours, breaks taken out', () => {
  const day = (d, inT, outT, brk = 0) => ({ user_id: 1, user_name: 'Ann', clock_in: `2031-03-${d} ${inT}`, clock_out: `2031-03-${d} ${outT}`, break_minutes: brk });
  // Mon–Fri 8:00–17:30 with 30-minute lunch = 9h × 5 = 45h: 5h overtime. Next Monday 4h regular.
  const rows = payrollSummary([day('03', '08:00', '17:30', 30), day('04', '08:00', '17:30', 30), day('05', '08:00', '17:30', 30), day('06', '08:00', '17:30', 30), day('07', '08:00', '17:30', 30), day('10', '08:00', '12:00')]);
  assert.deepEqual([rows[0].hours, rows[0].regular_hours, rows[0].overtime_hours], [49, 44, 5]);
});

test('time clock: clock in and out, own timesheet, manager fixes and payroll CSV', async () => {
  const { api } = await h.practice({ timezone: 'UTC' });
  const staff = (await api.post('/users', { email: `hyg-${Date.now()}@example.com`, name: 'Hy Gienist', role: 'hygienist', password: 'correct-horse-battery' })).data;
  const login = await h.client().post('/auth/login', { email: staff.email, password: 'correct-horse-battery' });
  const me = h.client(login.data.token);

  assert.equal((await me.post('/timeclock/in')).status, 201);
  assert.equal((await me.post('/timeclock/in')).status, 409, 'already in');
  assert.ok((await me.get('/timeclock/me')).data.clocked_in);
  assert.equal((await me.post('/timeclock/out', { break_minutes: 90 })).status, 400, 'a break can’t be longer than the shift');
  assert.equal((await me.post('/timeclock/out')).status, 200);
  assert.equal((await me.post('/timeclock/out')).status, 409, 'not clocked in');
  const today = new Date().toISOString().slice(0, 10);
  const mine = (await me.get(`/timeclock?from=${today}&to=${today}`)).data;
  assert.equal(mine.manager, false);
  assert.equal(mine.punches.length, 1);
  assert.equal((await me.put(`/timeclock/punches/${mine.punches[0].id}`, { clock_in: `${today} 06:00` })).status, 403);
  assert.equal((await me.get(`/timeclock/payroll.csv?from=${today}&to=${today}`)).status, 403);

  // The manager adds a missed shift and fixes the break; each change is audited.
  const add = await api.post('/timeclock/punches', { user_id: staff.id, clock_in: '2031-03-03 08:00', clock_out: '2031-03-03 16:30', break_minutes: 30 });
  assert.equal(add.status, 201);
  assert.equal((await api.put(`/timeclock/punches/${add.data.id}`, { clock_out: '2031-03-03 07:00' })).status, 400);
  await api.put(`/timeclock/punches/${add.data.id}`, { break_minutes: 60 });
  const sheet = (await api.get('/timeclock?from=2031-03-01&to=2031-03-31')).data;
  assert.equal(sheet.summary[0].hours, 7.5);
  const csv = (await api.get('/timeclock/payroll.csv?from=2031-03-01&to=2031-03-31')).data;
  assert.match(csv, /^\uFEFF?Employee,Regular hours,Overtime hours,Total hours,Open punches\r\nHy Gienist,7\.5,0,7\.5,0\r\n$/);
  const log = (await api.get('/audit-log?action=timeclock.edit')).data;
  assert.ok((log.rows || log).some((e) => e.action === 'timeclock.edit'));
});
