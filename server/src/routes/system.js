import { Router } from 'express';
import { HttpError } from '../auth.js';
import { clusterMode } from '../cluster.js';

// What this deployment is connected to, for the Settings → Integrations page (no secrets).
export default function systemRoutes({ db, config, messenger, storage, payments, clearinghouse, erx, mailer }) {
  const r = Router();
  r.get('/integrations', async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Administrator access required');
    const pid = req.user.practice_id;
    const practice = await db.get('SELECT sso_provider, sso_only, online_booking, portal_enabled, slug, id FROM practices WHERE id = ?', pid);
    const agents = await db.all('SELECT last_seen_at FROM bridge_agents WHERE practice_id = ? AND active = 1', pid);
    const online = agents.filter((a) => a.last_seen_at && Date.now() - Date.parse(`${a.last_seen_at.replace(' ', 'T')}Z`) < 90_000).length;
    res.json({
      app_url: config.appUrl,
      platform: { database: db.dialect, cluster: clusterMode(), storage: storage.driver, encrypted: storage.encrypted },
      sms: messenger.status.sms, email: messenger.status.email,
      payments: payments.mode,
      clearinghouse: { mode: clearinghouse.mode, name: clearinghouse.name, realtime: !!clearinghouse.realtime },
      erx: { mode: erx.mode, name: erx.name },
      mail: { mode: mailer.mode, name: mailer.name },
      imaging: { workstations: agents.length, online },
      sso: { provider: practice.sso_provider, required: !!practice.sso_only },
      portal: { enabled: !!practice.portal_enabled, url: `${config.appUrl}/portal/${practice.slug || practice.id}` },
      booking: { enabled: !!practice.online_booking, url: practice.slug ? `${config.appUrl}/book/${practice.slug}` : null },
    });
  });
  return r;
}
