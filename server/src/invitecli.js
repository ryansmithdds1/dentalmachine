// Invitations to create a practice on an invite-only server (REGISTRATION=invite, the production default).
//   npm run invite -- [email] [--days 14] [--note "Smile Dental, Dr. Kim"]
//   npm run invite -- --list
// Prints a link that works once. With an email, only that address can use it.
import { openDb } from './db.js';
import { loadConfig } from './app.js';
import { insert, newToken } from './util.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const config = loadConfig();
const db = await openDb();
try {
  if (args.includes('--list')) {
    for (const i of await db.all('SELECT * FROM signup_invites ORDER BY id DESC LIMIT 50')) {
      const state = i.used_at ? `used ${i.used_at} (practice ${i.practice_id})` : i.expires_at < new Date().toISOString() ? 'expired' : `open until ${i.expires_at.slice(0, 10)}`;
      console.log(`#${i.id}  ${i.email || '(any email)'}  ${i.note || ''}  ${state}`);
    }
  } else {
    const email = args.find((a) => a.includes('@')) || null;
    const days = Number(flag('--days')) || 14;
    const { token, hash } = newToken();
    await insert(db, 'signup_invites', { token_hash: hash, email, note: flag('--note') || null, expires_at: new Date(Date.now() + days * 86400_000).toISOString() });
    console.log(`Invitation${email ? ` for ${email}` : ''}, good for ${days} days, works once:\n${config.appUrl}/#invite=${token}`);
    if (config.registration !== 'invite') console.log('(Sign-up on this server is open to anyone. Set REGISTRATION=invite to require invitations.)');
  }
} finally {
  await db.close();
}
