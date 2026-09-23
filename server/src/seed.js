// Loads a demo practice with realistic sample data. Usage: npm run seed
import { openDb } from './db.js';
import { seedDemo, DEMO_EMAIL, DEMO_PASSWORD } from './demo.js';

const db = await openDb();
const created = await seedDemo(db);
console.log(`Demo practice ${created ? 'created' : 'already exists'}. Log in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
await db.close();
