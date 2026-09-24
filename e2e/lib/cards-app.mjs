// The e2e server for preferences, personal notes, doctor's notes, "moved by us" and card layouts (PP/DN/S8/S6):
// the normal app, with those routes (routes/cards.js, doctornotes.js, officemoves.js) in front of it until they
// are mounted in app.js (after that this layer answers first, harmlessly). Started by
// e2e/workflows/CARDS.test.mjs through startApp({ entry }).
import express from 'express';
import { openDb } from '../../server/src/db.js';
import { createApp, loadConfig } from '../../server/src/app.js';
import { createMessenger } from '../../server/src/messaging.js';
import { authenticate } from '../../server/src/auth.js';
import { actorMiddleware, setActor } from '../../server/src/actor.js';
import { flushChanges } from '../../server/src/util.js';
import { officeAccess } from '../../server/src/officeaccess.js';
import cardRoutes from '../../server/src/routes/cards.js';
import doctorNoteRoutes from '../../server/src/routes/doctornotes.js';
import officeMoveRoutes from '../../server/src/routes/officemoves.js';

const secret = process.env.JWT_SECRET;
const db = await openDb();
const config = loadConfig();
const messenger = createMessenger();
const inner = createApp({ db, secret, config, messenger });
const app = express();
app.use(actorMiddleware(db, flushChanges));
const api = express.Router();
api.use(express.json());
api.use(authenticate(db, secret));
api.use((req, _res, next) => {
  setActor({ source: req.get('X-Acting-For') === 'assistant' ? 'ai' : 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
  next();
});
api.use(officeAccess(db));
api.use(cardRoutes({ db }));
api.use(doctorNoteRoutes({ db }));
api.use(officeMoveRoutes({ db, messenger, config }));
const OURS = /^\/(preference-options|patient-preferences|personal-notes|schedule-cards|card-layout|me\/card-layout|schedule-notes|office-reasons|office-moves|provider-out)(\/|$)|^\/patients\/\d+\/(preferences|personal-notes|connection|office-moves)$|^\/appointments\/\d+\/(labels|office-move)$/;
app.use('/api', (req, res, next) => (OURS.test(req.path) ? api(req, res, next) : next()));
app.use(inner);
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, details: err.details }));
app.listen(Number(process.env.PORT) || 4000);
