// The e2e server for the fee schedules workflow (FS): the normal app, with the fee schedule routes
// (routes/feeschedules.js) added inside its signed-in /api router until they are mounted in app.js — so sign-in,
// the actor, the AI guard and idempotency apply exactly as in production. Once app.js mounts them, this adds nothing.
// Started by e2e/workflows/FS-fees.test.mjs through startApp({ entry }).
import { openDb } from '../../server/src/db.js';
import { createApp, loadConfig } from '../../server/src/app.js';
import { createMessenger } from '../../server/src/messaging.js';
import feeScheduleRoutes from '../../server/src/routes/feeschedules.js';

const secret = process.env.JWT_SECRET;
const db = await openDb();
const config = loadConfig();
const app = createApp({ db, secret, config, messenger: createMessenger() });
const has = (stack) => stack.some((l) => l.route?.path === '/fees/schedules' || (l.handle?.stack && has(l.handle.stack)));
if (!has(app.router.stack)) {
  const api = app.router.stack.filter((l) => l.name === 'router' && l.handle?.stack).sort((a, b) => b.handle.stack.length - a.handle.stack.length)[0].handle;
  api.use(feeScheduleRoutes({ db, config }));
}
app.listen(Number(process.env.PORT) || 4000);
