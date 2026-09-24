// The e2e server for the daily workflows (batch 4, 32–44): the normal app, with routes/daily.js added inside its
// signed-in /api router until it is mounted in app.js — so sign-in, the actor, the AI guard and idempotency apply
// exactly as in production. Once app.js mounts it, this adds nothing.
// Started by e2e/workflows/32-44-daily.test.mjs through startApp({ entry }).
import { openDb } from '../../server/src/db.js';
import { createApp, loadConfig } from '../../server/src/app.js';
import { createMessenger } from '../../server/src/messaging.js';
import dailyRoutes from '../../server/src/routes/daily.js';

const secret = process.env.JWT_SECRET;
const db = await openDb();
const config = loadConfig();
const messenger = createMessenger();
const app = createApp({ db, secret, config, messenger });
const has = (stack) => stack.some((l) => l.route?.path === '/daily/preauths/:aid/send' || (l.handle?.stack && has(l.handle.stack)));
if (!has(app.router.stack)) {
  const api = app.router.stack.filter((l) => l.name === 'router' && l.handle?.stack).sort((a, b) => b.handle.stack.length - a.handle.stack.length)[0].handle;
  api.use(dailyRoutes({ db, config: app.locals.config || config, clearinghouse: app.locals.clearinghouse }));
}
app.listen(Number(process.env.PORT) || 4000);
