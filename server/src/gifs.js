// GIF search for team chat, behind an adapter so the vendor can be swapped.
//   GIF_PROVIDER=sandbox (default)  a few built-in animated emoji "GIFs": nothing leaves the server.
//   GIF_PROVIDER=tenor              Tenor (GIF_API_KEY, or TENOR_API_KEY).
//   GIF_PROVIDER=giphy              GIPHY (GIF_API_KEY, or GIPHY_API_KEY).
// A practice has to turn GIFs on (chat_settings.gifs_enabled, off by default) before anything is searched.
// Only the words typed in the GIF box are sent, and cleanGifQuery() strips anything that could identify a
// patient first (digits, emails, @handles, and any word that is a patient's name in the practice). Calls go
// through the logged fetch the app hands in, so they show in Settings → Connection activity.

export const SANDBOX_GIFS = [
  { id: 'sb-party', title: 'Party', emoji: '🎉', tags: ['party', 'celebrate', 'yay', 'congrats', 'woohoo', 'birthday'] },
  { id: 'sb-thumbs', title: 'Thumbs up', emoji: '👍', tags: ['ok', 'yes', 'thumbs', 'good', 'great', 'done', 'thanks'] },
  { id: 'sb-clap', title: 'Applause', emoji: '👏', tags: ['clap', 'applause', 'bravo', 'nice', 'great', 'congrats'] },
  { id: 'sb-coffee', title: 'Coffee', emoji: '☕', tags: ['coffee', 'morning', 'tired', 'break', 'monday'] },
  { id: 'sb-tooth', title: 'Happy tooth', emoji: '🦷', tags: ['tooth', 'teeth', 'dental', 'smile', 'clean'] },
  { id: 'sb-lol', title: 'LOL', emoji: '😂', tags: ['lol', 'funny', 'haha', 'laugh'] },
  { id: 'sb-heart', title: 'Love it', emoji: '❤️', tags: ['love', 'heart', 'thanks', 'thank', 'sweet'] },
  { id: 'sb-fire', title: 'On fire', emoji: '🔥', tags: ['fire', 'hot', 'busy', 'crushing', 'awesome'] },
  { id: 'sb-rocket', title: 'Let’s go', emoji: '🚀', tags: ['go', 'launch', 'fast', 'lets', 'ship'] },
  { id: 'sb-pray', title: 'Thank you', emoji: '🙏', tags: ['thanks', 'thank', 'please', 'grateful'] },
  { id: 'sb-wave', title: 'Hello', emoji: '👋', tags: ['hi', 'hello', 'bye', 'wave', 'morning'] },
  { id: 'sb-sweat', title: 'Phew', emoji: '😅', tags: ['phew', 'close', 'busy', 'oops', 'sorry'] },
];

// Where real GIF images may be loaded from (the server fetches them for the browser, see /chat/gifs/media).
export const GIF_MEDIA_HOSTS = /^(media\d*\.tenor\.com|c\.tenor\.com|media\d*\.giphy\.com|i\.giphy\.com)$/;

