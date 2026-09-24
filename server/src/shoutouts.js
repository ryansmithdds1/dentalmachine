// Team shout-outs (RV3, docs/reviews.md): a staff member named in a patient's feedback or in an online review is
// matched to the team and counted — the quote kept with it — for a monthly leaderboard and optional rewards.
//
// Matching is deliberately cautious, because points are money-adjacent (rewards) and a wrong match is unfair:
// - A name matches an active staff member by first name, "first last", "Dr./Doctor <last>" (dentists) or a
//   nickname the office added (Settings on the Reviews page: "Annie" → Anna Smith).
// - A name that fits more than one person ("Sam" when two people are called Sam) is kept as "needs a match":
//   no points until the owner picks the right person.
// - First names that are also everyday words ("Will", "Joy", "May") only count when written with a capital.
// - A person named in a less-than-happy rating is recorded for coaching, with 0 points.
// Each person is counted once per piece of feedback; re-checking never double counts (a unique key per
// feedback + person). The owner can confirm or unlink any match; unlinked rows are kept, never deleted.
import { audit } from './util.js';

const TITLES = /^(dr|doctor|mr|mrs|ms|miss|mx)\.?$/i;
// First names that are ordinary words too: matched only when capitalised in the text.
const COMMON = new Set(['will', 'may', 'june', 'april', 'august', 'hope', 'joy', 'grace', 'faith', 'art', 'bill', 'rose', 'mark', 'jack', 'sunny', 'summer', 'dawn', 'amber', 'crystal',
  'ruby', 'pat', 'sue', 'rich', 'frank', 'chase', 'drew', 'gene', 'guy', 'ray', 'sky', 'penny', 'holly', 'iris', 'lily', 'ivy', 'destiny', 'harmony', 'honey', 'jewel', 'king', 'hunter',
  'max', 'miles', 'rob', 'sandy', 'robin', 'faye', 'hazel', 'jean', 'storm', 'wade', 'pearl', 'dean', 'don', 'gay', 'kitty', 'lane', 'star', 'autumn', 'brook', 'cliff', 'glen', 'heath']);
// Words that look like names but are part of how people write ("Doctor", "Team").
const STOP = new Set(['dr', 'doctor', 'team', 'staff', 'office', 'the', 'and', 'dentist', 'hygienist']);

export const norm = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();

// "Dr. Ann Lee, DDS" → { first: 'ann', last: 'lee', dr: true }
export function nameParts(full) {
  const words = String(full || '').split(',')[0].split(/\s+/).filter(Boolean);
  const dr = words.length > 0 && /^(dr|doctor)\.?$/i.test(words[0]);
  const rest = words.filter((w) => !TITLES.test(w)).map(norm).filter(Boolean);
  return { first: rest[0] || '', last: rest.length > 1 ? rest[rest.length - 1] : '', dr };
}

// Every phrase that can name someone → the people it could mean.
export function staffIndex(users, nicknames = []) {
  const keys = new Map();
  const add = (phrase, userId, kind) => {
    const p = norm(phrase);
    if (!p || p.length < 2 || STOP.has(p)) return;
    if (!keys.has(p)) keys.set(p, { users: new Set(), kinds: new Set() });
    keys.get(p).users.add(userId);
    keys.get(p).kinds.add(kind);
  };
  for (const u of users) {
    const { first, last, dr } = nameParts(u.name);
    if (first) add(first, u.id, 'first');
    if (first && last) add(`${first} ${last}`, u.id, 'full');
    if (last && (dr || u.role === 'dentist')) {
      add(`dr ${last}`, u.id, 'title');
      add(`doctor ${last}`, u.id, 'title');
      if (first) add(`dr ${first}`, u.id, 'title');
    }
  }
  for (const n of nicknames) add(n.nickname, n.user_id, 'nick');
  return keys;
}

// Sentences with where they start, for quoting the one that names someone.
// "Dr." and friends don't end a sentence (masked with a same-length stand-in, then the original is sliced).
function sentenceAt(text, index) {
  const masked = text.replace(/\b(dr|mr|mrs|ms|mx|st|jr|sr)\./gi, (m) => `${m.slice(0, -1)}\u0000`);
  const re = /[^.!?\n]+[.!?]*/g;
  let m;
  while ((m = re.exec(masked))) {
    if (index >= m.index && index < m.index + m[0].length) return text.slice(m.index, m.index + m[0].length).trim().slice(0, 300);
  }
  return text.trim().slice(0, 300);
}

