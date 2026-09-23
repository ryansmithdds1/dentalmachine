import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { createApp } from './app.js';

let secret = process.env.JWT_SECRET;
if (!secret) {
  if (process.env.NODE_ENV === 'production') {
    console.error('JWT_SECRET must be set in production');
    process.exit(1);
  }
  secret = randomBytes(32).toString('hex');
  console.warn('JWT_SECRET not set; using a random secret (sessions reset on restart)');
}

const db = openDb();
const app = createApp({ db, secret });
const port = Number(process.env.PORT) || 4000;
app.listen(port, () => console.log(`Dental Machine API listening on http://localhost:${port}`));