// The words to search for, with anything that could identify a patient removed. Returns '' when nothing is left.
export async function cleanGifQuery(db, practiceId, raw) {
  let words = String(raw || '')
    .normalize('NFKC')
    .replace(/\S+@\S+/g, ' ') // emails
    .replace(/@\S+/g, ' ') // @handles
    .replace(/[0-9]+/g, ' ') // phone numbers, dates, chart numbers, ages
    .replace(/[^\p{L}\s'-]/gu, ' ')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w.length > 1)
    .slice(0, 6);
  if (words.length && db) {
    const marks = words.map(() => '?').join(',');
    const names = await db.all(
      `SELECT LOWER(first_name) AS f, LOWER(last_name) AS l, LOWER(COALESCE(preferred_name, '')) AS n FROM patients
       WHERE practice_id = ? AND (LOWER(first_name) IN (${marks}) OR LOWER(last_name) IN (${marks}) OR LOWER(COALESCE(preferred_name, '')) IN (${marks})) LIMIT 50`,
      practiceId, ...words, ...words, ...words,
    );
    const hit = new Set(names.flatMap((r) => [r.f, r.l, r.n]).filter(Boolean));
    words = words.filter((w) => !hit.has(w));
  }
  return words.join(' ').slice(0, 50).trim();
}

export function gifConfig(env = process.env) {
  const provider = ['tenor', 'giphy'].includes(env.GIF_PROVIDER) ? env.GIF_PROVIDER : 'sandbox';
  const key = env.GIF_API_KEY || (provider === 'tenor' ? env.TENOR_API_KEY : provider === 'giphy' ? env.GIPHY_API_KEY : null) || null;
  return { provider: provider !== 'sandbox' && !key ? 'sandbox' : provider, key };
}

// search(query) -> [{ id, title, url, preview, emoji, width, height }]. Real results carry image urls on the
// provider's media hosts; sandbox results carry an emoji the chat animates instead.
export function createGifs({ config = gifConfig(), fetchImpl = globalThis.fetch } = {}) {
  const { provider, key } = config;
  if (provider === 'tenor') {
    return {
      provider, name: 'Tenor',
      async search(q) {
        const url = `https://tenor.googleapis.com/v2/search?${new URLSearchParams({ q, key, limit: '18', media_filter: 'gif,tinygif', contentfilter: 'high', client_key: 'dentalmachine' })}`;
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`GIF search failed (${res.status})`);
        const data = await res.json();
        return (data.results || []).map((r) => ({
          id: `tenor:${r.id}`, title: String(r.content_description || '').slice(0, 80),
          url: r.media_formats?.gif?.url, preview: r.media_formats?.tinygif?.url || r.media_formats?.gif?.url,
          width: r.media_formats?.tinygif?.dims?.[0] || null, height: r.media_formats?.tinygif?.dims?.[1] || null,
        })).filter((g) => g.url);
      },
    };
  }
  if (provider === 'giphy') {
    return {
      provider, name: 'GIPHY',
      async search(q) {
        const url = `https://api.giphy.com/v1/gifs/search?${new URLSearchParams({ api_key: key, q, limit: '18', rating: 'g', lang: 'en' })}`;
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`GIF search failed (${res.status})`);
        const data = await res.json();
        return (data.data || []).map((r) => ({
          id: `giphy:${r.id}`, title: String(r.title || '').slice(0, 80),
          url: r.images?.downsized?.url || r.images?.original?.url, preview: r.images?.fixed_width_small?.url || r.images?.fixed_width?.url,
          width: Number(r.images?.fixed_width_small?.width) || null, height: Number(r.images?.fixed_width_small?.height) || null,
        })).filter((g) => g.url);
      },
    };
  }
  return {
    provider: 'sandbox', name: 'Built-in (sandbox)',
    async search(q) {
      const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
      const hits = words.length ? SANDBOX_GIFS.filter((g) => words.some((w) => g.tags.some((t) => t.startsWith(w)) || g.title.toLowerCase().includes(w))) : SANDBOX_GIFS;
      return (hits.length ? hits : SANDBOX_GIFS).map(({ id, title, emoji }) => ({ id, title, emoji, url: null, preview: null }));
    },
  };
}

// A GIF picked from results, checked before it's stored on a message: sandbox ids, or real images on the
// provider's media hosts only (never an arbitrary address the browser would be made to load).
export function cleanGif(g) {
  if (!g || typeof g !== 'object') return null;
  const sandbox = SANDBOX_GIFS.find((s) => s.id === g.id);
  if (sandbox) return { id: sandbox.id, title: sandbox.title, emoji: sandbox.emoji };
  const okUrl = (u) => {
    try {
      const url = new URL(String(u));
      return url.protocol === 'https:' && GIF_MEDIA_HOSTS.test(url.hostname) ? url.toString() : null;
    } catch {
      return null;
    }
  };
  const url = okUrl(g.url);
  if (!url || !/^(tenor|giphy):[\w-]{1,80}$/.test(String(g.id || ''))) return null;
  return { id: String(g.id), title: String(g.title || '').slice(0, 80), url, preview: okUrl(g.preview) || url };
}
