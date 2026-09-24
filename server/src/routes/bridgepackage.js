import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, hashToken } from '../util.js';
import { presetSummaries, SENSOR_PRESETS, buildBridgePackage, BRIDGE_DIR } from '../bridgepackage.js';

// How long after a workstation is added its install package can be made. The key is shown once and only its
// hash is stored, so the server can't put it in a package by itself: the setup wizard sends back the key it
// was just given, and the package is only made while that setup is fresh.
export const PACKAGE_WINDOW_MINUTES = 30;
const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ageMinutes = (sqlTime) => (Date.now() - Date.parse(`${String(sqlTime).replace(' ', 'T').replace(/Z?$/, 'Z')}`)) / 60_000;

// Settings → Imaging bridges → setup wizard: the imaging program presets, and the ready-to-install package.
// Mount inside the signed-in API router (after imagingRoutes): api.use(bridgePackageRoutes({ db, config })).
export default function bridgePackageRoutes({ db, config = {} }) {
  const r = Router();

  r.get('/imaging/presets', requirePermission('clinical:read'), (_req, res) => {
    res.json({ presets: presetSummaries(), sensors: Object.entries(SENSOR_PRESETS).map(([id, name]) => ({ id, name })) });
  });

  // presets.json on its own, for setting a bridge up by hand (it sits next to the bridge program).
  r.get('/imaging/presets-download', requirePermission('clinical:read'), (_req, res) => {
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="presets.json"' }).send(readFileSync(join(BRIDGE_DIR, 'presets.json')));
  });

  // body: { token: the dmb_ key from POST /imaging/agents, apps: [{ preset, command?, watch_folder? }],
  //         sensor?: { preset, kvp?, ma? }, platform?: windows|mac|linux, server?: the address the PC should use }
  r.post('/imaging/agents/:aid/package', requireAdmin, async (req, res) => {
    const agent = await findOr404(db, 'bridge_agents', req.params.aid, req.user.practice_id, 'Workstation');
    if (!agent.active) throw new HttpError(409, 'That workstation was removed');
    const token = String(req.body?.token || '');
    const refuse = async (status, reason) => {
      await audit(db, req, 'bridge.package_refused', 'bridge_agents', agent.id, { reason });
      throw new HttpError(status, `${reason} Remove the workstation and add it again to get a new key and package.`);
    };
    if (!token.startsWith('dmb_') || !sameHash(hashToken(token), agent.token_hash)) await refuse(403, "That isn't this workstation's key.");
    if (!(ageMinutes(agent.created_at) <= PACKAGE_WINDOW_MINUTES)) await refuse(410, `The install package can only be made in the first ${PACKAGE_WINDOW_MINUTES} minutes after adding the workstation (its key is shown only once).`);
    const origin = `${req.protocol}://${req.get('host')}`;
    const pkg = buildBridgePackage({ server: req.body?.server || config.appUrl || origin, token, workstation: agent.name, body: req.body });
    // Who made an installer carrying a live key, for which PC, with what in it (never the key itself).
    await audit(db, req, 'bridge.package', 'bridge_agents', agent.id, { workstation: agent.name, apps: pkg.apps, sensor: pkg.sensor, platform: pkg.platform, files: pkg.files });
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${pkg.filename}"` }).send(pkg.zip);
  });

  return r;
}
