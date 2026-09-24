// Test-only: adds the patient portal 2.0 / "Pay my bill" routers to an app made by createApp, where app.js will
// mount them (docs/workflows/specs/PT-portal.md lists the lines), and creates the billpay_codes table until it is in
// db.js. Once app.js mounts the routers this adds nothing.
import { BILLPAY_TABLES, resetTableCheck } from '../src/billpay.js';
import portalAccountRoutes from '../src/routes/portalaccount.js';
import billpayPublicRoutes, { billpayEmbedRoutes, billpayStaffRoutes } from '../src/routes/billpay.js';

const isPg = (db) => db.dialect === 'postgres' || !!process.env.TEST_DATABASE_URL;

export async function ensureBillpaySchema(db) {
  for (const sql of BILLPAY_TABLES) await db.run(isPg(db) ? sql.replace('id INTEGER PRIMARY KEY', 'id SERIAL PRIMARY KEY') : sql);
  resetTableCheck();
}

const hasPath = (stack, path) => stack.some((l) => l.route?.path === path || (l.handle?.stack && hasPath(l.handle.stack, path)));

export function mountPortalBilling(app, { db, secret, config, payments, messenger }) {
  if (hasPath(app.router.stack, '/billpay/:slug/lookup')) return;
  const stack = app.router.stack;
  // The signed-in staff router: the biggest router (it holds every staff route).
  const apiLayer = stack.filter((l) => l.name === 'router' && l.handle?.stack).sort((a, b) => b.handle.stack.length - a.handle.stack.length)[0];
  apiLayer.handle.use(billpayStaffRoutes({ db, config, payments }));
  // Public and portal routers go before the staff router (which asks every /api request to sign in).
  // The portal account router goes just before routes/portal.js (as app.js should mount it).
  const portalLayer = stack.find((l) => l.handle?.stack && hasPath(l.handle.stack, '/statement.pdf'));
  let before = stack.length;
  app.use('/api/portal', portalAccountRoutes({ db, secret, config, payments, messenger }));
  stack.splice(stack.indexOf(portalLayer), 0, ...stack.splice(before, stack.length - before));
  before = stack.length;
  app.use('/api/public', billpayPublicRoutes({ db, secret, payments, messenger, config }));
  app.use(billpayEmbedRoutes());
  stack.splice(stack.indexOf(apiLayer), 0, ...stack.splice(before, stack.length - before));
}
