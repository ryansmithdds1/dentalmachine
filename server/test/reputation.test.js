import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { harness } from './helpers.js';

const seen = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 't', name: 'review_reply', input: { reply: 'We’re sorry to hear this. Please call us at (512) 555-0142 so we can make it right. — The team', caution: 'Wait time complaint: call privately' } }] }));
  });
});
await new Promise((r) => fake.listen(0, r));
after(() => fake.close());
const h = harness({ config: { googleBusiness: 'sandbox', assistant: { enabled: true, apiKey: 'k', baseURL: `http://127.0.0.1:${fake.address().port}`, model: 'claude-opus-5-5', effort: 'low' } } });

test('reputation: connect Google, pull reviews, AI drafts a HIPAA-safe reply, post it', async () => {
  const { api } = await h.practice();
  assert.equal((await api.get('/reputation')).data.connected, false);
  const { url } = (await api.get('/reputation/google/connect')).data;
  const back = await fetch(url.replace('https://app.example.com', h.origin), { redirect: 'manual' });
  assert.equal(back.status, 302);
  assert.match(back.headers.get('location'), /\/reputation\?google=connected/);

  const rep = (await api.get('/reputation')).data;
  assert.equal(rep.connected, true);
  assert.equal(rep.reviews.length, 4);
  assert.deepEqual([rep.summary.rating, rep.summary.count, rep.summary.unanswered_negative], [4, 4, 1]);
  // A sync picks up nothing new, and doesn't duplicate.
  assert.equal((await api.post('/reputation/sync')).data.synced, 0);

  const bad = rep.reviews.find((r) => r.rating === 2);
  const draft = await api.post(`/reviews/${bad.id}/draft`);
  assert.equal(draft.status, 200);
  assert.match(draft.data.reply, /call us/);
  assert.match(seen.at(-1).system, /Never confirm or imply the reviewer is or was a patient/);
  assert.match(seen.at(-1).messages[0].content, /Waited 40 minutes/);
  const posted = await api.post(`/reviews/${bad.id}/reply`, { text: draft.data.reply });
  assert.equal(posted.data.reply_status, 'posted');
  assert.equal((await api.get('/reputation')).data.summary.unanswered_negative, 0);
  // The "Book" button on the Google listing, once online booking is on.
  assert.equal((await api.post('/reputation/google/booking-link')).status, 400);
  await api.put('/practice', { slug: `smile${Date.now()}`, online_booking: true });
  const link = await api.post('/reputation/google/booking-link');
  assert.equal(link.status, 200, JSON.stringify(link.data));
  assert.match(link.data.uri, /\/book\/smile\d+\?src=google$/);
  // The sandbox listing now shows the reply; a sync keeps it.
  await api.post('/reputation/sync');
  assert.equal((await h.db.get('SELECT reply_status FROM reviews WHERE id = ?', bad.id)).reply_status, 'posted');
});
