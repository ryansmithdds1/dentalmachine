// Office intranet (backlog I1–I3): links, SOP pages, announcements, onboarding. Needs intranetRoutes mounted
// in app.js (api.use(intranetRoutes({ db, storage }))).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { harness } from './helpers.js';
import { cleanUrl, canSee } from '../src/intranet.js';
import { parse, render, safeHref } from '../../client/src/components/intranet/md.js';

const h = harness({ config: { documentKey: 'intranet-test-key' } });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d1a1a40000000049454e44ae426082', 'hex');

async function member(api, role, extra = {}) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = (await api.post('/users', { email, name: `${role} person`, role, password: 'correct-horse-battery', ...extra })).data;
  assert.ok(u.id, JSON.stringify(u));
  // Each sign-in from its own address, so the sign-in rate limit doesn't trip across this file.
  const login = await h.client(null, { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }).post('/auth/login', { email, password: 'correct-horse-battery' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { user: u, api: h.client(login.data.token), token: login.data.token };
}
const upload = async (token, path, buf, filename, headers = {}) => {
  const res = await fetch(`${h.origin}/api${path}?filename=${encodeURIComponent(filename)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', ...headers }, body: buf });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const audits = (action, id) => h.db.all('SELECT * FROM audit_log WHERE action = ? AND entity_id = ?', action, id);

test('URL validation: only http(s) web addresses become links', async () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)', 'file:///etc/passwd', 'ftp://files.example.com', 'https://user:pw@evil.example.com', 'http://', 'not a url', '']) {
    assert.throws(() => cleanUrl(bad), (e) => e.status === 400, bad);
  }
  assert.equal(cleanUrl('deltadental.com'), 'https://deltadental.com/');
  assert.equal(cleanUrl('https://www.availity.com/login?x=1'), 'https://www.availity.com/login?x=1');

  const { api } = await h.practice();
  for (const url of ['javascript:alert(document.cookie)', 'data:text/html;base64,PHNjcmlwdD4=']) {
    const res = await api.post('/intranet/links', { title: 'Bad', url, category: 'other' });
    assert.equal(res.status, 400, url);
  }
  const ok = await api.post('/intranet/links', { title: 'Delta Dental', url: 'https://www.deltadental.com', category: 'insurance', pinned: true });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.url, 'https://www.deltadental.com/');
  assert.equal((await api.put(`/intranet/links/${ok.data.id}`, { url: 'javascript:alert(1)' })).status, 400, 'edits are checked too');
  assert.equal((await api.post('/intranet/links', { title: 'X', url: 'https://x.example.com', category: 'bogus' })).status, 400);
});

test('quick links: starters added in one click, never twice; archive and restore; command list', async () => {
  const { api } = await h.practice();
  const starters = (await api.get('/intranet/links/starters')).data;
  assert.ok(starters.length >= 12 && starters.every((s) => !s.added));
  assert.equal((await api.get('/intranet/links')).data.length, 0, 'suggestions are not created on their own');
  const added = await api.post('/intranet/links/starters', { keys: ['delta-dental', 'glidewell', 'gusto'] });
  assert.equal(added.status, 201);
  assert.deepEqual(added.data.map((l) => l.category).sort(), ['insurance', 'labs', 'payroll']);
  await api.post('/intranet/links/starters', { keys: ['delta-dental'] });
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM intranet_links WHERE starter_key = 'delta-dental' AND practice_id = (SELECT practice_id FROM intranet_links WHERE id = ?)", added.data[0].id)).n, 1);
  assert.equal((await api.post('/intranet/links/starters', { keys: ['nope'] })).status, 400);

  const link = added.data.find((l) => l.starter_key === 'glidewell');
  await api.post(`/intranet/links/${link.id}/archive`);
  assert.equal((await h.db.get('SELECT status FROM intranet_links WHERE id = ?', link.id)).status, 'archived', 'archived, still there');
  assert.ok(!(await api.get('/intranet/links')).data.some((l) => l.id === link.id));
  assert.ok((await api.get('/intranet/links?archived=1')).data.some((l) => l.id === link.id));
  assert.equal((await api.del(`/intranet/links/${link.id}`)).status, 404, 'no delete route');
  await api.post(`/intranet/links/${link.id}/restore`);
  const cmds = (await api.get('/intranet/commands')).data;
  assert.deepEqual(cmds.links.map((l) => l.title).sort(), ['Delta Dental', 'Glidewell', 'Gusto']);
  assert.equal((await audits('intranet.link.archive', link.id)).length, 1);
  assert.equal((await audits('intranet.link.restore', link.id)).length, 1);
});

test('practice isolation: nothing crosses practices', async () => {
  const a = await h.practice();
  const b = await h.practice();
  const link = (await a.api.post('/intranet/links', { title: 'Lab', url: 'https://lab.example.com', category: 'labs' })).data;
  const page = (await a.api.post('/intranet/pages', { title: 'Secret SOP', body: 'Alarm code is 1234' })).data;
  const ann = (await a.api.post('/intranet/announcements', { title: 'Party Friday' })).data;
  const up = await upload(a.token, `/intranet/pages/${page.id}/attachments`, PNG, 'map.png');
  assert.equal(up.status, 201);
  const list = (await a.api.post('/intranet/checklists', { title: 'Week 1', items: [{ title: 'Read SOP', page_id: page.id }] })).data;

  assert.equal((await b.api.get('/intranet/links')).data.length, 0);
  assert.equal((await b.api.put(`/intranet/links/${link.id}`, { title: 'Mine now' })).status, 404);
  assert.equal((await b.api.post(`/intranet/links/${link.id}/archive`)).status, 404);
  assert.equal((await b.api.get(`/intranet/pages/${page.id}`)).status, 404);
  assert.equal((await b.api.get(`/intranet/pages/${page.id}/versions`)).status, 404);
  assert.equal((await b.api.put(`/intranet/pages/${page.id}`, { body: 'x' })).status, 404);
  assert.equal((await b.api.post(`/intranet/pages/${page.id}/restore`, { version: 1 })).status, 404);
  assert.equal((await b.api.get('/intranet/search?q=alarm')).data.length, 0);
  assert.equal((await a.api.get('/intranet/search?q=alarm')).data.length, 1);
  assert.equal((await b.api.post(`/intranet/announcements/${ann.id}/ack`)).status, 404);
  assert.equal((await b.api.get(`/intranet/attachments/${up.data.id}/file`)).status, 404);
  assert.equal((await b.api.post('/intranet/onboardings', { checklist_id: list.id, user_id: 1 })).status, 404);
  // B can't point its own records at A's things either.
  assert.equal((await b.api.post('/intranet/checklists', { title: 'x', items: [{ title: 'y', page_id: page.id }] })).status, 404);
  const bOffice = (await b.api.post('/locations', { name: 'B office' })).data;
  assert.equal((await a.api.post('/intranet/links', { title: 'L', url: 'https://l.example.com', location_ids: [bOffice.id] })).status, 400);
  const aUser = (await h.db.get('SELECT id FROM users WHERE practice_id = (SELECT practice_id FROM intranet_pages WHERE id = ?)', page.id)).id;
  assert.equal((await b.api.post('/intranet/onboardings', { checklist_id: (await b.api.post('/intranet/checklists', { title: 'B list', items: [] })).data.id, user_id: aUser })).status, 404);
});

test('office and role visibility', async () => {
  const { api, token } = await h.practice();
  const main = (await api.post('/locations', { name: 'Main St' })).data;
  const west = (await api.post('/locations', { name: 'Westside' })).data;
  const westOnly = (await api.post('/intranet/links', { title: 'West lab', url: 'https://west-lab.example.com', category: 'labs', location_ids: [west.id] })).data;
  await api.post('/intranet/links', { title: 'Everyone', url: 'https://all.example.com' });
  const billingPage = (await api.post('/intranet/pages', { title: 'Write-off rules', body: 'Only billing', roles: ['billing'] })).data;
  assert.deepEqual(billingPage.roles, ['billing']);
  assert.equal((await api.post('/intranet/pages', { title: 'x', roles: ['janitor'] })).status, 400);

  const mainDesk = await member(api, 'front_desk', { location_ids: [main.id] });
  const titles = (await mainDesk.api.get('/intranet/links')).data.map((l) => l.title);
  assert.deepEqual(titles, ['Everyone'], 'a Main St person does not see the Westside link');
  assert.ok(!(await mainDesk.api.get('/intranet/commands')).data.links.some((l) => l.id === westOnly.id));
  const westDesk = await member(api, 'front_desk', { location_ids: [west.id] });
  assert.ok((await westDesk.api.get('/intranet/links')).data.some((l) => l.id === westOnly.id));

  // Someone at every office sees what's for the office their screen is working in.
  const biller = await member(api, 'billing');
  const billerAtMain = h.client(biller.token, { 'X-Location-Id': String(main.id) });
  assert.ok(!(await billerAtMain.get('/intranet/links')).data.some((l) => l.id === westOnly.id));
  assert.ok((await biller.api.get('/intranet/links')).data.some((l) => l.id === westOnly.id), 'no office chosen: every office');

  // Roles.
  assert.equal((await mainDesk.api.get(`/intranet/pages/${billingPage.id}`)).status, 404);
  assert.equal((await biller.api.get(`/intranet/pages/${billingPage.id}`)).status, 200);
  assert.equal((await mainDesk.api.get('/intranet/search?q=only billing')).data.length, 0);
  assert.equal((await biller.api.get('/intranet/search?q=only billing')).data.length, 1);
  // Managers can ask for everything.
  const adminAtMain = h.client(token, { 'X-Location-Id': String(main.id) });
  assert.ok(!(await adminAtMain.get('/intranet/links')).data.some((l) => l.id === westOnly.id));
  assert.ok((await adminAtMain.get('/intranet/links?all=1')).data.some((l) => l.id === westOnly.id));
  assert.ok((await mainDesk.api.get('/intranet/links?all=1')).data.every((l) => l.id !== westOnly.id), 'all=1 is for managers only');
  assert.equal((await h.client(null).get('/intranet/links')).status, 401);
  // The pure rule.
  const user = { role: 'assistant', location_ids: [main.id] };
  assert.equal(canSee({ roles: '["assistant"]', location_ids: null }, user, null), true);
  assert.equal(canSee({ roles: '["hygienist"]', location_ids: null }, user, null), false);
  assert.equal(canSee({ roles: null, location_ids: JSON.stringify([west.id]) }, user, null), false);
  assert.equal(canSee({ roles: null, location_ids: JSON.stringify([west.id]) }, { role: 'admin', location_ids: null }, main.id), false);
  assert.equal(canSee({ roles: '["billing"]', location_ids: null }, { role: 'admin', location_ids: null }, null), true);
});

test('permissions: everyone reads, only managers change', async () => {
  const { api } = await h.practice();
  const page = (await api.post('/intranet/pages', { title: 'Phones', body: 'Answer by the third ring' })).data;
  const desk = await member(api, 'front_desk');
  assert.equal((await desk.api.get(`/intranet/pages/${page.id}`)).status, 200);
  assert.equal((await desk.api.get('/intranet/home')).data.can_manage, false);
  for (const [method, path, body] of [
    ['post', '/intranet/links', { title: 'x', url: 'https://x.example.com' }],
    ['post', '/intranet/pages', { title: 'x' }],
    ['put', `/intranet/pages/${page.id}`, { body: 'changed' }],
    ['post', `/intranet/pages/${page.id}/archive`, {}],
    ['post', `/intranet/pages/${page.id}/restore`, { version: 1 }],
    ['post', `/intranet/pages/${page.id}/reviewed`, {}],
    ['get', `/intranet/pages/${page.id}/acks`],
    ['post', '/intranet/announcements', { title: 'x' }],
    ['post', '/intranet/sections', { name: 'x' }],
    ['post', '/intranet/links/starters', { keys: ['gusto'] }],
    ['post', '/intranet/templates/sterilization', {}],
    ['post', '/intranet/checklists', { title: 'x' }],
    ['get', '/intranet/people'],
  ]) {
    const res = await desk.api[method](path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  const up = await upload(desk.token, `/intranet/pages/${page.id}/attachments`, PNG, 'x.png');
  assert.equal(up.status, 403);
  assert.equal((await h.db.get('SELECT body FROM intranet_pages WHERE id = ?', page.id)).body, 'Answer by the third ring');
});

test('pages: every save is a version, restore adds one, stale saves refused, archive not delete', async () => {
  const { api } = await h.practice();
  const section = (await api.post('/intranet/sections', { name: 'Front desk' })).data;
  assert.equal((await api.post('/intranet/sections', { name: 'front desk' })).status, 409);
  const page = (await api.post('/intranet/pages', { title: 'Check-in', body: '1. Greet', section_id: section.id, review_every_days: 90 })).data;
  assert.equal(page.version, 1);
  assert.ok(page.review_due);
  const v2 = (await api.put(`/intranet/pages/${page.id}`, { body: '1. Greet\n2. Scan the card', base_version: 1, change_note: 'Card step' })).data;
  assert.equal(v2.version, 2);
  const stale = await api.put(`/intranet/pages/${page.id}`, { body: 'overwrite', base_version: 1 });
  assert.equal(stale.status, 409, 'someone saved in between');
  assert.equal((await h.db.get('SELECT body FROM intranet_pages WHERE id = ?', page.id)).body, '1. Greet\n2. Scan the card');
  // A settings-only change doesn't add a version.
  assert.equal((await api.put(`/intranet/pages/${page.id}`, { roles: ['front_desk'] })).data.version, 2);

  const restored = await api.post(`/intranet/pages/${page.id}/restore`, { version: 1 });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.version, 3);
  assert.equal(restored.data.body, '1. Greet');
  const versions = (await api.get(`/intranet/pages/${page.id}/versions`)).data;
  assert.deepEqual(versions.map((v) => v.version), [3, 2, 1]);
  assert.equal(versions[0].restored_from, 1);
  assert.equal(versions[0].change_note, 'Restored version 1');
  assert.equal((await api.get(`/intranet/pages/${page.id}/versions/2`)).data.body, '1. Greet\n2. Scan the card', 'the old text is kept');
  assert.equal((await api.post(`/intranet/pages/${page.id}/restore`, { version: 3 })).status, 400);
  assert.equal((await api.post(`/intranet/pages/${page.id}/restore`, { version: 99 })).status, 404);

  // Archive: gone from lists and search, still in the database with its history; managers can bring it back.
  const desk = await member(api, 'front_desk');
  await api.post(`/intranet/pages/${page.id}/archive`, { reason: 'Replaced' });
  const row = await h.db.get('SELECT status, archived_at FROM intranet_pages WHERE id = ?', page.id);
  assert.equal(row.status, 'archived');
  assert.ok(row.archived_at);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM intranet_page_versions WHERE page_id = ?', page.id)).n, 3);
  assert.equal((await desk.api.get(`/intranet/pages/${page.id}`)).status, 404);
  assert.equal((await desk.api.get('/intranet/search?q=greet')).data.length, 0);
  assert.ok((await api.get('/intranet/pages?archived=1')).data.some((p) => p.id === page.id));
  assert.equal((await api.put(`/intranet/pages/${page.id}`, { body: 'x' })).status, 409);
  assert.equal((await api.del(`/intranet/pages/${page.id}`)).status, 404, 'no delete route');
  assert.equal((await api.post(`/intranet/sections/${section.id}/archive`)).status, 200, 'its only page is archived');
  await api.post(`/intranet/sections/${section.id}/restore`);
  await api.post(`/intranet/pages/${page.id}/unarchive`);
  assert.equal((await desk.api.get(`/intranet/pages/${page.id}`)).status, 200);
  assert.equal((await api.post(`/intranet/sections/${section.id}/archive`)).status, 409, 'a section with pages stays');

  // Reviewed: stamped, next due moves out.
  const reviewed = (await api.post(`/intranet/pages/${page.id}/reviewed`)).data;
  assert.ok(reviewed.last_reviewed_at);
  assert.ok(reviewed.review_due > page.review_due || reviewed.review_due === page.review_due);

  // Audit trail.
  for (const action of ['intranet.page.create', 'intranet.page.save', 'intranet.page.restore', 'intranet.page.archive', 'intranet.page.unarchive', 'intranet.page.reviewed']) {
    assert.ok((await audits(action, page.id)).length >= 1, action);
  }
  const save = (await audits('intranet.page.save', page.id))[0];
  assert.ok(JSON.parse(save.changes).body, 'before/after of the text is in the audit log');
  assert.equal(save.source, 'human');
});

test('acknowledgements: once per person per version, report of who has not', async () => {
  const { api } = await h.practice();
  const page = (await api.post('/intranet/pages', { title: 'Emergency plan', body: 'Call 911', requires_ack: true })).data;
  assert.equal(page.ack_version, 1);
  const desk = await member(api, 'front_desk');
  const hyg = await member(api, 'hygienist');
  const home = (await desk.api.get('/intranet/home')).data;
  assert.ok(home.needs_ack.some((n) => n.kind === 'page' && n.id === page.id));

  assert.equal((await desk.api.post(`/intranet/pages/${page.id}/ack`)).status, 200);
  await desk.api.post(`/intranet/pages/${page.id}/ack`);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM intranet_acks WHERE item_id = ? AND kind = ?', page.id, 'page')).n, 1, 'twice is once');
  assert.equal((await desk.api.get(`/intranet/pages/${page.id}`)).data.acknowledged, true);
  assert.ok(!(await desk.api.get('/intranet/home')).data.needs_ack.some((n) => n.id === page.id));

  let report = (await api.get(`/intranet/pages/${page.id}/acks`)).data;
  assert.deepEqual(report.acknowledged.map((p) => p.user_id), [desk.user.id]);
  assert.ok(report.missing.some((p) => p.user_id === hyg.user.id));
  assert.ok(report.missing.some((p) => p.role === 'admin'));

  // A small fix keeps sign-offs; "ask again" after a real change asks everyone for the new version.
  await api.put(`/intranet/pages/${page.id}`, { body: 'Call 911 first', base_version: 1 });
  assert.equal((await api.get(`/intranet/pages/${page.id}/acks`)).data.acknowledged.length, 1);
  await api.put(`/intranet/pages/${page.id}`, { body: 'Call 911 first. Then the AED.', base_version: 2, reack: true });
  report = (await api.get(`/intranet/pages/${page.id}/acks`)).data;
  assert.equal(report.version, 3);
  assert.equal(report.acknowledged.length, 0);
  assert.ok((await desk.api.get('/intranet/home')).data.needs_ack.some((n) => n.id === page.id));

  // Only people who can see it are expected to sign.
  const rolePage = (await api.post('/intranet/pages', { title: 'Hygiene only', requires_ack: true, roles: ['hygienist'] })).data;
  const r2 = (await api.get(`/intranet/pages/${rolePage.id}/acks`)).data;
  assert.ok(!r2.missing.some((p) => p.user_id === desk.user.id));
  assert.ok(r2.missing.some((p) => p.user_id === hyg.user.id));
  assert.equal((await desk.api.post(`/intranet/pages/${rolePage.id}/ack`)).status, 404);

  // Announcements.
  const ann = (await api.post('/intranet/announcements', { title: 'New sterilizer', body: 'Training at noon', requires_ack: true })).data;
  assert.ok((await desk.api.get('/intranet/home')).data.announcements.some((a) => a.id === ann.id));
  await desk.api.post(`/intranet/announcements/${ann.id}/ack`);
  const annReport = (await api.get(`/intranet/announcements/${ann.id}/acks`)).data;
  assert.deepEqual(annReport.acknowledged.map((p) => p.user_id), [desk.user.id]);
  assert.equal((await audits('intranet.page.acknowledge', page.id)).length, 1);
  assert.equal((await audits('intranet.announcement.acknowledge', ann.id)).length, 1);
  // Expired announcements drop off the home page.
  const old = (await api.post('/intranet/announcements', { title: 'Old news', expires_on: '2020-01-01' })).data;
  assert.ok(!(await desk.api.get('/intranet/home')).data.announcements.some((a) => a.id === old.id));
  assert.equal((await api.post('/intranet/announcements', { title: 'x', expires_on: '2026-02-31' })).status, 400);
  await api.post(`/intranet/announcements/${ann.id}/archive`);
  assert.ok(!(await desk.api.get('/intranet/home')).data.announcements.some((a) => a.id === ann.id));
});

test('attachments: encrypted, practice-scoped, only for people who can see the page', async () => {
  const { api, token } = await h.practice();
  const page = (await api.post('/intranet/pages', { title: 'Where things are', body: '![map](att:1)', roles: ['assistant'] })).data;
  const up = await upload(token, `/intranet/pages/${page.id}/attachments`, PNG, 'office map.png');
  assert.equal(up.status, 201);
  assert.equal(up.data.mime, 'image/png');
  const row = await h.db.get('SELECT * FROM intranet_attachments WHERE id = ?', up.data.id);
  assert.equal(row.encrypted, 1);
  assert.match(row.storage_key, new RegExp(`^${row.practice_id}/`));
  const dir = join(h.config.uploadDir, String(row.practice_id));
  const onDisk = readFileSync(join(dir, readdirSync(dir).find((f) => row.storage_key.endsWith(f))));
  assert.ok(!onDisk.includes(PNG.subarray(0, 8)), 'not stored in the clear');

  const file = await fetch(`${h.origin}/api/intranet/attachments/${up.data.id}/file`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(file.status, 200);
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(PNG));
  assert.match(file.headers.get('content-security-policy'), /sandbox/);

  const desk = await member(api, 'front_desk');
  assert.equal((await desk.api.get(`/intranet/attachments/${up.data.id}/file`)).status, 404, 'page is for assistants');
  const assistant = await member(api, 'assistant');
  assert.equal((await assistant.api.get(`/intranet/attachments/${up.data.id}/file`)).status, 200);

  assert.equal((await upload(token, `/intranet/pages/${page.id}/attachments`, Buffer.from('<html><script>alert(1)</script></html>'), 'x.html')).status, 415);
  assert.equal((await upload(token, `/intranet/pages/${page.id}/attachments`, Buffer.from('<svg onload="alert(1)"/>'), 'x.svg', { 'Content-Type': 'image/svg+xml' })).status, 415);

  await api.post(`/intranet/attachments/${up.data.id}/archive`);
  assert.ok(await h.db.get('SELECT id FROM intranet_attachments WHERE id = ? AND archived_at IS NOT NULL', up.data.id), 'archived, not deleted');
  assert.equal((await assistant.api.get(`/intranet/attachments/${up.data.id}/file`)).status, 404);
  assert.equal((await audits('intranet.attachment.upload', up.data.id)).length, 1);
});

test('templates, search, onboarding checklists with progress', async () => {
  const { api } = await h.practice();
  const templates = (await api.get('/intranet/templates')).data;
  assert.deepEqual(templates.map((t) => t.key).sort(), ['medical-emergency', 'new-patient-call', 'opening-closing', 'payment-dispute', 'sterilization']);
  assert.equal((await api.get('/intranet/pages')).data.length, 0, 'templates are offered, not created');
  const emergency = await api.post('/intranet/templates/medical-emergency');
  assert.equal(emergency.status, 201);
  assert.match(emergency.data.body, /Template — adapt this to your office/);
  assert.equal(emergency.data.ack_version, 1);
  const again = await api.post('/intranet/templates/medical-emergency');
  assert.equal(again.data.id, emergency.data.id);
  assert.equal(again.data.already, true);
  await api.post('/intranet/templates/sterilization');
  assert.equal((await api.post('/intranet/templates/nope')).status, 404);
  const sections = (await api.get('/intranet/sections')).data.map((s) => s.name).sort();
  assert.deepEqual(sections, ['Clinical', 'Emergencies']);

  const hits = (await api.get('/intranet/search?q=spore')).data;
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /spore/i);
  assert.equal((await api.get('/intranet/search?q=100%25')).data.length, 0, 'wildcards are literal');

  const desk = await member(api, 'front_desk');
  const list = (await api.post('/intranet/checklists', { title: 'Front desk week 1', items: [{ title: 'Read the emergency plan', page_id: emergency.data.id }, { title: 'Shadow check-in' }] })).data;
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0].page_title, emergency.data.title);
  const assigned = await api.post('/intranet/onboardings', { checklist_id: list.id, user_id: desk.user.id, due_on: '2031-01-15' });
  assert.equal(assigned.status, 201);
  assert.equal((await api.post('/intranet/onboardings', { checklist_id: list.id, user_id: desk.user.id })).data.already, true);
  const mine = (await desk.api.get('/intranet/home')).data.onboarding;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].percent, 0);
  const o = assigned.data;
  let out = (await desk.api.post(`/intranet/onboardings/${o.id}/items/${list.items[0].id}`, { done: true })).data;
  assert.equal(out.percent, 50);
  out = (await desk.api.post(`/intranet/onboardings/${o.id}/items/${list.items[1].id}`, { done: true })).data;
  assert.equal(out.status, 'completed');
  out = (await desk.api.post(`/intranet/onboardings/${o.id}/items/${list.items[1].id}`, { done: false })).data;
  assert.equal(out.status, 'active', 'unticking reopens');
  assert.equal(out.done, 1);
  const other = await member(api, 'hygienist');
  assert.equal((await other.api.get(`/intranet/onboardings/${o.id}`)).status, 404, 'someone else’s onboarding');
  assert.equal((await other.api.post(`/intranet/onboardings/${o.id}/items/${list.items[1].id}`, { done: true })).status, 404);
  assert.equal((await api.get(`/intranet/onboardings?user_id=${desk.user.id}`)).data.length, 1);
  // Editing the checklist archives dropped items; ticks already made are kept.
  const edited = (await api.put(`/intranet/checklists/${list.id}`, { items: [{ id: list.items[1].id, title: 'Shadow check-in (2 days)' }] })).data;
  assert.equal(edited.items.length, 1);
  assert.ok(await h.db.get('SELECT id FROM intranet_checklist_items WHERE id = ? AND archived_at IS NOT NULL', list.items[0].id));
  const after = (await desk.api.get(`/intranet/onboardings/${o.id}`)).data;
  assert.equal(after.items.find((i) => i.id === list.items[0].id).done_at != null, true);
  assert.ok((await h.db.all("SELECT * FROM audit_log WHERE action = 'intranet.onboarding.tick'")).length >= 2);
});

test('markdown renderer: safe against script, event handlers and dangerous links', () => {
  const html = (md) => renderToStaticMarkup(createElement('div', null, ...render(md, createElement, { image: (id, alt, key) => createElement('img', { key, alt, src: `blob:att-${id}` }) })));
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click]( javascript:alert(1))',
    '[click](java\tscript:alert(1))',
    '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[click](vbscript:msgbox(1))',
    '[x](//evil.example.com)',
    '![x](javascript:alert(1))',
    '![x](https://tracker.example.com/pixel.gif)',
    '![x" onerror="alert(1)](att:1)',
    '**<b onmouseover=alert(1)>bold</b>**',
    '| <script>x</script> | b |\n|---|---|\n| <iframe src=javascript:alert(1)> | c |',
    '- [ ] <svg onload=alert(1)>',
    '> <a href="javascript:alert(1)">note</a>',
    '```\n</code><script>alert(1)</script>\n```',
    '# <style>body{display:none}</style>',
  ];
  for (const p of payloads) {
    const out = html(p);
    assert.ok(!/<(script|iframe|svg|style|b |a href="javascript)/i.test(out), `${p} → ${out}`);
    assert.ok(!/href="(javascript|data|vbscript):/i.test(out), `${p} → ${out}`);
    // A real attribute is always quoted by React; an injected one would appear as on…=" unescaped.
    assert.ok(!/\son[a-z]+="/i.test(out), `${p} → ${out}`);
    assert.ok(!/src="(?!blob:att-)/i.test(out), `${p} → ${out}`);
  }
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('//evil.example.com'), null);
  assert.deepEqual(safeHref('page:12'), { page: 12 });
  assert.deepEqual(safeHref('https://www.availity.com'), { href: 'https://www.availity.com/' });

  // What it does support.
  const good = html('# Title\n\nSome **bold** and *italic* and `code`.\n\n- [x] done\n- [ ] to do\n\n1. one\n2. two\n\n[Availity](https://www.availity.com) · [SOP](page:3)\n\n![map](att:7)\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(good, /<h2 class="md-h">Title<\/h2>/);
  assert.match(good, /<strong>bold<\/strong>/);
  assert.match(good, /<em>italic<\/em>/);
  assert.match(good, /<ul class="md-checklist"><li class="done"><input type="checkbox"/);
  assert.match(good, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(good, /<a href="https:\/\/www.availity.com\/" target="_blank" rel="noopener noreferrer">Availity<\/a>/);
  assert.match(good, /<a href="\/intranet\/pages\/3">SOP<\/a>/);
  assert.match(good, /<img alt="map" src="blob:att-7"\/>/);
  assert.match(good, /<table/);
  assert.equal(parse('<b>x</b>')[0].c[0].v, '<b>x</b>', 'HTML stays text');
});
