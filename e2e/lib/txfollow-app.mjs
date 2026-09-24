// The e2e server for treatment follow-up (TF): the normal app, with the treatment follow-up routes
// (routes/txfollow.js) added inside its signed-in /api router until they are mounted in app.js — so sign-in, the
// actor, the AI guard and idempotency apply exactly as in production. Once app.js mounts them, this adds nothing.
// Started by e2e/workflows/TF-followup.test.mjs through startApp({ entry }).
import { openDb } from '../../server/src/db.js';
import { createApp, loadConfig } from '../../server/src/app.js';
import { createMessenger } from '../../server/src/messaging.js';
import txFollowRoutes from '../../server/src/routes/txfollow.js';

const secret = process.env.JWT_SECRET;
const db = await openDb();
const config = loadConfig();
const messenger = createMessenger();
const app = createApp({ db, secret, config, messenger });
const has = (stack) => stack.some((l) => l.route?.path === '/txfollow/settings' || (l.handle?.stack && has(l.handle.stack)));
if (!has(app.router.stack)) {
  const api = app.router.stack.filter((l) => l.name === 'router' && l.handle?.stack).sort((a, b) => b.handle.stack.length - a.handle.stack.length)[0].handle;
  api.use(txFollowRoutes({ db, messenger, mailer: null, storage: app.locals.storage, config: app.locals.config || config }));
}
app.listen(Number(process.env.PORT) || 4000);
