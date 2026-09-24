// Loads a demo practice with realistic sample data. Usage: npm run seed
import { openDb } from './db.js';
import { seedDemo, DEMO_EMAIL, DEMO_PASSWORD } from './demo.js';

// Demo patients never go into a production database by accident.
if (process.env.APP_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== '1') {
  console.error('Refusing to load demo data: APP_ENV=production. Seed a staging or demo database instead.');
  process.exit(1);
}
const db = await openDb();
const created = await seedDemo(db);
console.log(`Demo practice ${created ? 'created' : 'already exists'}. Log in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
await db.close();