// Finds who a text names. Returns [{ match_key, matched_name, user_id | null, candidate_ids, quote }].
export function findMentions(text, index) {
  const src = String(text || '');
  if (!src.trim()) return [];
  const words = [...src.matchAll(/[\p{L}][\p{L}’'-]*\.?/gu)].map((m) => ({ raw: m[0].replace(/\.$/, ''), at: m.index, n: norm(m[0]) }));
  const used = new Set();
  const found = new Map();
  const maxLen = Math.max(1, ...[...index.keys()].map((k) => k.split(' ').length));
  // Longer phrases first ("Anna Smith", "Dr. Lee") so the words they use aren't read again as a bare first name.
  for (let len = Math.min(3, maxLen); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      if ([...Array(len).keys()].some((k) => used.has(i + k))) continue;
      const phrase = words.slice(i, i + len).map((w) => w.n).join(' ');
      const hit = index.get(phrase);
      if (!hit) continue;
      const w = words[i];
      // An everyday word ("will", "joy") counts as a name only when written with a capital.
      if (len === 1 && hit.kinds.has('first') && !hit.kinds.has('nick') && COMMON.has(phrase) && !/^\p{Lu}/u.test(w.raw)) continue;
      for (let k = 0; k < len; k++) used.add(i + k);
      const ids = [...hit.users];
      const key = ids.length === 1 ? `u${ids[0]}` : `n${phrase}`;
      if (found.has(key)) continue;
      found.set(key, {
        match_key: key, matched_name: words.slice(i, i + len).map((x) => x.raw).join(' '), user_id: ids.length === 1 ? ids[0] : null,
        candidate_ids: ids.length === 1 ? null : ids.sort((a, b) => a - b), quote: sentenceAt(src, w.at),
      });
    }
  }
  // "Sam" left unclear, but "Sam Ortiz" named elsewhere in the same text: it's that Sam.
  const sure = new Set([...found.values()].filter((f) => f.user_id).map((f) => f.user_id));
  for (const [key, f] of found) if (!f.user_id && f.candidate_ids.some((id) => sure.has(id))) found.delete(key);
  return [...found.values()];
}

export async function staffFor(db, practiceId) {
  const users = await db.all('SELECT id, name, role FROM users WHERE practice_id = ? AND active = 1', practiceId);
  const nicknames = await db.all('SELECT n.user_id, n.nickname FROM staff_nicknames n JOIN users u ON u.id = n.user_id WHERE n.practice_id = ? AND u.active = 1', practiceId);
  return staffIndex(users, nicknames);
}

const pointsSetting = async (db, practiceId) => (await db.get('SELECT points_per_mention FROM review_settings WHERE practice_id = ?', practiceId))?.points_per_mention ?? 10;
const thresholdOf = async (db, practiceId) => (await db.get('SELECT review_threshold FROM practices WHERE id = ?', practiceId))?.review_threshold || 4;

// Records the shout-outs in one piece of feedback or one review. Safe to run again (natural unique key).
export async function recordMentions(db, { practiceId, source, sourceId, patientId = null, text, rating, when }) {
  const index = await staffFor(db, practiceId);
  const mentions = findMentions(text, index);
  if (!mentions.length) return [];
  const positive = rating == null || rating >= (await thresholdOf(db, practiceId));
  const points = positive ? await pointsSetting(db, practiceId) : 0;
  const month = String(when || new Date().toISOString()).slice(0, 7);
  const made = [];
  for (const m of mentions) {
    const r = await db.run(
      `INSERT INTO review_shoutouts (practice_id, source, source_key, review_feedback_id, review_id, patient_id, user_id, match_key, matched_name, candidate_ids, quote, rating, positive, points, month, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (practice_id, source_key, match_key) DO NOTHING`,
      practiceId, source, `${source}:${sourceId}`, source === 'feedback' ? sourceId : null, source === 'review' ? sourceId : null, patientId, m.user_id, m.match_key, m.matched_name.slice(0, 80),
      m.candidate_ids ? JSON.stringify(m.candidate_ids) : null, m.quote, rating ?? null, positive ? 1 : 0, m.user_id ? points : 0, month, m.user_id ? 'counted' : 'needs_match',
    );
    if (r.changes) made.push({ id: r.id, ...m, positive, points: m.user_id ? points : 0 });
  }
  if (made.length) {
    await audit(db, { user: { practice_id: practiceId, id: null } }, 'shoutout.found', source === 'feedback' ? 'review_feedback' : 'reviews', sourceId,
      { patient_id: patientId, mentions: made.map((m) => ({ id: m.id, name: m.matched_name, user_id: m.user_id, points: m.points, needs_match: !m.user_id })) });
  }
  return made;
}

// Online reviews not yet read for names (after a Google sync, and when the Reviews page opens).
export async function scanReviews(db, practiceId) {
  const list = await db.all('SELECT id, text, rating, posted_at, created_at FROM reviews WHERE practice_id = ? AND mentions_checked_at IS NULL ORDER BY id LIMIT 500', practiceId);
  let n = 0;
  for (const r of list) {
    if (r.text) n += (await recordMentions(db, { practiceId, source: 'review', sourceId: r.id, text: r.text, rating: r.rating, when: r.posted_at || r.created_at })).length;
    await db.run("UPDATE reviews SET mentions_checked_at = datetime('now') WHERE id = ?", r.id);
  }
  return n;
}
