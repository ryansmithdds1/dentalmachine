import express, { Router } from 'express';
import { HttpError } from '../auth.js';
import { findOr404, insert, update, recorded, audit, practiceNow, isRealDate } from '../util.js';
import { sniffMime } from './imaging.js';
import { publish } from '../events.js';
import {
  requireManage, canManage, canSee, wouldSee, cleanUrl, cleanText, oneLine, cleanRoles, cleanLocations, parseList, nowText, addDays, snippet,
  LINK_CATEGORIES, STARTER_LINKS, PAGE_TEMPLATES,
} from '../intranet.js';

// Office intranet: quick links, SOP pages (with version history, reviews and sign-off), announcements and
// onboarding checklists. See server/src/intranet.js for the rules and docs/workflows/specs/I-intranet.md.
const MAX_BODY = 200_000;
const MAX_ATTACHMENT = 15 * 1024 * 1024;
const ATTACHMENT_TYPES = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/;

const scoped = (row) => (row ? { ...row, location_ids: parseList(row.location_ids), roles: parseList(row.roles) } : row);
const flag = (v) => v === true || v === 1 || v === '1' || v === 'true';

export default function intranetRoutes({ db, storage }) {
  const r = Router();
  const pid = (req) => req.user.practice_id;
  const today = async (req) => (await practiceNow(db, pid(req))).slice(0, 10);
  const announce = (req, what, id) => publish(pid(req), { type: 'intranet', event: what, id, by: req.user.id });
  // Readers see what's meant for them; managers asking for everything (?all=1) see every item.
  const showAll = (req) => canManage(req.user) && flag(req.query.all);
  const see = (req, row) => showAll(req) || canSee(row, req.user, req.location_id);

  // A page this person may open (archived ones only for managers). Other practices' pages don't exist.
  async function pageFor(req, id) {
    const page = await findOr404(db, 'intranet_pages', id, pid(req), 'Page');
    if (canManage(req.user)) return page;
    if (page.status !== 'active' || !canSee(page, req.user, req.location_id)) throw new HttpError(404, 'Page not found');
    return page;
  }
  async function sectionId(req, value) {
    if (value == null || value === '') return null;
    const s = await findOr404(db, 'intranet_sections', value, pid(req), 'Section');
    if (s.status !== 'active') throw new HttpError(400, 'That section is archived');
    return s.id;
  }
  async function scope(req, body) {
    const out = {};
    if (body.location_ids !== undefined) out.location_ids = await cleanLocations(db, pid(req), body.location_ids);
    if (body.roles !== undefined) out.roles = cleanRoles(body.roles);
    return out;
  }
  const acked = async (req, kind, itemId, version) => !!(await db.get('SELECT id FROM intranet_acks WHERE kind = ? AND item_id = ? AND version = ? AND user_id = ?', kind, itemId, version, req.user.id));

  // ---------------------------------------------------------------- Home
  r.get('/intranet/home', async (req, res) => {
    const date = await today(req);
    const [announcements, links, sections, pages, acks] = await Promise.all([
      db.all(`SELECT a.*, u.name AS created_by_name FROM intranet_announcements a LEFT JOIN users u ON u.id = a.created_by
        WHERE a.practice_id = ? AND a.status = 'active' AND (a.expires_on IS NULL OR a.expires_on >= ?) ORDER BY a.pinned DESC, a.id DESC`, pid(req), date),
      db.all("SELECT * FROM intranet_links WHERE practice_id = ? AND status = 'active' ORDER BY pinned DESC, sort, title", pid(req)),
      db.all("SELECT * FROM intranet_sections WHERE practice_id = ? AND status = 'active' ORDER BY sort, name", pid(req)),
      db.all(`SELECT id, section_id, title, version, ack_version, review_due, last_reviewed_at, location_ids, roles, updated_at, template_key
        FROM intranet_pages WHERE practice_id = ? AND status = 'active' ORDER BY title`, pid(req)),
      db.all('SELECT kind, item_id, version FROM intranet_acks WHERE practice_id = ? AND user_id = ?', pid(req), req.user.id),
    ]);
    const mine = new Set(acks.map((a) => `${a.kind}:${a.item_id}:${a.version}`));
    const shownPages = pages.filter((p) => canSee(p, req.user, req.location_id));
    const shownAnnouncements = announcements.filter((a) => canSee(a, req.user, req.location_id))
      .map((a) => ({ ...scoped(a), acknowledged: mine.has(`announcement:${a.id}:1`) }));
    const onboarding = await onboardingsFor(req, { userId: req.user.id });
    res.json({
      can_manage: canManage(req.user),
      today: date,
      announcements: shownAnnouncements,
      links: links.filter((l) => canSee(l, req.user, req.location_id)).map(scoped),
      sections: sections.map((s) => ({ ...s, pages: shownPages.filter((p) => p.section_id === s.id).length })),
      unsectioned: shownPages.filter((p) => !p.section_id || !sections.some((s) => s.id === p.section_id)).length,
      recent: [...shownPages].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 6).map((p) => ({ id: p.id, title: p.title, updated_at: p.updated_at, section_id: p.section_id })),
      needs_ack: [
        ...shownAnnouncements.filter((a) => a.requires_ack && !a.acknowledged).map((a) => ({ kind: 'announcement', id: a.id, title: a.title })),
        ...shownPages.filter((p) => p.ack_version && !mine.has(`page:${p.id}:${p.ack_version}`)).map((p) => ({ kind: 'page', id: p.id, title: p.title, version: p.ack_version })),
      ],
      onboarding,
      reviews_due: canManage(req.user) ? pages.filter((p) => p.review_due && p.review_due <= addDays(date, 14)).map((p) => ({ id: p.id, title: p.title, review_due: p.review_due, overdue: p.review_due < date })) : [],
    });
  });

  // Everything the command bar offers: visible links and page titles.
  r.get('/intranet/commands', async (req, res) => {
    const links = (await db.all("SELECT id, title, url, category, location_ids, roles FROM intranet_links WHERE practice_id = ? AND status = 'active' ORDER BY pinned DESC, sort, title", pid(req)))
      .filter((l) => canSee(l, req.user, req.location_id)).map(({ id, title, url, category }) => ({ id, title, url, category }));
    const pages = (await db.all("SELECT id, title, location_ids, roles FROM intranet_pages WHERE practice_id = ? AND status = 'active' ORDER BY title", pid(req)))
      .filter((p) => canSee(p, req.user, req.location_id)).map(({ id, title }) => ({ id, title }));
    res.json({ links, pages });
  });

  // ---------------------------------------------------------------- I1 Quick links
  r.get('/intranet/links', async (req, res) => {
    const archived = canManage(req.user) && flag(req.query.archived);
    const rows = await db.all(`SELECT * FROM intranet_links WHERE practice_id = ? AND status = ? ORDER BY pinned DESC, category, sort, title`, pid(req), archived ? 'archived' : 'active');
    res.json(rows.filter((l) => archived || see(req, l)).map(scoped));
  });

  async function linkFields(req, body, { partial = false } = {}) {
    const out = {};
    if (!partial || body.title !== undefined) out.title = oneLine(body.title, 'Title', 120, { required: true });
    if (!partial || body.url !== undefined) out.url = cleanUrl(body.url);
    if (!partial || body.category !== undefined) {
      out.category = body.category || 'other';
      if (!LINK_CATEGORIES.includes(out.category)) throw new HttpError(400, `category must be one of: ${LINK_CATEGORIES.join(', ')}`);
    }
    if (body.icon !== undefined) {
      out.icon = body.icon ? String(body.icon).trim() : null;
      if (out.icon && !/^[a-z0-9-]{1,40}$/.test(out.icon)) throw new HttpError(400, 'icon must be an icon name');
    }
    if (body.pinned !== undefined) out.pinned = flag(body.pinned) ? 1 : 0;
    if (body.sort !== undefined) {
      const n = Number(body.sort);
      if (!Number.isInteger(n) || Math.abs(n) > 100000) throw new HttpError(400, 'sort must be a whole number');
      out.sort = n;
    }
    return { ...out, ...(await scope(req, body)) };
  }

  r.post('/intranet/links', requireManage, async (req, res) => {
    const fields = await linkFields(req, req.body || {});
    if (fields.sort === undefined) fields.sort = ((await db.get('SELECT MAX(sort) AS m FROM intranet_links WHERE practice_id = ?', pid(req)))?.m ?? 0) + 1;
    const id = await insert(db, 'intranet_links', { practice_id: pid(req), ...fields, created_by: req.user.id });
    await audit(db, req, 'intranet.link.create', 'intranet_links', id, { title: fields.title, url: fields.url }, { after: fields });
    announce(req, 'links', id);
    res.status(201).json(scoped(await db.get('SELECT * FROM intranet_links WHERE id = ?', id)));
  });

  r.put('/intranet/links/:id', requireManage, async (req, res) => {
    const link = await findOr404(db, 'intranet_links', req.params.id, pid(req), 'Link');
    const fields = await linkFields(req, req.body || {}, { partial: true });
    await update(db, 'intranet_links', link.id, pid(req), { ...fields, updated_at: nowText() });
    await audit(db, req, 'intranet.link.update', 'intranet_links', link.id, { title: fields.title ?? link.title });
    announce(req, 'links', link.id);
    res.json(scoped(await db.get('SELECT * FROM intranet_links WHERE id = ?', link.id)));
  });

  // Drag-free reordering: the ids in the order they should show.
  r.put('/intranet/links-order', requireManage, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
    if (!ids?.length || ids.length > 500) throw new HttpError(400, 'ids must be a list of links');
    for (const id of ids) await findOr404(db, 'intranet_links', id, pid(req), 'Link');
    let n = 0;
    for (const id of ids) await update(db, 'intranet_links', id, pid(req), { sort: ++n });
    await audit(db, req, 'intranet.link.reorder', 'intranet_links', null, { ids });
    announce(req, 'links', null);
    res.json({ ok: true });
  });

  for (const [path, status, action] of [['archive', 'archived', 'intranet.link.archive'], ['restore', 'active', 'intranet.link.restore']]) {
    r.post(`/intranet/links/:id/${path}`, requireManage, async (req, res) => {
      const link = await findOr404(db, 'intranet_links', req.params.id, pid(req), 'Link');
      if (link.status !== status) await update(db, 'intranet_links', link.id, pid(req), { status, archived_at: status === 'archived' ? nowText() : null, updated_at: nowText() });
      await audit(db, req, action, 'intranet_links', link.id, { title: link.title });
      announce(req, 'links', link.id);
      res.json(scoped(await db.get('SELECT * FROM intranet_links WHERE id = ?', link.id)));
    });
  }

  // Suggested sites, marked with whether this practice already has them.
  r.get('/intranet/links/starters', requireManage, async (req, res) => {
    const have = new Map((await db.all('SELECT starter_key, status FROM intranet_links WHERE practice_id = ? AND starter_key IS NOT NULL', pid(req))).map((x) => [x.starter_key, x.status]));
    res.json(STARTER_LINKS.map((s) => ({ ...s, added: have.get(s.key) === 'active' })));
  });
  // Adds one or more suggestions (one click). Adding one again brings back the same link, never a second copy.
  r.post('/intranet/links/starters', requireManage, async (req, res) => {
    const keys = Array.isArray(req.body?.keys) ? [...new Set(req.body.keys.map(String))] : [];
    if (!keys.length) throw new HttpError(400, 'Pick at least one suggestion');
    const bad = keys.find((k) => !STARTER_LINKS.some((s) => s.key === k));
    if (bad) throw new HttpError(400, `Unknown suggestion: ${bad}`);
    const out = [];
    let sort = (await db.get('SELECT MAX(sort) AS m FROM intranet_links WHERE practice_id = ?', pid(req)))?.m ?? 0;
    for (const key of keys) {
      const s = STARTER_LINKS.find((x) => x.key === key);
      const had = await db.get('SELECT * FROM intranet_links WHERE practice_id = ? AND starter_key = ?', pid(req), key);
      if (had) {
        if (had.status !== 'active') {
          await update(db, 'intranet_links', had.id, pid(req), { status: 'active', archived_at: null, updated_at: nowText() });
          await audit(db, req, 'intranet.link.restore', 'intranet_links', had.id, { title: had.title, starter: key });
        }
        out.push(had.id);
        continue;
      }
      try {
        const id = await insert(db, 'intranet_links', { practice_id: pid(req), title: s.title, url: s.url, category: s.category, starter_key: key, sort: ++sort, created_by: req.user.id });
        await audit(db, req, 'intranet.link.create', 'intranet_links', id, { title: s.title, url: s.url, starter: key });
        out.push(id);
      } catch (e) {
        // Two clicks at once: the other one added it.
        if (!/unique|UNIQUE/.test(String(e.message))) throw e;
        out.push((await db.get('SELECT id FROM intranet_links WHERE practice_id = ? AND starter_key = ?', pid(req), key)).id);
      }
    }
    announce(req, 'links', null);
    res.status(201).json((await db.all(`SELECT * FROM intranet_links WHERE id IN (${out.map(() => '?').join(',')}) ORDER BY sort`, ...out)).map(scoped));
  });

  // ---------------------------------------------------------------- I2 Sections
  r.get('/intranet/sections', async (req, res) => {
    const archived = canManage(req.user) && flag(req.query.archived);
    res.json(await db.all('SELECT * FROM intranet_sections WHERE practice_id = ? AND status = ? ORDER BY sort, name', pid(req), archived ? 'archived' : 'active'));
  });
  r.post('/intranet/sections', requireManage, async (req, res) => {
    const name = oneLine(req.body?.name, 'Name', 80, { required: true });
    if (await db.get("SELECT id FROM intranet_sections WHERE practice_id = ? AND status = 'active' AND lower(name) = ?", pid(req), name.toLowerCase())) throw new HttpError(409, 'There is already a section with that name');
    const sort = ((await db.get('SELECT MAX(sort) AS m FROM intranet_sections WHERE practice_id = ?', pid(req)))?.m ?? 0) + 1;
    const id = await insert(db, 'intranet_sections', { practice_id: pid(req), name, description: cleanText(req.body?.description, 'Description', 300), sort, created_by: req.user.id });
    await audit(db, req, 'intranet.section.create', 'intranet_sections', id, { name });
    announce(req, 'sections', id);
    res.status(201).json(await db.get('SELECT * FROM intranet_sections WHERE id = ?', id));
  });
  r.put('/intranet/sections/:id', requireManage, async (req, res) => {
    const s = await findOr404(db, 'intranet_sections', req.params.id, pid(req), 'Section');
    const patch = {};
    if (req.body?.name !== undefined) patch.name = oneLine(req.body.name, 'Name', 80, { required: true });
    if (req.body?.description !== undefined) patch.description = cleanText(req.body.description, 'Description', 300);
    if (req.body?.sort !== undefined) {
      if (!Number.isInteger(Number(req.body.sort))) throw new HttpError(400, 'sort must be a whole number');
      patch.sort = Number(req.body.sort);
    }
    await update(db, 'intranet_sections', s.id, pid(req), patch);
    await audit(db, req, 'intranet.section.update', 'intranet_sections', s.id, { name: patch.name ?? s.name });
    announce(req, 'sections', s.id);
    res.json(await db.get('SELECT * FROM intranet_sections WHERE id = ?', s.id));
  });
  r.post('/intranet/sections/:id/archive', requireManage, async (req, res) => {
    const s = await findOr404(db, 'intranet_sections', req.params.id, pid(req), 'Section');
    const n = (await db.get("SELECT COUNT(*) AS n FROM intranet_pages WHERE section_id = ? AND status = 'active'", s.id)).n;
    if (n) throw new HttpError(409, `Move or archive its ${n} page${n === 1 ? '' : 's'} first`);
    await update(db, 'intranet_sections', s.id, pid(req), { status: 'archived', archived_at: nowText() });
    await audit(db, req, 'intranet.section.archive', 'intranet_sections', s.id, { name: s.name });
    announce(req, 'sections', s.id);
    res.json({ ok: true });
  });
  r.post('/intranet/sections/:id/restore', requireManage, async (req, res) => {
    const s = await findOr404(db, 'intranet_sections', req.params.id, pid(req), 'Section');
    await update(db, 'intranet_sections', s.id, pid(req), { status: 'active', archived_at: null });
    await audit(db, req, 'intranet.section.restore', 'intranet_sections', s.id, { name: s.name });
    announce(req, 'sections', s.id);
    res.json(await db.get('SELECT * FROM intranet_sections WHERE id = ?', s.id));
  });

  // ---------------------------------------------------------------- I2 Pages
  const PAGE_LIST = `SELECT p.id, p.section_id, p.title, p.version, p.ack_version, p.review_every_days, p.review_due, p.last_reviewed_at, p.location_ids, p.roles,
    p.status, p.template_key, p.updated_at, p.archived_at, u.name AS updated_by_name
    FROM intranet_pages p LEFT JOIN users u ON u.id = p.updated_by WHERE p.practice_id = ?`;

  r.get('/intranet/pages', async (req, res) => {
    const archived = canManage(req.user) && flag(req.query.archived);
    const args = [pid(req), archived ? 'archived' : 'active'];
    let sql = `${PAGE_LIST} AND p.status = ?`;
    if (req.query.section_id) {
      sql += ' AND p.section_id = ?';
      args.push(Number(req.query.section_id));
    }
    const rows = await db.all(`${sql} ORDER BY p.title`, ...args);
    res.json(rows.filter((p) => archived || see(req, p)).map(scoped));
  });

  // Search across titles and bodies of the pages this person may see.
  r.get('/intranet/search', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 2) return res.json([]);
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await db.all(
      `SELECT p.id, p.title, p.body, p.section_id, p.location_ids, p.roles, s.name AS section_name FROM intranet_pages p LEFT JOIN intranet_sections s ON s.id = p.section_id
       WHERE p.practice_id = ? AND p.status = 'active' AND (p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\') ORDER BY p.title LIMIT 200`, pid(req), like, like,
    );
    const ql = q.toLowerCase();
    res.json(rows.filter((p) => canSee(p, req.user, req.location_id))
      .sort((a, b) => Number(!a.title.toLowerCase().includes(ql)) - Number(!b.title.toLowerCase().includes(ql)))
      .slice(0, 30)
      .map((p) => ({ id: p.id, title: p.title, section_id: p.section_id, section_name: p.section_name, snippet: snippet(p.body, q) })));
  });

  r.get('/intranet/pages/:id', async (req, res) => {
    const page = await pageFor(req, req.params.id);
    const [section, attachments, reviewer, editor] = await Promise.all([
      page.section_id ? db.get('SELECT id, name FROM intranet_sections WHERE id = ?', page.section_id) : null,
      db.all('SELECT id, filename, mime, size, created_at FROM intranet_attachments WHERE page_id = ? AND archived_at IS NULL ORDER BY id', page.id),
      page.last_reviewed_by ? db.get('SELECT name FROM users WHERE id = ?', page.last_reviewed_by) : null,
      page.updated_by ? db.get('SELECT name FROM users WHERE id = ?', page.updated_by) : null,
    ]);
    const date = await today(req);
    res.json({
      ...scoped(page), section, attachments, last_reviewed_by_name: reviewer?.name ?? null, updated_by_name: editor?.name ?? null,
      review_overdue: !!(page.review_due && page.review_due < date),
      acknowledged: page.ack_version ? await acked(req, 'page', page.id, page.ack_version) : null,
      can_manage: canManage(req.user),
    });
  });

  function reviewEvery(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 7 || n > 1095) throw new HttpError(400, 'Review every must be between 7 and 1095 days');
    return n;
  }

  r.post('/intranet/pages', requireManage, async (req, res) => {
    const b = req.body || {};
    const title = oneLine(b.title, 'Title', 160, { required: true });
    const body = cleanText(b.body, 'Page', MAX_BODY) ?? '';
    const every = reviewEvery(b.review_every_days);
    const date = await today(req);
    const fields = {
      practice_id: pid(req), section_id: await sectionId(req, b.section_id), title, body, version: 1, ...(await scope(req, b)),
      ack_version: flag(b.requires_ack) ? 1 : null, review_every_days: every, review_due: every ? addDays(date, every) : null,
      created_by: req.user.id, updated_by: req.user.id,
    };
    const id = await db.tx(async () => {
      const pageId = await insert(db, 'intranet_pages', fields);
      await insert(db, 'intranet_page_versions', { practice_id: pid(req), page_id: pageId, version: 1, title, body, change_note: cleanText(b.change_note, 'Change note', 300) || 'First version', source: 'human', created_by: req.user.id });
      return pageId;
    });
    await audit(db, req, 'intranet.page.create', 'intranet_pages', id, { title, version: 1 });
    announce(req, 'pages', id);
    res.status(201).json(scoped(await db.get('SELECT * FROM intranet_pages WHERE id = ?', id)));
  });

  // Saving writes a new version whenever the title or text changed. base_version is the version the editor
  // started from: if someone else saved in between, nothing is overwritten (409) and the editor can merge.
  async function saveVersion(req, page, { title, body, note, restoredFrom = null, extra = {} }) {
    const next = page.version + 1;
    try {
      await db.tx(async () => {
        await insert(db, 'intranet_page_versions', { practice_id: pid(req), page_id: page.id, version: next, title, body, change_note: note, restored_from: restoredFrom, source: 'human', created_by: req.user.id });
        const n = (await recorded(db, 'intranet_pages', page.id, () => db.run('UPDATE intranet_pages SET version = ? WHERE id = ? AND version = ?', next, page.id, page.version))).changes;
        if (!n) throw new HttpError(409, 'Someone else just saved this page — reload to see their changes');
        await update(db, 'intranet_pages', page.id, pid(req), { title, body, updated_by: req.user.id, updated_at: nowText(), ...extra });
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (/unique|UNIQUE/.test(String(e.message))) throw new HttpError(409, 'Someone else just saved this page — reload to see their changes');
      throw e;
    }
    return next;
  }

  r.put('/intranet/pages/:id', requireManage, async (req, res) => {
    const page = await findOr404(db, 'intranet_pages', req.params.id, pid(req), 'Page');
    if (page.status !== 'active') throw new HttpError(409, 'This page is archived — bring it back first');
    const b = req.body || {};
    const title = b.title !== undefined ? oneLine(b.title, 'Title', 160, { required: true }) : page.title;
    const body = b.body !== undefined ? cleanText(b.body, 'Page', MAX_BODY) ?? '' : page.body;
    const contentChanged = title !== page.title || body !== page.body;
    if (contentChanged && b.base_version != null && Number(b.base_version) !== page.version) {
      throw new HttpError(409, 'Someone else saved this page while you were editing — reload to see their changes', { current_version: page.version });
    }
    const meta = { ...(await scope(req, b)) };
    if (b.section_id !== undefined) meta.section_id = await sectionId(req, b.section_id);
    if (b.review_every_days !== undefined) {
      meta.review_every_days = reviewEvery(b.review_every_days);
      const from = page.last_reviewed_at ? page.last_reviewed_at.slice(0, 10) : await today(req);
      meta.review_due = meta.review_every_days ? addDays(from, meta.review_every_days) : null;
    }
    let version = page.version;
    const note = cleanText(b.change_note, 'Change note', 300);
    if (contentChanged) version = await saveVersion(req, page, { title, body, note, extra: {} });
    // Sign-off: turning it on asks everyone to acknowledge this version; "ask again" (reack) after a real
    // change asks for the new one. Otherwise earlier acknowledgements still count.
    if (b.requires_ack !== undefined) {
      if (!flag(b.requires_ack)) meta.ack_version = null;
      else if (!page.ack_version || flag(b.reack)) meta.ack_version = version;
    } else if (page.ack_version && flag(b.reack)) meta.ack_version = version;
    if (Object.keys(meta).length) await update(db, 'intranet_pages', page.id, pid(req), { ...meta, updated_at: nowText() });
    await audit(db, req, contentChanged ? 'intranet.page.save' : 'intranet.page.update', 'intranet_pages', page.id, { title, version, change_note: note });
    announce(req, 'pages', page.id);
    res.json(scoped(await db.get('SELECT * FROM intranet_pages WHERE id = ?', page.id)));
  });

  r.get('/intranet/pages/:id/versions', async (req, res) => {
    const page = await pageFor(req, req.params.id);
    res.json(await db.all(
      `SELECT v.id, v.version, v.title, v.change_note, v.restored_from, v.source, v.created_at, u.name AS created_by_name, LENGTH(v.body) AS length
       FROM intranet_page_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.page_id = ? AND v.practice_id = ? ORDER BY v.version DESC`, page.id, pid(req),
    ));
  });
  r.get('/intranet/pages/:id/versions/:version', async (req, res) => {
    const page = await pageFor(req, req.params.id);
    const v = await db.get('SELECT v.*, u.name AS created_by_name FROM intranet_page_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.page_id = ? AND v.practice_id = ? AND v.version = ?', page.id, pid(req), Number(req.params.version));
    if (!v) throw new HttpError(404, 'Version not found');
    res.json(v);
  });
  // Restore = a new version with the old text. The versions in between stay in the history.
  r.post('/intranet/pages/:id/restore', requireManage, async (req, res) => {
    const page = await findOr404(db, 'intranet_pages', req.params.id, pid(req), 'Page');
    if (page.status !== 'active') throw new HttpError(409, 'This page is archived — bring it back first');
    const old = await db.get('SELECT * FROM intranet_page_versions WHERE page_id = ? AND version = ?', page.id, Number(req.body?.version));
    if (!old) throw new HttpError(404, 'Version not found');
    if (old.version === page.version) throw new HttpError(400, 'That is already the current version');
    const version = await saveVersion(req, page, { title: old.title, body: old.body, note: `Restored version ${old.version}`, restoredFrom: old.version });
    await audit(db, req, 'intranet.page.restore', 'intranet_pages', page.id, { title: old.title, restored_from: old.version, version });
    announce(req, 'pages', page.id);
    res.json(scoped(await db.get('SELECT * FROM intranet_pages WHERE id = ?', page.id)));
  });

  for (const [path, status, action] of [['archive', 'archived', 'intranet.page.archive'], ['unarchive', 'active', 'intranet.page.unarchive']]) {
    r.post(`/intranet/pages/:id/${path}`, requireManage, async (req, res) => {
      const page = await findOr404(db, 'intranet_pages', req.params.id, pid(req), 'Page');
      if (page.status !== status) await update(db, 'intranet_pages', page.id, pid(req), { status, archived_at: status === 'archived' ? nowText() : null, updated_at: nowText() });
      await audit(db, req, action, 'intranet_pages', page.id, { title: page.title, reason: cleanText(req.body?.reason, 'Reason', 300) });
      announce(req, 'pages', page.id);
      res.json(scoped(await db.get('SELECT * FROM intranet_pages WHERE id = ?', page.id)));
    });
  }

  // "Still right": stamps the review and sets the next due date.
  r.post('/intranet/pages/:id/reviewed', requireManage, async (req, res) => {
    const page = await findOr404(db, 'intranet_pages', req.params.id, pid(req), 'Page');
    const date = await today(req);
    await update(db, 'intranet_pages', page.id, pid(req), {
      last_reviewed_at: nowText(), last_reviewed_by: req.user.id, review_due: page.review_every_days ? addDays(date, page.review_every_days) : null,
    });
    await audit(db, req, 'intranet.page.reviewed', 'intranet_pages', page.id, { title: page.title, version: page.version });
    announce(req, 'pages', page.id);
    res.json(scoped(await db.get('SELECT * FROM intranet_pages WHERE id = ?', page.id)));
  });

  // Read and acknowledged (the version that was asked for). Twice is the same acknowledgement.
  r.post('/intranet/pages/:id/ack', async (req, res) => {
    const page = await pageFor(req, req.params.id);
    if (page.status !== 'active') throw new HttpError(409, 'This page is archived');
    if (!page.ack_version) throw new HttpError(400, 'This page doesn’t ask for a sign-off');
    await recordAck(req, 'page', page.id, page.ack_version, page.title);
    res.json({ acknowledged: true, version: page.ack_version });
  });
  async function recordAck(req, kind, itemId, version, title) {
    if (await acked(req, kind, itemId, version)) return;
    try {
      const id = await insert(db, 'intranet_acks', { practice_id: pid(req), kind, item_id: itemId, version, user_id: req.user.id });
      await audit(db, req, `intranet.${kind}.acknowledge`, kind === 'page' ? 'intranet_pages' : 'intranet_announcements', itemId, { title, version, ack_id: id });
    } catch (e) {
      if (!/unique|UNIQUE/.test(String(e.message))) throw e; // a double click: already recorded
    }
    announce(req, 'acks', itemId);
  }
  // Who has and hasn't acknowledged: everyone active who would see it.
  async function ackReport(req, kind, item, version) {
    const team = await db.all('SELECT id, name, role, location_ids FROM users WHERE practice_id = ? AND active = 1 ORDER BY name', pid(req));
    const done = new Map((await db.all('SELECT user_id, acknowledged_at FROM intranet_acks WHERE kind = ? AND item_id = ? AND version = ?', kind, item.id, version)).map((a) => [a.user_id, a.acknowledged_at]));
    const people = team.filter((m) => wouldSee(item, m) || done.has(m.id)).map((m) => ({ user_id: m.id, name: m.name, role: m.role, acknowledged_at: done.get(m.id) ?? null }));
    return { version, acknowledged: people.filter((p) => p.acknowledged_at), missing: people.filter((p) => !p.acknowledged_at) };
  }
  r.get('/intranet/pages/:id/acks', requireManage, async (req, res) => {
    const page = await findOr404(db, 'intranet_pages', req.params.id, pid(req), 'Page');
    if (!page.ack_version) return res.json({ version: null, acknowledged: [], missing: [] });
    res.json({ title: page.title, ...(await ackReport(req, 'page', page, page.ack_version)) });
  });

  // Starter SOPs (templates to adapt). Adding one twice returns the page already made.
  r.get('/intranet/templates', requireManage, async (req, res) => {
    const have = new Map((await db.all('SELECT id, template_key, status FROM intranet_pages WHERE practice_id = ? AND template_key IS NOT NULL', pid(req))).map((p) => [p.template_key, p]));
    res.json(PAGE_TEMPLATES.map(({ key, title, section, ack }) => ({ key, title, section, requires_ack: ack, page_id: have.get(key)?.id ?? null, status: have.get(key)?.status ?? null })));
  });
  r.post('/intranet/templates/:key', requireManage, async (req, res) => {
    const t = PAGE_TEMPLATES.find((x) => x.key === req.params.key);
    if (!t) throw new HttpError(404, 'Template not found');
    const had = await db.get('SELECT * FROM intranet_pages WHERE practice_id = ? AND template_key = ?', pid(req), t.key);
    if (had) return res.json({ ...scoped(had), already: true });
    let section = await db.get("SELECT id FROM intranet_sections WHERE practice_id = ? AND status = 'active' AND lower(name) = ?", pid(req), t.section.toLowerCase());
    if (!section) {
      const sort = ((await db.get('SELECT MAX(sort) AS m FROM intranet_sections WHERE practice_id = ?', pid(req)))?.m ?? 0) + 1;
      const sid = await insert(db, 'intranet_sections', { practice_id: pid(req), name: t.section, sort, created_by: req.user.id });
      await audit(db, req, 'intranet.section.create', 'intranet_sections', sid, { name: t.section, from_template: t.key });
      section = { id: sid };
    }
    const date = await today(req);
    let id;
    try {
      id = await db.tx(async () => {
        const pageId = await insert(db, 'intranet_pages', {
          practice_id: pid(req), section_id: section.id, title: t.title, body: t.body, version: 1, template_key: t.key,
          ack_version: t.ack ? 1 : null, review_every_days: t.review, review_due: addDays(date, t.review), created_by: req.user.id, updated_by: req.user.id,
        });
        await insert(db, 'intranet_page_versions', { practice_id: pid(req), page_id: pageId, version: 1, title: t.title, body: t.body, change_note: 'Added from the starter template', source: 'human', created_by: req.user.id });
        return pageId;
      });
    } catch (e) {
      if (!/unique|UNIQUE/.test(String(e.message))) throw e;
      return res.json({ ...scoped(await db.get('SELECT * FROM intranet_pages WHERE practice_id = ? AND template_key = ?', pid(req), t.key)), already: true });
    }
    await audit(db, req, 'intranet.page.create', 'intranet_pages', id, { title: t.title, template: t.key, version: 1 });
    announce(req, 'pages', id);
    res.status(201).json(scoped(await db.get('SELECT * FROM intranet_pages WHERE id = ?', id)));
  });

  // ---------------------------------------------------------------- Attachments (images and files on pages)
  r.post('/intranet/pages/:id/attachments', requireManage, express.raw({ type: () => true, limit: MAX_ATTACHMENT }), async (req, res) => {
    const page = await findOr404(db, 'intranet_pages', req.params.id, pid(req), 'Page');
    if (!storage) throw new HttpError(503, 'File storage isn’t set up');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Empty upload');
    // Go by the file's contents, not what the browser says it is.
    const mime = sniffMime(req.body);
    if (!mime || !ATTACHMENT_TYPES.test(mime)) throw new HttpError(415, 'Only images (PNG, JPEG, GIF, WebP) and PDFs can be attached');
    const filename = String(req.query.filename || 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 200) || 'file';
    const { storageKey, encrypted } = await storage.save(pid(req), req.body);
    const id = await insert(db, 'intranet_attachments', { practice_id: pid(req), page_id: page.id, filename, mime, size: req.body.length, storage_key: storageKey, encrypted: encrypted ? 1 : 0, uploaded_by: req.user.id });
    await audit(db, req, 'intranet.attachment.upload', 'intranet_attachments', id, { page_id: page.id, filename, mime, size: req.body.length });
    res.status(201).json(await db.get('SELECT id, page_id, filename, mime, size, created_at FROM intranet_attachments WHERE id = ?', id));
  });
  r.get('/intranet/attachments/:aid/file', async (req, res) => {
    const a = await findOr404(db, 'intranet_attachments', req.params.aid, pid(req), 'File');
    if (a.archived_at && !canManage(req.user)) throw new HttpError(404, 'File not found');
    await pageFor(req, a.page_id); // only for people who may see the page
    const data = await storage.read(a.storage_key, !!a.encrypted);
    if (!data) throw new HttpError(404, 'File missing from storage');
    res.set({
      'Content-Type': a.mime,
      'Content-Length': data.length,
      'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${a.filename.replace(/"/g, '')}"`,
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(data);
  });
  r.post('/intranet/attachments/:aid/archive', requireManage, async (req, res) => {
    const a = await findOr404(db, 'intranet_attachments', req.params.aid, pid(req), 'File');
    if (!a.archived_at) await recorded(db, 'intranet_attachments', a.id, () => db.run('UPDATE intranet_attachments SET archived_at = ? WHERE id = ?', nowText(), a.id));
    await audit(db, req, 'intranet.attachment.archive', 'intranet_attachments', a.id, { page_id: a.page_id, filename: a.filename });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- I3 Announcements
  async function announcementFields(req, b, { partial = false } = {}) {
    const out = {};
    if (!partial || b.title !== undefined) out.title = oneLine(b.title, 'Title', 160, { required: true });
    if (b.body !== undefined) out.body = cleanText(b.body, 'Message', 20000);
    if (b.pinned !== undefined) out.pinned = flag(b.pinned) ? 1 : 0;
    if (b.requires_ack !== undefined) out.requires_ack = flag(b.requires_ack) ? 1 : 0;
    if (b.expires_on !== undefined) {
      out.expires_on = b.expires_on || null;
      if (out.expires_on && !isRealDate(out.expires_on)) throw new HttpError(400, 'Show until must be a real date');
    }
    return { ...out, ...(await scope(req, b)) };
  }
  r.get('/intranet/announcements', async (req, res) => {
    const archived = canManage(req.user) && flag(req.query.archived);
    const rows = await db.all(`SELECT a.*, u.name AS created_by_name FROM intranet_announcements a LEFT JOIN users u ON u.id = a.created_by
      WHERE a.practice_id = ? AND a.status = ? ORDER BY a.id DESC LIMIT 200`, pid(req), archived ? 'archived' : 'active');
    res.json(rows.filter((a) => archived || see(req, a)).map(scoped));
  });
  r.post('/intranet/announcements', requireManage, async (req, res) => {
    const fields = await announcementFields(req, req.body || {});
    const id = await insert(db, 'intranet_announcements', { practice_id: pid(req), pinned: 1, ...fields, created_by: req.user.id });
    await audit(db, req, 'intranet.announcement.create', 'intranet_announcements', id, { title: fields.title }, { after: fields });
    announce(req, 'announcements', id);
    res.status(201).json(scoped(await db.get('SELECT * FROM intranet_announcements WHERE id = ?', id)));
  });
  r.put('/intranet/announcements/:id', requireManage, async (req, res) => {
    const a = await findOr404(db, 'intranet_announcements', req.params.id, pid(req), 'Announcement');
    const fields = await announcementFields(req, req.body || {}, { partial: true });
    await update(db, 'intranet_announcements', a.id, pid(req), { ...fields, updated_at: nowText() });
    await audit(db, req, 'intranet.announcement.update', 'intranet_announcements', a.id, { title: fields.title ?? a.title });
    announce(req, 'announcements', a.id);
    res.json(scoped(await db.get('SELECT * FROM intranet_announcements WHERE id = ?', a.id)));
  });
  for (const [path, status, action] of [['archive', 'archived', 'intranet.announcement.archive'], ['restore', 'active', 'intranet.announcement.restore']]) {
    r.post(`/intranet/announcements/:id/${path}`, requireManage, async (req, res) => {
      const a = await findOr404(db, 'intranet_announcements', req.params.id, pid(req), 'Announcement');
      if (a.status !== status) await update(db, 'intranet_announcements', a.id, pid(req), { status, archived_at: status === 'archived' ? nowText() : null, updated_at: nowText() });
      await audit(db, req, action, 'intranet_announcements', a.id, { title: a.title });
      announce(req, 'announcements', a.id);
      res.json(scoped(await db.get('SELECT * FROM intranet_announcements WHERE id = ?', a.id)));
    });
  }
  r.post('/intranet/announcements/:id/ack', async (req, res) => {
    const a = await findOr404(db, 'intranet_announcements', req.params.id, pid(req), 'Announcement');
    if (a.status !== 'active' || !canSee(a, req.user, req.location_id)) throw new HttpError(404, 'Announcement not found');
    await recordAck(req, 'announcement', a.id, 1, a.title);
    res.json({ acknowledged: true });
  });
  r.get('/intranet/announcements/:id/acks', requireManage, async (req, res) => {
    const a = await findOr404(db, 'intranet_announcements', req.params.id, pid(req), 'Announcement');
    res.json({ title: a.title, ...(await ackReport(req, 'announcement', a, 1)) });
  });

  // ---------------------------------------------------------------- I3 Onboarding checklists
  async function checklistOut(id) {
    const c = await db.get('SELECT * FROM intranet_checklists WHERE id = ?', id);
    const items = await db.all(`SELECT i.id, i.title, i.page_id, i.sort, p.title AS page_title FROM intranet_checklist_items i LEFT JOIN intranet_pages p ON p.id = i.page_id
      WHERE i.checklist_id = ? AND i.archived_at IS NULL ORDER BY i.sort, i.id`, id);
    return { ...c, items };
  }
  // Items: [{ id?, title, page_id? }]. Items left out are archived (ticks on them are kept).
  async function saveItems(req, checklistId, items) {
    if (!Array.isArray(items)) throw new HttpError(400, 'items must be a list');
    if (items.length > 100) throw new HttpError(400, 'At most 100 items');
    const existing = await db.all('SELECT * FROM intranet_checklist_items WHERE checklist_id = ? AND archived_at IS NULL', checklistId);
    const kept = new Set();
    let sort = 0;
    for (const it of items) {
      const title = oneLine(it?.title, 'Item', 200, { required: true });
      let pageId = null;
      if (it.page_id != null && it.page_id !== '') pageId = (await findOr404(db, 'intranet_pages', it.page_id, pid(req), 'Page')).id;
      const row = { title, page_id: pageId, sort: ++sort };
      const had = it.id != null && existing.find((e) => e.id === Number(it.id));
      if (it.id != null && !had) throw new HttpError(400, 'That item isn’t on this checklist');
      if (had) {
        kept.add(had.id);
        await update(db, 'intranet_checklist_items', had.id, pid(req), row);
      } else {
        await insert(db, 'intranet_checklist_items', { practice_id: pid(req), checklist_id: checklistId, ...row });
      }
    }
    for (const e of existing) if (!kept.has(e.id)) await update(db, 'intranet_checklist_items', e.id, pid(req), { archived_at: nowText() });
  }
  r.get('/intranet/checklists', async (req, res) => {
    const archived = canManage(req.user) && flag(req.query.archived);
    const rows = await db.all('SELECT id FROM intranet_checklists WHERE practice_id = ? AND status = ? ORDER BY title', pid(req), archived ? 'archived' : 'active');
    res.json(await Promise.all(rows.map((c) => checklistOut(c.id))));
  });
  r.post('/intranet/checklists', requireManage, async (req, res) => {
    const b = req.body || {};
    const title = oneLine(b.title, 'Title', 160, { required: true });
    const id = await db.tx(async () => {
      const cid = await insert(db, 'intranet_checklists', { practice_id: pid(req), title, description: cleanText(b.description, 'Description', 1000), created_by: req.user.id });
      await saveItems(req, cid, b.items || []);
      return cid;
    });
    await audit(db, req, 'intranet.checklist.create', 'intranet_checklists', id, { title, items: (b.items || []).length });
    res.status(201).json(await checklistOut(id));
  });
  r.put('/intranet/checklists/:id', requireManage, async (req, res) => {
    const c = await findOr404(db, 'intranet_checklists', req.params.id, pid(req), 'Checklist');
    const b = req.body || {};
    await db.tx(async () => {
      const patch = { updated_at: nowText() };
      if (b.title !== undefined) patch.title = oneLine(b.title, 'Title', 160, { required: true });
      if (b.description !== undefined) patch.description = cleanText(b.description, 'Description', 1000);
      await update(db, 'intranet_checklists', c.id, pid(req), patch);
      if (b.items !== undefined) await saveItems(req, c.id, b.items);
    });
    await audit(db, req, 'intranet.checklist.update', 'intranet_checklists', c.id, { title: b.title ?? c.title });
    res.json(await checklistOut(c.id));
  });
  r.post('/intranet/checklists/:id/archive', requireManage, async (req, res) => {
    const c = await findOr404(db, 'intranet_checklists', req.params.id, pid(req), 'Checklist');
    await update(db, 'intranet_checklists', c.id, pid(req), { status: 'archived', archived_at: nowText(), updated_at: nowText() });
    await audit(db, req, 'intranet.checklist.archive', 'intranet_checklists', c.id, { title: c.title });
    res.json({ ok: true });
  });

  // Onboardings with progress. Everyone sees their own; managers see all (?all=1) or one person's (?user_id=).
  async function onboardingsFor(req, { userId = null, id = null, status = 'active' } = {}) {
    const args = [pid(req)];
    let sql = `SELECT o.*, c.title, u.name AS user_name, b.name AS assigned_by_name FROM intranet_onboardings o JOIN intranet_checklists c ON c.id = o.checklist_id
      JOIN users u ON u.id = o.user_id LEFT JOIN users b ON b.id = o.assigned_by WHERE o.practice_id = ?`;
    if (id) { sql += ' AND o.id = ?'; args.push(id); }
    if (userId) { sql += ' AND o.user_id = ?'; args.push(userId); }
    if (status) { sql += ' AND o.status = ?'; args.push(status); }
    const rows = await db.all(`${sql} ORDER BY o.id DESC LIMIT 200`, ...args);
    const out = [];
    for (const o of rows) {
      const items = await db.all(`SELECT i.id, i.title, i.page_id, p.title AS page_title, s.done_at, d.name AS done_by_name
        FROM intranet_checklist_items i LEFT JOIN intranet_pages p ON p.id = i.page_id
        LEFT JOIN intranet_onboarding_steps s ON s.item_id = i.id AND s.onboarding_id = ? LEFT JOIN users d ON d.id = s.done_by
        WHERE i.checklist_id = ? AND (i.archived_at IS NULL OR s.done_at IS NOT NULL) ORDER BY i.sort, i.id`, o.id, o.checklist_id);
      const done = items.filter((i) => i.done_at).length;
      out.push({ ...o, items, done, total: items.length, percent: items.length ? Math.round((done / items.length) * 100) : 0 });
    }
    return out;
  }
  r.get('/intranet/onboardings', async (req, res) => {
    const manager = canManage(req.user);
    const status = ['active', 'completed', 'cancelled'].includes(req.query.status) ? req.query.status : 'active';
    let userId = req.user.id;
    if (manager && req.query.user_id) userId = Number(req.query.user_id) || -1;
    else if (manager && flag(req.query.all)) userId = null;
    res.json(await onboardingsFor(req, { userId, status }));
  });
  r.post('/intranet/onboardings', requireManage, async (req, res) => {
    const b = req.body || {};
    const c = await findOr404(db, 'intranet_checklists', b.checklist_id, pid(req), 'Checklist');
    if (c.status !== 'active') throw new HttpError(400, 'That checklist is archived');
    const person = await findOr404(db, 'users', b.user_id, pid(req), 'Team member');
    if (!person.active) throw new HttpError(400, 'That person’s account is turned off');
    if (b.due_on && !isRealDate(b.due_on)) throw new HttpError(400, 'Due date must be a real date');
    const dup = await db.get("SELECT id FROM intranet_onboardings WHERE practice_id = ? AND checklist_id = ? AND user_id = ? AND status = 'active'", pid(req), c.id, person.id);
    if (dup) return res.json({ ...(await onboardingsFor(req, { id: dup.id, status: null }))[0], already: true });
    const id = await insert(db, 'intranet_onboardings', { practice_id: pid(req), checklist_id: c.id, user_id: person.id, due_on: b.due_on || null, assigned_by: req.user.id });
    await audit(db, req, 'intranet.onboarding.assign', 'intranet_onboardings', id, { checklist: c.title, user_id: person.id, due_on: b.due_on || null });
    announce(req, 'onboarding', id);
    res.status(201).json((await onboardingsFor(req, { id, status: null }))[0]);
  });
  async function onboardingFor(req, id) {
    const o = await findOr404(db, 'intranet_onboardings', id, pid(req), 'Onboarding');
    if (o.user_id !== req.user.id && !canManage(req.user)) throw new HttpError(404, 'Onboarding not found');
    return o;
  }
  r.get('/intranet/onboardings/:id', async (req, res) => {
    const o = await onboardingFor(req, req.params.id);
    res.json((await onboardingsFor(req, { id: o.id, status: null }))[0]);
  });
  // Tick or untick one item (the new hire, or a manager). The last tick completes the onboarding.
  r.post('/intranet/onboardings/:id/items/:itemId', async (req, res) => {
    const o = await onboardingFor(req, req.params.id);
    if (o.status === 'cancelled') throw new HttpError(409, 'This onboarding was cancelled');
    const item = await db.get('SELECT * FROM intranet_checklist_items WHERE id = ? AND checklist_id = ? AND practice_id = ?', Number(req.params.itemId), o.checklist_id, pid(req));
    if (!item) throw new HttpError(404, 'Item not found');
    const done = req.body?.done !== false;
    let step = await db.get('SELECT * FROM intranet_onboarding_steps WHERE onboarding_id = ? AND item_id = ?', o.id, item.id);
    if (!step) {
      try {
        await insert(db, 'intranet_onboarding_steps', { practice_id: pid(req), onboarding_id: o.id, item_id: item.id });
      } catch (e) {
        if (!/unique|UNIQUE/.test(String(e.message))) throw e;
      }
      step = await db.get('SELECT * FROM intranet_onboarding_steps WHERE onboarding_id = ? AND item_id = ?', o.id, item.id);
    }
    if (!!step.done_at !== done) {
      await update(db, 'intranet_onboarding_steps', step.id, pid(req), done ? { done_at: nowText(), done_by: req.user.id } : { done_at: null, done_by: null });
      await audit(db, req, done ? 'intranet.onboarding.tick' : 'intranet.onboarding.untick', 'intranet_onboarding_steps', step.id, { onboarding_id: o.id, item: item.title, user_id: o.user_id });
    }
    let [out] = await onboardingsFor(req, { id: o.id, status: null });
    const complete = out.total > 0 && out.done === out.total;
    if (complete !== (o.status === 'completed')) {
      await update(db, 'intranet_onboardings', o.id, pid(req), complete ? { status: 'completed', completed_at: nowText() } : { status: 'active', completed_at: null });
      await audit(db, req, complete ? 'intranet.onboarding.complete' : 'intranet.onboarding.reopen', 'intranet_onboardings', o.id, { user_id: o.user_id });
      [out] = await onboardingsFor(req, { id: o.id, status: null });
    }
    announce(req, 'onboarding', o.id);
    res.json(out);
  });
  r.post('/intranet/onboardings/:id/cancel', requireManage, async (req, res) => {
    const o = await findOr404(db, 'intranet_onboardings', req.params.id, pid(req), 'Onboarding');
    await update(db, 'intranet_onboardings', o.id, pid(req), { status: 'cancelled' });
    await audit(db, req, 'intranet.onboarding.cancel', 'intranet_onboardings', o.id, { user_id: o.user_id });
    announce(req, 'onboarding', o.id);
    res.json({ ok: true });
  });

  // The team, for assigning onboarding and choosing who an item is for.
  r.get('/intranet/people', requireManage, async (req, res) => {
    res.json((await db.all('SELECT id, name, role, location_ids FROM users WHERE practice_id = ? AND active = 1 ORDER BY name', pid(req))).map((u) => ({ ...u, location_ids: parseList(u.location_ids) })));
  });

  return r;
}
