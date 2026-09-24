// The e2e server for the business view (BV): the normal app, with the business routes (routes/business.js) added
// inside its signed-in /api router until they are mounted in app.js — so sign-in, the actor, the AI guard and
// idempotency apply exactly as in production. Once app.js mounts them, this adds nothing.
// Started by e2e/workflows/BV-business.test.mjs through startApp({ entry }).
import { openDb } from '../../server/src/db.js';
import { createApp, loadConfig } from '../../server/src/app.js';
import { createMessenger } from '../../server/src/messaging.js';
import businessRoutes from '../../server/src/routes/business.js';

const secret = process.env.JWT_SECRET;
const db = await openDb();
const config = loadConfig();
const app = createApp({ db, secret, config, messenger: createMessenger() });
const has = (stack) => stack.some((l) => l.route?.path === '/business/access' || (l.handle?.stack && has(l.handle.stack)));
if (!has(app.router.stack)) {
  const api = app.router.stack.filter((l) => l.name === 'router' && l.handle?.stack).sort((a, b) => b.handle.stack.length - a.handle.stack.length)[0].handle;
  api.use(businessRoutes({ db }));
}
app.listen(Number(process.env.PORT) || 4000);
