// Shared harness for feature tests: a real app on a random port with a fresh database.
import { before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

export function harness({ config: extra = {}, messenger, fetchImpl, clearinghouse } = {}) {
  const h = { sent: [] };
  const uploadDir = mkdtempSync(join(tmpdir(), 'dm-test-'));
  let server;
  before(async () => {
    h.db = await openDb(':memory:');
    h.messenger = messenger || { status: { sms: 'test', email: 'test' }, send: async (m) => { h.sent.push(m); return { provider_id: `test-${h.sent.length}` }; } };
    h.config = { appUrl: 'https://app.example.com', uploadDir, ediMode: 'sandbox', ...extra };
    h.app = createApp({ db: h.db, secret: 'test-secret', config: h.config, messenger: h.messenger, ...(fetchImpl ? { fetchImpl } : {}), ...(clearinghouse ? { clearinghouse } : {}) });
    await new Promise((resolve) => {
      server = h.app.listen(0, resolve);
    });
    h.origin = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server?.close();
    await h.db?.close();
    rmSync(uploadDir, { recursive: true, force: true });
  });

  h.client = (token, headers = {}) => {
    const call = async (method, path, body) => {
      const raw = typeof body === 'string';
      const res = await fetch(`${h.origin}/api${path}`, {
        method,
        headers: { 'Content-Type': raw ? 'text/plain' : 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      });
      const text = await res.text();
      let data = text;
      try {
        data = JSON.parse(text);
      } catch { /* not JSON */ }
      return { status: res.status, data, headers: res.headers };
    };
    return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: (p, b) => call('DELETE', p, b) };
  };

  let n = 0;
  // A practice with an admin, a dentist and a patient with a phone and email.
  h.practice = async (extraPractice = {}) => {
    n++;
    const email = `admin${n}-${Math.random().toString(36).slice(2, 7)}@example.com`;
    const reg = await h.client().post('/auth/register', { practice_name: `Practice ${n}`, name: 'Admin', email, password: 'correct-horse-battery' });
    const api = h.client(reg.data.token);
    await api.put('/practice', { npi: '1234567893', tax_id: '74-1234567', address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', phone: '(512) 555-0142', send_from: '00:00', send_until: '00:00', ...extraPractice });
    const provider = (await api.post('/providers', { name: 'Dr. Ann Lee, DDS', type: 'dentist', npi: '1987654321' })).data;
    const patient = (await api.post('/patients', { first_name: 'Jane', last_name: 'Doe', dob: '1985-04-12', phone: '(512) 555-0100', email: 'jane@example.com', address: '9 Elm', city: 'Austin', state: 'TX', zip: '78704', gender: 'female' })).data;
    return { api, token: reg.data.token, email, provider, patient, practiceId: reg.data.user?.practice_id };
  };
  return h;
}
