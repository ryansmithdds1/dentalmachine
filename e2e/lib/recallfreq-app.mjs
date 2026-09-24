// The e2e server for recall types and frequencies (RF): the normal app, with the recall-frequency routes
// (routes/recallfreq.js) in front of it until they are mounted in app.js (after that this layer answers first,
// harmlessly). Started by e2e/workflows/RF-recall.test.mjs through startApp({ entry }).
import express from 'express';
import { openDb } from '../../server/src/db.js';
import { createApp, loadConfig } from '../../server/src/app.js';
import { createMessenger } from '../../server/src/messaging.js';
import { authenticate } from '../../server/src/auth.js';
import { actorMiddleware, setActor } from '../../server/src/actor.js';
import { flushChanges } from '../../server/src/util.js';
import { officeAccess } from '../../server/src/officeaccess.js';
import recallFreqRoutes from '../../server/src/routes/recallfreq.js';

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
  setActor({ source: 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
  next();
});
api.use(officeAccess(db));
api.use(recallFreqRoutes({ db }));
const OURS = /^\/(patients\/\d+\/(recall-status|recall-bundle|outside-procedures|recalls\/switch)$|appointments\/\d+\/recall-bundle$|recalls\/\d+\/(interval|contacted)$|outside-procedures\/\d+\/void$|recall-board(\/|$)|recall-settings$|recall-types\/\d+\/rules$)/;
app.use('/api', (req, res, next) => (OURS.test(req.path) ? api(req, res, next) : next()));
app.use(inner);
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
app.listen(Number(process.env.PORT) || 4000);
