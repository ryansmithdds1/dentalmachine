// The benchmark service's HTTP face (BM5): four signed POSTs, all answered by service.js handle().
//   POST /v1/join        register a participant (random id + Ed25519 public key + peer-group profile)
//   POST /v1/submit      the nightly aggregate rows for up to three months
//   POST /v1/benchmarks  this participant's percentiles, peer group and leaderboards for a month
//   POST /v1/leave       delete everything this participant sent
// The body is read as raw text (the signature covers the exact bytes), so mount this router before any JSON body
// parser — or anywhere, since practices send it as application/vnd.dm-benchmark+json, which express.json ignores.
import express, { Router } from 'express';
import { handle, serviceConfig } from './service.js';
import { log } from '../monitoring.js';

export const CONTENT_TYPE = 'application/vnd.dm-benchmark+json';

export default function benchmarkServiceRoutes({ db, config = serviceConfig() }) {
  const r = Router();
  r.get('/v1/health', (_req, res) => res.json({ ok: true, min_peers: config.minPeers }));
  r.post('/v1/:action', express.text({ type: () => true, limit: '1mb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (typeof req.body !== 'string') return res.status(415).json({ error: `Send the body as ${CONTENT_TYPE} (it was already parsed, so the signature can't be checked)` });
    try {
      const out = await handle(db, { path: `/v1/${req.params.action}`, headers: req.headers, body: req.body, config });
      res.status(out.status).json(out.body);
    } catch (err) {
      log.error('Benchmark service error', err);
      res.status(500).json({ error: 'The benchmark service had a problem' });
    }
  });
  return r;
}
