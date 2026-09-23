import { sealSecret, openSecret } from './sso.js';

// Online reviews: pulled from Google Business Profile (the office's own listing, connected by its owner),
// shown with the office's own post-visit survey scores, and answered — with an AI draft a person edits.
//   GOOGLE_BUSINESS=sandbox           pretend listing with sample reviews (demos)
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  an OAuth client with the Business Profile API enabled
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export function createGoogleBusiness({ config, fetchImpl = globalThis.fetch }) {
  if (config.googleBusiness === 'sandbox') {
    const replies = new Map();
    const sample = (i, stars, name, text, daysAgo) => ({ reviewId: `sbx-${i}`, reviewer: { displayName: name }, starRating: Object.keys(STARS)[stars - 1], comment: text, createTime: new Date(Date.now() - daysAgo * 86400_000).toISOString(), reviewReply: replies.get(`sbx-${i}`) });
    return {
      mode: 'sandbox',
      authUrl: (state, redirect) => `${redirect}?code=sandbox&state=${encodeURIComponent(state)}`,
      exchange: async () => ({ accessToken: 'sbx', refreshToken: 'sbx-refresh', expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
      refresh: async () => ({ accessToken: 'sbx', expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
      locations: async () => [{ name: 'accounts/1/locations/1', title: 'Your practice (sandbox)' }],
      reviews: async () => [
        sample(1, 5, 'Maria G.', 'Dr. Lee and the whole team were wonderful. No wait, very gentle cleaning!', 2),
        sample(2, 2, 'Tom R.', 'Waited 40 minutes past my appointment time and nobody explained why.', 5),
        sample(3, 4, 'Priya S.', 'Great care, but the parking lot is tiny.', 11),
        sample(4, 5, 'Anonymous', '', 20),
      ],
      reply: async (_loc, reviewId, text) => { replies.set(reviewId, { comment: text, updateTime: new Date().toISOString() }); },
    };
  }
  if (!config.googleClientId || !config.googleClientSecret) return null;
  const token = async (params) => {
    const res = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...params }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error_description || d.error || `Google error ${res.status}`);
    return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: new Date(Date.now() + (d.expires_in || 3600) * 1000).toISOString() };
  };
  const get = async (url, access, opts = {}) => {
    const res = await fetchImpl(url, { ...opts, headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error?.message || `Google error ${res.status}`);
    return d;
  };
  return {
    mode: 'google',
    authUrl: (state, redirect) => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: config.googleClientId, redirect_uri: redirect, response_type: 'code', scope: 'https://www.googleapis.com/auth/business.manage', access_type: 'offline', prompt: 'consent', state })}`,
    exchange: (code, redirect) => token({ grant_type: 'authorization_code', code, redirect_uri: redirect }),
    refresh: (refreshToken) => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    async locations(access) {
      const accounts = (await get('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', access)).accounts || [];
      const out = [];
      for (const a of accounts) {
        const locs = (await get(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title`, access)).locations || [];
        for (const l of locs) out.push({ name: `${a.name}/${l.name}`, title: l.title });
      }
      return out;
    },
    async reviews(access, location) {
      const out = [];
      let page = '';
      for (let i = 0; i < 10; i++) {
        const d = await get(`https://mybusiness.googleapis.com/v4/${location}/reviews?pageSize=50${page ? `&pageToken=${page}` : ''}`, access);
        out.push(...(d.reviews || []));
        if (!d.nextPageToken) break;
        page = d.nextPageToken;
      }
      return out;
    },
    reply: (access, location, reviewId, text) => get(`https://mybusiness.googleapis.com/v4/${location}/reviews/${reviewId}/reply`, access, { method: 'PUT', body: JSON.stringify({ comment: text }) }),
  };
}

async function accessFor(db, gbp, secret, conn) {
  if (conn.expires_at && conn.expires_at > new Date(Date.now() + 60_000).toISOString()) return openSecret(conn.access_token, secret, 'gbp');
  const t = await gbp.refresh(openSecret(conn.refresh_token, secret, 'gbp'));
  await db.run('UPDATE review_connections SET access_token = ?, expires_at = ? WHERE id = ?', sealSecret(t.accessToken, secret, 'gbp'), t.expiresAt, conn.id);
  return t.accessToken;
}

export async function syncReviews(db, gbp, secret, pid) {
  const conn = await db.get('SELECT * FROM review_connections WHERE practice_id = ?', pid);
  if (!conn || !gbp) return { synced: 0 };
  const access = await accessFor(db, gbp, secret, conn);
  const list = await gbp.reviews(access, conn.location);
  let n = 0;
  for (const r of list) {
    const row = {
      author: r.reviewer?.displayName || 'A Google user', rating: STARS[r.starRating] || null, text: r.comment || null, posted_at: r.createTime || null,
      reply: r.reviewReply?.comment || null, replied_at: r.reviewReply?.updateTime || null,
    };
    const have = await db.get("SELECT id, reply_status FROM reviews WHERE practice_id = ? AND source = 'google' AND external_id = ?", pid, r.reviewId);
    if (have) {
      await db.run('UPDATE reviews SET author = ?, rating = ?, text = ?, posted_at = ?, reply = COALESCE(?, reply), replied_at = COALESCE(?, replied_at), reply_status = ? WHERE id = ?',
        row.author, row.rating, row.text, row.posted_at, row.reply, row.replied_at, row.reply ? 'posted' : have.reply_status, have.id);
    } else {
      await db.run("INSERT INTO reviews (practice_id, source, external_id, author, rating, text, posted_at, reply, replied_at, reply_status) VALUES (?, 'google', ?, ?, ?, ?, ?, ?, ?, ?)",
        pid, r.reviewId, row.author, row.rating, row.text, row.posted_at, row.reply, row.replied_at, row.reply ? 'posted' : 'none');
      n++;
    }
  }
  await db.run("UPDATE review_connections SET synced_at = datetime('now') WHERE id = ?", conn.id);
  return { synced: n, total: list.length };
}

export async function postReply(db, gbp, secret, review, text) {
  const conn = await db.get('SELECT * FROM review_connections WHERE practice_id = ?', review.practice_id);
  if (!conn || !gbp) throw new Error('Connect Google Business Profile first');
  await gbp.reply(await accessFor(db, gbp, secret, conn), conn.location, review.external_id, text);
  await db.run("UPDATE reviews SET reply = ?, reply_status = 'posted', replied_at = datetime('now') WHERE id = ?", text, review.id);
}

export const sealGbp = (v, secret) => sealSecret(v, secret, 'gbp');
