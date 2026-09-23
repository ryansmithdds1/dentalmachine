import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { HttpError } from '../auth.js';
import { findOr404, audit, insert, hashToken } from '../util.js';
import { EVENTS, emitEvent, deliverWebhooks, markPayments } from '../webhooks.js';

export const API_SCOPES = {
  'patients:read': 'Read patients', 'patients:write': 'Create and update patients',
  'appointments:read': 'Read appointments and availability', 'appointments:write': 'Book, confirm and cancel appointments',
  'payments:read': 'Read payments',
};
const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only administrators can manage API access')));

// Settings → API & webhooks: keys for the public API, and webhook endpoints.
export default function developerRoutes({ db, fetchImpl }) {
  const r = Router();
  r.use(['/api-keys', '/webhooks'], requireAdmin);

  r.get('/api-keys', async (req, res) => {
    const keys = await db.all('SELECT id, name, prefix, scopes, last_used_at, revoked_at, created_at FROM api_keys WHERE practice_id = ? ORDER BY id DESC', req.user.practice_id);
    res.json({ keys: keys.map((k) => ({ ...k, scopes: JSON.parse(k.scopes) })), scopes: API_SCOPES, events: EVENTS });
  });
  // The key is shown once; only its hash is stored.
  r.post('/api-keys', async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'Name the key (e.g. the app it is for)');
    const scopes = [...new Set(Array.isArray(req.body?.scopes) ? req.body.scopes : [])];
    if (!scopes.length || scopes.some((s) => !(s in API_SCOPES))) throw new HttpError(400, `scopes must be some of: ${Object.keys(API_SCOPES).join(', ')}`);
    const key = `dm_live_${randomBytes(24).toString('base64url')}`;
    const id = await insert(db, 'api_keys', { practice_id: req.user.practice_id, name, prefix: key.slice(0, 12), key_hash: hashToken(key), scopes: JSON.stringify(scopes), created_by: req.user.id });
    await audit(db, req, 'api_key.create', 'api_keys', id, { scopes });
    res.status(201).json({ id, name, key, scopes });
  });
  r.delete('/api-keys/:kid', async (req, res) => {
    const k = await findOr404(db, 'api_keys', req.params.kid, req.user.practice_id, 'API key');
    await db.run("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?", k.id);
    await audit(db, req, 'api_key.revoke', 'api_keys', k.id);
    res.json({ ok: true });
  });

  const endpointView = (e) => ({ ...e, events: JSON.parse(e.events), secret: undefined, secret_hint: `${e.secret.slice(0, 10)}…` });
  const cleanEndpoint = (b) => {
    const url = String(b?.url || '').trim();
    if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(url)) throw new HttpError(400, 'The URL must start with https://');
    const events = [...new Set(Array.isArray(b.events) ? b.events : [])];
    if (!events.length || events.some((e) => e !== '*' && !EVENTS.includes(e))) throw new HttpError(400, `events must be some of: ${EVENTS.join(', ')}`);
    return { url, events: JSON.stringify(events), description: String(b.description || '').slice(0, 200) || null };
  };
  r.get('/webhooks', async (req, res) => {
    const eps = await db.all('SELECT * FROM webhook_endpoints WHERE practice_id = ? ORDER BY id', req.user.practice_id);
    const recent = await db.all(
      'SELECT id, endpoint_id, event, status, attempts, response_code, last_error, created_at, delivered_at FROM webhook_deliveries WHERE practice_id = ? ORDER BY id DESC LIMIT 50', req.user.practice_id,
    );
    res.json({ endpoints: eps.map(endpointView), deliveries: recent, events: EVENTS });
  });
  r.post('/webhooks', async (req, res) => {
    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    const id = await insert(db, 'webhook_endpoints', { ...cleanEndpoint(req.body), practice_id: req.user.practice_id, secret });
    await markPayments(db, req.user.practice_id);
    await audit(db, req, 'webhook.create', 'webhook_endpoints', id);
    res.status(201).json({ ...endpointView(await db.get('SELECT * FROM webhook_endpoints WHERE id = ?', id)), secret });
  });
  r.put('/webhooks/:wid', async (req, res) => {
    const e = await findOr404(db, 'webhook_endpoints', req.params.wid, req.user.practice_id, 'Webhook');
    const row = { ...cleanEndpoint({ ...endpointView(e), ...req.body }), ...(req.body?.active !== undefined ? { active: req.body.active ? 1 : 0, failures: 0 } : {}) };
    await db.run(`UPDATE webhook_endpoints SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), e.id);
    res.json(endpointView(await db.get('SELECT * FROM webhook_endpoints WHERE id = ?', e.id)));
  });
  r.delete('/webhooks/:wid', async (req, res) => {
    const e = await findOr404(db, 'webhook_endpoints', req.params.wid, req.user.practice_id, 'Webhook');
    await db.run('DELETE FROM webhook_deliveries WHERE endpoint_id = ?', e.id);
    await db.run('DELETE FROM webhook_endpoints WHERE id = ?', e.id);
    res.json({ ok: true });
  });
  // Sends a test event to one endpoint now and reports what came back.
  r.post('/webhooks/:wid/test', async (req, res) => {
    const e = await findOr404(db, 'webhook_endpoints', req.params.wid, req.user.practice_id, 'Webhook');
    const payload = JSON.stringify({ id: `evt_test_${randomBytes(6).toString('hex')}`, type: 'test', created: new Date().toISOString(), data: { object: { message: 'Hello from Dental Machine' } } });
    const id = await insert(db, 'webhook_deliveries', { practice_id: e.practice_id, endpoint_id: e.id, event: 'test', payload, next_attempt_at: new Date().toISOString() });
    await deliverWebhooks(db, { ids: [id], fetchImpl });
    await db.run("UPDATE webhook_deliveries SET status = 'failed' WHERE id = ? AND status = 'pending'", id); // tests aren't retried
    res.json(await db.get('SELECT id, status, response_code, last_error FROM webhook_deliveries WHERE id = ?', id));
  });
  return r;
}
export { emitEvent };
