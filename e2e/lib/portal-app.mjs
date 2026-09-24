// The e2e server for patient portal 2.0 and "Pay my bill" (PT): the normal app, with the portal account, bill-pay
// and /billpay.js routers added where app.js will mount them, and the billpay_codes table created, until both are
// in app.js / db.js. Once they are, this adds nothing. Started by e2e/workflows/PT-portal.test.mjs via startApp({ entry }).
import { openDb } from '../../server/src/db.js';
import { createApp, loadConfig } from '../../server/src/app.js';
import { createMessenger } from '../../server/src/messaging.js';
import { ensureBillpaySchema, mountPortalBilling } from '../../server/test/ptmount.js';

const secret = process.env.JWT_SECRET;
const db = await openDb();
await ensureBillpaySchema(db);
const config = loadConfig();
const messenger = createMessenger();
const app = createApp({ db, secret, config, messenger });
mountPortalBilling(app, { db, secret, config, payments: app.locals.payments, messenger });
app.listen(Number(process.env.PORT) || 4000);
