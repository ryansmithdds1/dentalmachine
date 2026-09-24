import express, { Router } from 'express';
import { HttpError, can } from '../auth.js';
import { insert, update, audit, findOr404, requireOneOf, practiceNow } from '../util.js';
import { currentActor } from '../actor.js';
import { canSeePatient, patientScope } from '../officeaccess.js';
import { publish } from '../events.js';
import { sniffMime } from './imaging.js';
import {
  ensureChat, join, membersOf, readableChannel, readableMessage, visiblePatients, resolveMentions, announce, unreadFor,
  pendingUrgent, runRecurringTasks, cleanRepeat, firstOnOrAfter, validDate, MAX_BODY, MAX_GROUP,
} from '../chat.js';
import { createGifs, gifConfig, cleanGif, cleanGifQuery, GIF_MEDIA_HOSTS } from '../gifs.js';

// Team chat and tasks (backlog T1–T5). Every signed-in staff member can chat; everything is scoped to their
// practice, DMs and groups to their members, and messages about a patient to the people who may see that
// patient. See chat.js for the shared rules and docs/workflows/specs/T-chat.md for the workflow.
const MAX_FILE = 15 * 1024 * 1024;
const FILE_TYPES = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/;
const CLIENT_KEY = /^[\w.:-]{8,80}$/;
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200d\ufe0f\u20e3#*0-9]|\p{Emoji_Modifier}){1,12}$/u;
const TASK_SELECT = `SELECT t.*, p.first_name, p.last_name, p.preferred_name, u.name AS assigned_to_name, c.name AS created_by_name, d.name AS completed_by_name,
    o.series_id, s.rule AS repeat_rule
  FROM tasks t LEFT JOIN patients p ON p.id = t.patient_id LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN users c ON c.id = t.created_by
  LEFT JOIN users d ON d.id = t.completed_by LEFT JOIN task_occurrences o ON o.task_id = t.id LEFT JOIN task_series s ON s.id = o.series_id`;
const idList = (v) => (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
const marks = (a) => a.map(() => '?').join(',');
const nameOf = (p) => `${p.first_name}${p.preferred_name ? ` "${p.preferred_name}"` : ''} ${p.last_name}`;
const parseJson = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

export default function chatRoutes({ db, storage, fetchImpl = globalThis.fetch, gifs = null }) {
  const r = Router();
  const gifSearch = gifs || createGifs({ config: gifConfig(), fetchImpl });

  // Everyone signed in chats; changing tasks needs the same write access as the To-do list (office.js).
  const staff = (req, _res, next) => (req.user?.practice_id ? next() : next(new HttpError(401, 'Authentication required')));
  const taskWriter = (req, _res, next) => (['patients:write', 'billing:write', 'clinical:write'].some((p) => can(req.user, p)) ? next() : next(new HttpError(403, "You don't have permission to change tasks")));
  r.use('/chat', staff);

  const settingsOf = async (pid) => {
    await db.run('INSERT INTO chat_settings (practice_id) VALUES (?) ON CONFLICT (practice_id) DO NOTHING', pid);
    return db.get('SELECT * FROM chat_settings WHERE practice_id = ?', pid);
  };

  // Reading a message about a patient is a PHI view, recorded like the chart's (once a minute per person and patient).
  const recent = new Map();
  const notePatientViews = async (req, rows, action = 'chat.patient_message.view') => {
    const now = Date.now();
    for (const row of rows) {
      if (!row.patient_id || row.status === 'deleted') continue;
      const key = `${req.user.id}|${row.patient_id}|${action}`;
      if (now - (recent.get(key) || 0) < 60_000) continue;
      recent.set(key, now);
      await audit(db, req, action, 'chat_messages', row.id, { patient_id: row.patient_id, channel_id: row.channel_id });
    }
    if (recent.size > 5000) for (const [k, t] of recent) if (now - t > 60_000) recent.delete(k);
  };

  // Messages as screens show them: author, patient chip, reactions, files, replies, "Got it" count and tasks.
  // Deleted messages keep their place but not their text; a message about a patient this person can't see
  // (another office) shows that it exists and nothing more.
  const MSG_SELECT = 'SELECT x.*, u.name AS author_name FROM chat_messages x LEFT JOIN users u ON u.id = x.user_id';
  async function hydrate(req, rows) {
    if (!rows.length) return [];
    const me = req.user.id;
    const ids = rows.map((x) => x.id);
    const q = marks(ids);
    const visible = await visiblePatients(db, req.user, rows.map((x) => x.patient_id));
    const patients = visible.size ? await db.all(`SELECT id, first_name, last_name, preferred_name FROM patients WHERE id IN (${marks([...visible])})`, ...visible) : [];
    const reactions = await db.all(`SELECT e.message_id, e.emoji, e.user_id, u.name FROM chat_reactions e LEFT JOIN users u ON u.id = e.user_id WHERE e.message_id IN (${q}) ORDER BY e.id`, ...ids);
    const files = await db.all(`SELECT id, message_id, filename, mime, size FROM chat_attachments WHERE message_id IN (${q}) ORDER BY id`, ...ids);
    const replies = await db.all(`SELECT parent_id, COUNT(*) AS n, MAX(created_at) AS last_at FROM chat_messages WHERE parent_id IN (${q}) AND status = 'active' GROUP BY parent_id`, ...ids);
    const acks = await db.all(`SELECT message_id, COUNT(*) AS n, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine FROM chat_acks WHERE message_id IN (${q}) GROUP BY message_id`, me, ...ids);
    const tasks = await db.all(`SELECT t.id, t.chat_message_id, t.status, t.title, t.assigned_to, u.name AS assigned_to_name FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to WHERE t.chat_message_id IN (${q})`, ...ids);
    const pById = new Map(patients.map((p) => [p.id, p]));
    const group = (list, key) => list.reduce((m, x) => m.set(x[key], [...(m.get(x[key]) || []), x]), new Map());
    const rx = group(reactions, 'message_id');
    const fx = group(files, 'message_id');
    const tx = group(tasks, 'chat_message_id');
    const rp = new Map(replies.map((x) => [x.parent_id, x]));
    const ak = new Map(acks.map((x) => [x.message_id, x]));
    return rows.map((x) => {
      const deleted = x.status === 'deleted';
      const hidden = !deleted && x.patient_id && !visible.has(x.patient_id);
      const p = !deleted && !hidden && x.patient_id ? pById.get(x.patient_id) : null;
      const emo = new Map();
      for (const e of rx.get(x.id) || []) {
        const cur = emo.get(e.emoji) || { emoji: e.emoji, count: 0, mine: false, names: [] };
        cur.count++;
        cur.mine ||= e.user_id === me;
        cur.names.push(e.name);
        emo.set(e.emoji, cur);
      }
      return {
        id: x.id, channel_id: x.channel_id, parent_id: x.parent_id, user_id: x.user_id, author_name: x.author_name || (x.source === 'automation' ? 'Dental Machine' : null),
        source: x.source, kind: x.kind, status: x.status, urgent: !!x.urgent, created_at: x.created_at, edited_at: x.edited_at, deleted_at: x.deleted_at,
        body: deleted || hidden ? null : x.body,
        gif: deleted || hidden ? null : parseJson(x.gif),
        hidden: !!hidden,
        patient_id: p ? p.id : null,
        patient: p ? { id: p.id, name: nameOf(p) } : null,
        reactions: deleted || hidden ? [] : [...emo.values()],
        attachments: deleted || hidden ? [] : fx.get(x.id) || [],
        reply_count: Number(rp.get(x.id)?.n || 0), last_reply_at: rp.get(x.id)?.last_at || null,
        acks: x.urgent ? { count: Number(ak.get(x.id)?.n || 0), mine: Number(ak.get(x.id)?.mine || 0) > 0 } : null,
        tasks: (tx.get(x.id) || []).map(({ chat_message_id: _m, ...t }) => t),
        mine: x.user_id === me,
      };
    });
  }
  const oneMessage = async (req, id) => (await hydrate(req, await db.all(`${MSG_SELECT} WHERE x.id = ?`, id)))[0];

  // ---- Start-up: everything the panel needs in one call ----
  r.get('/chat/bootstrap', async (req, res) => {
    const u = req.user;
    await ensureChat(db, u);
    const settings = await settingsOf(u.practice_id);
    const unread = await unreadFor(db, u);
    const byId = new Map(unread.channels.map((c) => [c.channel_id, c]));
    const channels = await db.all(
      `SELECT c.id, c.kind, c.name, c.slug, c.topic, c.audience, c.location_id, c.dm_key, c.archived_at,
         (SELECT MAX(x.created_at) FROM chat_messages x WHERE x.channel_id = c.id) AS last_at,
         (SELECT COUNT(*) FROM chat_members m WHERE m.channel_id = c.id AND m.left_at IS NULL) AS member_count
       FROM chat_channels c
       WHERE c.practice_id = ? AND c.archived_at IS NULL
         AND (c.kind = 'channel' OR EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = c.id AND m.user_id = ? AND m.left_at IS NULL))
       ORDER BY c.kind, c.id`, u.practice_id, u.id,
    );
    const convIds = channels.filter((c) => c.kind !== 'channel').map((c) => c.id);
    const people = convIds.length ? await db.all(
      `SELECT m.channel_id, m.user_id, us.name FROM chat_members m JOIN users us ON us.id = m.user_id WHERE m.channel_id IN (${marks(convIds)}) AND m.left_at IS NULL ORDER BY us.name`, ...convIds,
    ) : [];
    const team = await db.all('SELECT id, name, role FROM users WHERE practice_id = ? AND active = 1 ORDER BY name', u.practice_id);
    res.json({
      me: { id: u.id, name: u.name, role: u.role },
      today: (await practiceNow(db, u.practice_id)).slice(0, 10),
      settings: { gifs_enabled: !!settings.gifs_enabled, gif_provider: settings.gifs_enabled ? gifSearch.provider : null, digest_minutes: settings.digest_minutes },
      team,
      channels: channels.map((c) => {
        const st = byId.get(c.id);
        const members = people.filter((p) => p.channel_id === c.id);
        return {
          ...c, member_count: Number(c.member_count || 0), member: !!st, muted: !!st?.muted, unread: st?.unread || 0, mentions: st?.mentions || 0,
          last_read_id: st?.last_read_id || 0, last_id: st?.last_id || 0,
          members: c.kind === 'channel' ? undefined : members.map((p) => ({ id: p.user_id, name: p.name })),
          title: c.kind === 'channel' ? c.name : c.name || members.filter((p) => p.user_id !== u.id).map((p) => p.name).join(', ') || 'Notes to self',
        };
      }),
      unread: { important: unread.important, total: unread.total, urgent: unread.urgent },
    });
  });

  r.get('/chat/unread', async (req, res) => {
    const u = await unreadFor(db, req.user);
    res.json({ important: u.important, total: u.total, urgent: u.urgent, channels: u.channels.map(({ channel_id, unread, mentions, muted }) => ({ channel_id, unread, mentions, muted })) });
  });

  // ---- Conversations ----
  r.post('/chat/channels', async (req, res) => {
    const name = String(req.body?.name || '').replace(/^#/, '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
    if (name.length < 2) throw new HttpError(400, 'Give the channel a name (at least 2 letters)');
    const slug = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (!slug) throw new HttpError(400, 'Give the channel a name with letters or numbers');
    const topic = req.body?.topic ? String(req.body.topic).trim().slice(0, 200) : null;
    const made = await db.run(
      "INSERT INTO chat_channels (practice_id, kind, name, slug, topic, created_by) VALUES (?, 'channel', ?, ?, ?, ?) ON CONFLICT (practice_id, slug) DO NOTHING",
      req.user.practice_id, name, slug, topic, req.user.id,
    );
    if (!made.changes) throw new HttpError(409, 'There is already a channel with that name');
    const channel = await db.get('SELECT * FROM chat_channels WHERE practice_id = ? AND slug = ?', req.user.practice_id, slug);
    await join(db, channel, req.user.id, { caughtUp: true });
    await audit(db, req, 'chat.channel.create', 'chat_channels', channel.id, { name });
    publish(req.user.practice_id, { type: 'chat', event: 'channels', to: null, by: req.user.id });
    res.status(201).json(channel);
  });

  // A direct message (two people, or yourself for notes) or a small group: the same people always get the same
  // conversation (dm_key), so starting one twice opens the first.
  r.post('/chat/dms', async (req, res) => {
    const ids = [...new Set([req.user.id, ...idList(req.body?.user_ids)])].sort((a, b) => a - b);
    if (ids.length > MAX_GROUP) throw new HttpError(400, `A group conversation can have up to ${MAX_GROUP} people — use a channel for more`);
    const found = await db.all(`SELECT id FROM users WHERE practice_id = ? AND active = 1 AND id IN (${marks(ids)})`, req.user.practice_id, ...ids);
    if (found.length !== ids.length) throw new HttpError(404, 'Team member not found');
    const kind = ids.length > 2 ? 'group' : 'dm';
    const key = ids.join(',');
    const name = kind === 'group' && req.body?.name ? String(req.body.name).trim().slice(0, 60) : null;
    await db.run('INSERT INTO chat_channels (practice_id, kind, name, dm_key, created_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT (practice_id, dm_key) DO NOTHING', req.user.practice_id, kind, name, key, req.user.id);
    const channel = await db.get('SELECT * FROM chat_channels WHERE practice_id = ? AND dm_key = ?', req.user.practice_id, key);
    for (const id of ids) await join(db, channel, id, { caughtUp: id === req.user.id });
    const members = await db.all('SELECT u.id, u.name FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? AND m.left_at IS NULL ORDER BY u.name', channel.id);
    res.status(201).json({ ...channel, members, title: channel.name || members.filter((m) => m.id !== req.user.id).map((m) => m.name).join(', ') || 'Notes to self' });
  });

  r.post('/chat/channels/:id/join', async (req, res) => {
    const c = await readableChannel(db, req.user, req.params.id);
    if (c.archived_at) throw new HttpError(400, 'This channel is archived');
    await join(db, c, req.user.id, { caughtUp: true });
    res.json({ ok: true });
  });
  r.post('/chat/channels/:id/leave', async (req, res) => {
    const c = await readableChannel(db, req.user, req.params.id);
    await db.run("UPDATE chat_members SET left_at = datetime('now') WHERE channel_id = ? AND user_id = ? AND left_at IS NULL", c.id, req.user.id);
    res.json({ ok: true });
  });
  r.post('/chat/channels/:id/mute', async (req, res) => {
    const c = await readableChannel(db, req.user, req.params.id);
    await join(db, c, req.user.id, { caughtUp: true });
    await db.run('UPDATE chat_members SET muted = ? WHERE channel_id = ? AND user_id = ?', req.body?.muted ? 1 : 0, c.id, req.user.id);
    res.json({ ok: true, muted: !!req.body?.muted });
  });
  // Archived, never deleted: history stays readable and searchable.
  r.post('/chat/channels/:id/archive', async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can archive a channel');
    const c = await readableChannel(db, req.user, req.params.id);
    if (c.kind !== 'channel') throw new HttpError(400, 'Only channels can be archived');
    await update(db, 'chat_channels', c.id, req.user.practice_id, req.body?.archived === false ? { archived_at: null, archived_by: null } : { archived_at: new Date().toISOString(), archived_by: req.user.id });
    await audit(db, req, req.body?.archived === false ? 'chat.channel.restore' : 'chat.channel.archive', 'chat_channels', c.id, { name: c.name });
    publish(req.user.practice_id, { type: 'chat', event: 'channels', to: null, by: req.user.id });
    res.json({ ok: true });
  });

  // Read up to a message (or the newest): only ever forward. Mentions up to there count as seen.
  r.post('/chat/channels/:id/read', async (req, res) => {
    const c = await readableChannel(db, req.user, req.params.id);
    const newest = Number((await db.get('SELECT MAX(id) AS n FROM chat_messages WHERE channel_id = ?', c.id))?.n || 0);
    const upTo = Math.min(Number(req.body?.message_id) > 0 ? Number(req.body.message_id) : newest, newest);
    if (c.kind === 'channel') await join(db, c, req.user.id, { readThrough: upTo });
    await db.run('UPDATE chat_members SET last_read_id = ? WHERE channel_id = ? AND user_id = ? AND last_read_id < ?', upTo, c.id, req.user.id, upTo);
    await db.run("UPDATE chat_mentions SET seen_at = datetime('now') WHERE channel_id = ? AND user_id = ? AND message_id <= ? AND seen_at IS NULL", c.id, req.user.id, upTo);
    publish(req.user.practice_id, { type: 'chat', event: 'read', channel_id: c.id, to: [req.user.id], by: req.user.id });
    res.json({ ok: true, last_read_id: upTo });
  });

  // ---- Messages ----
  r.get('/chat/channels/:id/messages', async (req, res) => {
    const c = await readableChannel(db, req.user, req.params.id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const where = ['x.channel_id = ?', 'x.parent_id IS NULL'];
    const args = [c.id];
    if (Number(req.query.before) > 0) { where.push('x.id < ?'); args.push(Number(req.query.before)); }
    if (Number(req.query.after) > 0) { where.push('x.id > ?'); args.push(Number(req.query.after)); }
    const after = Number(req.query.after) > 0;
    const rows = await db.all(`${MSG_SELECT} WHERE ${where.join(' AND ')} ORDER BY x.id ${after ? 'ASC' : 'DESC'} LIMIT ?`, ...args, limit + 1);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    if (!after) page.reverse();
    const messages = await hydrate(req, page);
    await notePatientViews(req, messages);
    const member = await db.get('SELECT last_read_id, muted FROM chat_members WHERE channel_id = ? AND user_id = ? AND left_at IS NULL', c.id, req.user.id);
    res.json({ channel: { id: c.id, kind: c.kind, name: c.name, topic: c.topic, archived_at: c.archived_at }, messages, has_more: more, last_read_id: member?.last_read_id ?? null });
  });

  r.get('/chat/messages/:mid', async (req, res) => {
    const { message } = await readableMessage(db, req.user, req.params.mid);
    const out = await oneMessage(req, message.id);
    await notePatientViews(req, [out]);
    const ch = await db.get('SELECT id, kind, name FROM chat_channels WHERE id = ?', message.channel_id);
    res.json({ ...out, channel: ch });
  });

  r.get('/chat/messages/:mid/thread', async (req, res) => {
    const { message } = await readableMessage(db, req.user, req.params.mid);
    const rootId = message.parent_id || message.id;
    const rows = await db.all(`${MSG_SELECT} WHERE x.id = ? OR x.parent_id = ? ORDER BY x.id`, rootId, rootId);
    const all = await hydrate(req, rows);
    await notePatientViews(req, all);
    // Opening a thread sees the mentions in it.
    await db.run(`UPDATE chat_mentions SET seen_at = datetime('now') WHERE user_id = ? AND seen_at IS NULL AND message_id IN (SELECT id FROM chat_messages WHERE id = ? OR parent_id = ?)`, req.user.id, rootId, rootId);
    res.json({ parent: all.find((x) => x.id === rootId), replies: all.filter((x) => x.id !== rootId) });
  });

  r.post('/chat/channels/:id/messages', async (req, res) => {
    const c = await readableChannel(db, req.user, req.params.id);
    if (c.archived_at) throw new HttpError(400, 'This channel is archived');
    const b = req.body || {};
    const clientKey = b.client_key == null ? null : String(b.client_key);
    if (clientKey && !CLIENT_KEY.test(clientKey)) throw new HttpError(400, 'client_key must be 8-80 letters, digits, dashes, dots or colons');
    // The same send again (a retry, a double press): the first one's message, not a second.
    if (clientKey) {
      const had = await db.get('SELECT id FROM chat_messages WHERE practice_id = ? AND user_id = ? AND client_key = ?', req.user.practice_id, req.user.id, clientKey);
      if (had) return res.status(200).json(await oneMessage(req, had.id));
    }
    const body = typeof b.body === 'string' ? b.body.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : '';
    if (body.length > MAX_BODY) throw new HttpError(400, `Messages can be up to ${MAX_BODY} characters`);
    let parentId = null;
    if (b.parent_id != null) {
      const parent = await db.get('SELECT * FROM chat_messages WHERE id = ? AND practice_id = ?', Number(b.parent_id), req.user.practice_id);
      if (!parent || parent.channel_id !== c.id) throw new HttpError(404, 'The message you are replying to was not found');
      parentId = parent.parent_id || parent.id;
    }
    let patientId = null;
    let patient = null;
    if (b.patient_id != null) {
      patient = await findOr404(db, 'patients', b.patient_id, req.user.practice_id, 'Patient');
      if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
      patientId = patient.id;
    }
    let gif = null;
    if (b.gif != null) {
      const settings = await settingsOf(req.user.practice_id);
      if (!settings.gifs_enabled) throw new HttpError(403, 'GIFs are turned off for this practice');
      gif = cleanGif(b.gif);
      if (!gif) throw new HttpError(400, 'That GIF can’t be sent');
    }
    const attachmentIds = idList(b.attachment_ids).slice(0, 10);
    if (attachmentIds.length) {
      const files = await db.all(`SELECT id FROM chat_attachments WHERE practice_id = ? AND uploaded_by = ? AND message_id IS NULL AND id IN (${marks(attachmentIds)})`, req.user.practice_id, req.user.id, ...attachmentIds);
      if (files.length !== attachmentIds.length) throw new HttpError(404, 'Attachment not found');
    }
    if (!body && !gif && !attachmentIds.length) throw new HttpError(400, 'Type a message');
    const urgent = b.urgent ? 1 : 0;
    const mentions = await resolveMentions(db, { channel: c, body, explicitIds: idList(b.mention_ids), authorId: req.user.id, practiceId: req.user.practice_id });
    const locationId = req.location_id ?? (patient?.location_id || null);
    const id = await db.tx(async () => {
      const made = await db.run(
        `INSERT INTO chat_messages (practice_id, channel_id, parent_id, user_id, source, kind, body, gif, patient_id, location_id, urgent, client_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (practice_id, user_id, client_key) DO NOTHING`,
        req.user.practice_id, c.id, parentId, req.user.id, currentActor()?.source || 'human', gif ? 'gif' : 'text', body || null, gif ? JSON.stringify(gif) : null,
        patientId, locationId, urgent, clientKey,
      );
      if (!made.changes) return null;
      const mid = made.id;
      if (attachmentIds.length) await db.run(`UPDATE chat_attachments SET message_id = ? WHERE practice_id = ? AND uploaded_by = ? AND message_id IS NULL AND id IN (${marks(attachmentIds)})`, mid, req.user.practice_id, req.user.id, ...attachmentIds);
      await join(db, c, req.user.id, { caughtUp: true });
      if (!parentId) await db.run('UPDATE chat_members SET last_read_id = ? WHERE channel_id = ? AND user_id = ? AND last_read_id < ?', mid, c.id, req.user.id, mid);
      for (const m of mentions) {
        // Called on in a channel they aren't in: they join it, with this message still unread.
        if (c.kind === 'channel') await join(db, c, m.user_id, { readThrough: mid - 1 });
        await db.run('INSERT INTO chat_mentions (practice_id, message_id, channel_id, user_id, via) VALUES (?, ?, ?, ?, ?) ON CONFLICT (message_id, user_id) DO NOTHING', req.user.practice_id, mid, c.id, m.user_id, m.via);
      }
      return mid;
    });
    if (!id) {
      const had = await db.get('SELECT id FROM chat_messages WHERE practice_id = ? AND user_id = ? AND client_key = ?', req.user.practice_id, req.user.id, clientKey);
      return res.status(200).json(await oneMessage(req, had.id));
    }
    if (patientId || urgent) await audit(db, req, patientId ? 'chat.message.patient_link' : 'chat.message.urgent', 'chat_messages', id, { patient_id: patientId, channel_id: c.id, urgent: !!urgent });
    await announce(db, c, { event: 'message', message_id: id, parent_id: parentId, mentions: mentions.map((m) => m.user_id), urgent: !!urgent, by: req.user.id });
    res.status(201).json(await oneMessage(req, id));
  });

  // Edit your own message: the earlier text is kept (chat_message_edits) and the change is audited.
  r.put('/chat/messages/:mid', async (req, res) => {
    const { message: m, channel } = await readableMessage(db, req.user, req.params.mid);
    if (m.user_id !== req.user.id) throw new HttpError(403, 'You can only edit your own messages');
    if (m.status === 'deleted') throw new HttpError(400, 'This message was deleted');
    if (m.kind !== 'text') throw new HttpError(400, 'Only text messages can be edited');
    const row = {};
    if (req.body?.body !== undefined) {
      const body = String(req.body.body ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
      if (!body && !(await db.get('SELECT id FROM chat_attachments WHERE message_id = ?', m.id))) throw new HttpError(400, 'A message can’t be empty — delete it instead');
      if (body.length > MAX_BODY) throw new HttpError(400, `Messages can be up to ${MAX_BODY} characters`);
      if (body !== (m.body || '')) row.body = body;
    }
    if (req.body?.patient_id !== undefined) {
      const pid = req.body.patient_id == null ? null : Number(req.body.patient_id);
      if (pid) {
        await findOr404(db, 'patients', pid, req.user.practice_id, 'Patient');
        if (!(await canSeePatient(db, req.user, pid))) throw new HttpError(404, 'Patient not found');
      }
      if (pid !== m.patient_id) row.patient_id = pid;
    }
    if (!Object.keys(row).length) return res.json(await oneMessage(req, m.id));
    row.edited_at = new Date().toISOString();
    await db.tx(async () => {
      await insert(db, 'chat_message_edits', {
        practice_id: m.practice_id, message_id: m.id, user_id: req.user.id, body_before: m.body, body_after: row.body ?? m.body,
        patient_before: m.patient_id, patient_after: row.patient_id !== undefined ? row.patient_id : m.patient_id,
      });
      await update(db, 'chat_messages', m.id, req.user.practice_id, row);
    });
    const before = { body: m.body, patient_id: m.patient_id };
    const after = { body: row.body ?? m.body, patient_id: row.patient_id !== undefined ? row.patient_id : m.patient_id };
    await audit(db, req, 'chat.message.edit', 'chat_messages', m.id, { channel_id: m.channel_id, patient_id: after.patient_id ?? before.patient_id ?? null }, { before, after, patientId: after.patient_id ?? before.patient_id ?? null });
    await announce(db, channel, { event: 'edit', message_id: m.id, parent_id: m.parent_id, by: req.user.id });
    res.json(await oneMessage(req, m.id));
  });

  // Delete: the message stays (status 'deleted', text hidden from everyone) and the delete is audited. Your own,
  // or anyone's for an administrator (with a reason).
  r.delete('/chat/messages/:mid', async (req, res) => {
    const { message: m, channel } = await readableMessage(db, req.user, req.params.mid);
    const own = m.user_id === req.user.id;
    if (!own && req.user.role !== 'admin') throw new HttpError(403, 'You can only delete your own messages');
    const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 300) : null;
    if (!own && !reason) throw new HttpError(400, 'Say why you are removing someone else’s message');
    if (m.status === 'deleted') return res.json(await oneMessage(req, m.id));
    await update(db, 'chat_messages', m.id, req.user.practice_id, { status: 'deleted', deleted_at: new Date().toISOString(), deleted_by: req.user.id });
    await audit(db, req, 'chat.message.delete', 'chat_messages', m.id, { channel_id: m.channel_id, patient_id: m.patient_id ?? null, own }, { reason, before: { body: m.body }, after: { body: null }, patientId: m.patient_id ?? null });
    await announce(db, channel, { event: 'delete', message_id: m.id, parent_id: m.parent_id, by: req.user.id });
    res.json(await oneMessage(req, m.id));
  });

  // Undo a delete (the toast's Undo): the person who deleted it brings it back; audited like the delete.
  r.post('/chat/messages/:mid/restore', async (req, res) => {
    const { message: m, channel } = await readableMessage(db, req.user, req.params.mid);
    if (m.status !== 'deleted') return res.json(await oneMessage(req, m.id));
    if (m.deleted_by !== req.user.id) throw new HttpError(403, 'Only the person who deleted this message can bring it back');
    await update(db, 'chat_messages', m.id, req.user.practice_id, { status: 'active', deleted_at: null, deleted_by: null });
    await audit(db, req, 'chat.message.restore', 'chat_messages', m.id, { channel_id: m.channel_id, patient_id: m.patient_id ?? null }, { patientId: m.patient_id ?? null });
    await announce(db, channel, { event: 'edit', message_id: m.id, parent_id: m.parent_id, by: req.user.id });
    res.json(await oneMessage(req, m.id));
  });

  // The edits of a message, for its author and administrators.
  r.get('/chat/messages/:mid/history', async (req, res) => {
    const { message: m } = await readableMessage(db, req.user, req.params.mid);
    if (m.user_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'Only the author or an administrator can see earlier versions');
    res.json(await db.all('SELECT e.id, e.body_before, e.body_after, e.patient_before, e.patient_after, e.created_at, u.name AS user_name FROM chat_message_edits e LEFT JOIN users u ON u.id = e.user_id WHERE e.message_id = ? ORDER BY e.id', m.id));
  });

  // Reactions: the screen says which state it wants ({ emoji, on }), so a repeat changes nothing.
  r.post('/chat/messages/:mid/reactions', async (req, res) => {
    const { message: m, channel } = await readableMessage(db, req.user, req.params.mid);
    if (m.status === 'deleted') throw new HttpError(400, 'This message was deleted');
    const emoji = String(req.body?.emoji || '').trim();
    if (!EMOJI.test(emoji) || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(emoji)) throw new HttpError(400, 'Pick an emoji');
    if (req.body?.on === false) {
      // A reaction taken back is just gone: it isn't a record of anything.
      await db.run('DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', m.id, req.user.id, emoji);
    } else {
      await db.run('INSERT INTO chat_reactions (practice_id, message_id, user_id, emoji) VALUES (?, ?, ?, ?) ON CONFLICT (message_id, user_id, emoji) DO NOTHING', req.user.practice_id, m.id, req.user.id, emoji);
    }
    await announce(db, channel, { event: 'reaction', message_id: m.id, parent_id: m.parent_id, by: req.user.id });
    res.json(await oneMessage(req, m.id));
  });

  // "Got it" on an urgent message, and who has / hasn't seen it yet.
  r.post('/chat/messages/:mid/ack', async (req, res) => {
    const { message: m, channel } = await readableMessage(db, req.user, req.params.mid);
    await db.run('INSERT INTO chat_acks (practice_id, message_id, user_id) VALUES (?, ?, ?) ON CONFLICT (message_id, user_id) DO NOTHING', req.user.practice_id, m.id, req.user.id);
    await announce(db, channel, { event: 'ack', message_id: m.id, parent_id: m.parent_id, by: req.user.id });
    res.json({ ok: true });
  });
  r.get('/chat/messages/:mid/acks', async (req, res) => {
    const { message: m } = await readableMessage(db, req.user, req.params.mid);
    const acked = await db.all('SELECT a.user_id, u.name, a.acked_at FROM chat_acks a JOIN users u ON u.id = a.user_id WHERE a.message_id = ? ORDER BY a.id', m.id);
    const done = new Set(acked.map((a) => a.user_id));
    const ids = new Set([...(await membersOf(db, m.channel_id)), ...(await db.all('SELECT user_id FROM chat_mentions WHERE message_id = ?', m.id)).map((x) => x.user_id)]);
    ids.delete(m.user_id);
    const waiting = ids.size ? await db.all(`SELECT id AS user_id, name FROM users WHERE practice_id = ? AND active = 1 AND id IN (${marks([...ids])}) ORDER BY name`, req.user.practice_id, ...ids) : [];
    res.json({ acked, waiting: waiting.filter((w) => !done.has(w.user_id)) });
  });

  r.get('/chat/urgent', async (req, res) => {
    const list = await pendingUrgent(db, req.user);
    await notePatientViews(req, list.filter((x) => x.patient_id).map((x) => ({ ...x, status: 'active' })));
    res.json(list);
  });

  // Search: words in messages this person can read (their DMs and groups, every channel), leaving out messages
  // about patients they can't see; or every message about one patient (patient_id).
  r.get('/chat/search', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const patientId = Number(req.query.patient_id) || null;
    if (q.length < 2 && !patientId) return res.json([]);
    const s = patientScope(req.user);
    const where = [
      'x.practice_id = ?', "x.status = 'active'", 'c.archived_at IS NULL',
      "(c.kind = 'channel' OR EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = c.id AND m.user_id = ? AND m.left_at IS NULL))",
      `(x.patient_id IS NULL OR EXISTS (SELECT 1 FROM patients p WHERE p.id = x.patient_id AND p.practice_id = x.practice_id${s.sql}))`,
    ];
    const args = [req.user.practice_id, req.user.id, ...s.args];
    if (q.length >= 2) {
      where.push("LOWER(x.body) LIKE ? ESCAPE '!'");
      args.push(`%${q.toLowerCase().replace(/[!%_]/g, (ch) => `!${ch}`)}%`);
    }
    if (patientId) {
      if (!(await canSeePatient(db, req.user, patientId))) throw new HttpError(404, 'Patient not found');
      where.push('x.patient_id = ?');
      args.push(patientId);
    }
    const rows = await db.all(`${MSG_SELECT} JOIN chat_channels c ON c.id = x.channel_id WHERE ${where.join(' AND ')} ORDER BY x.id DESC LIMIT 50`, ...args);
    const out = await hydrate(req, rows);
    await notePatientViews(req, out);
    const names = new Map((await db.all(`SELECT id, kind, name FROM chat_channels WHERE practice_id = ?`, req.user.practice_id)).map((c) => [c.id, c]));
    res.json(out.map((x) => ({ ...x, channel: names.get(x.channel_id) || null })));
  });

  // ---- Files ----
  r.post('/chat/attachments', express.raw({ type: () => true, limit: MAX_FILE }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Empty upload');
    const declared = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const mime = sniffMime(req.body, String(req.query.filename || '')) || (declared === 'text/plain' ? declared : null);
    if (!mime || !FILE_TYPES.test(mime)) throw new HttpError(415, 'You can send pictures (PNG, JPEG, GIF, WebP), PDFs and plain text files');
    let filename = String(req.query.filename || 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 200);
    if (mime === 'text/plain') {
      try { new TextDecoder('utf-8', { fatal: true }).decode(req.body); } catch { throw new HttpError(415, 'That text file isn’t plain text'); }
      if (req.body.includes(0)) throw new HttpError(415, 'That text file isn’t plain text');
      if (!/\.txt$/i.test(filename)) filename = `${filename.replace(/\.[^.]*$/, '')}.txt`;
    }
    const { storageKey, encrypted } = await storage.save(req.user.practice_id, req.body);
    const id = await insert(db, 'chat_attachments', { practice_id: req.user.practice_id, uploaded_by: req.user.id, filename, mime, size: req.body.length, storage_key: storageKey, encrypted: encrypted ? 1 : 0 });
    res.status(201).json({ id, filename, mime, size: req.body.length });
  });

  r.get('/chat/attachments/:aid', async (req, res) => {
    const a = await findOr404(db, 'chat_attachments', req.params.aid, req.user.practice_id, 'File');
    let message = null;
    if (a.message_id) {
      message = (await readableMessage(db, req.user, a.message_id)).message;
      if (message.status === 'deleted') throw new HttpError(404, 'File not found');
    } else if (a.uploaded_by !== req.user.id) throw new HttpError(404, 'File not found');
    const data = await storage.read(a.storage_key, !!a.encrypted);
    if (!data) throw new HttpError(404, 'File missing from storage');
    if (message?.patient_id) await audit(db, req, 'chat.attachment.view', 'chat_attachments', a.id, { patient_id: message.patient_id, message_id: message.id });
    res.set({
      'Content-Type': a.mime, 'Content-Length': data.length,
      'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${a.filename.replace(/"/g, '')}"`,
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(data);
  });

  // ---- Settings ----
  r.get('/chat/settings', async (req, res) => {
    const s = await settingsOf(req.user.practice_id);
    res.json({ gifs_enabled: !!s.gifs_enabled, gif_provider: gifSearch.provider, digest_minutes: s.digest_minutes });
  });
  r.put('/chat/settings', async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can change chat settings');
    const s = await settingsOf(req.user.practice_id);
    const row = {};
    if (req.body?.gifs_enabled !== undefined) row.gifs_enabled = req.body.gifs_enabled ? 1 : 0;
    if (req.body?.digest_minutes !== undefined) {
      const n = Number(req.body.digest_minutes);
      if (!Number.isInteger(n) || n < 0 || n > 1440) throw new HttpError(400, 'digest_minutes must be 0 (off) to 1440');
      row.digest_minutes = n;
    }
    if (Object.keys(row).length) {
      await update(db, 'chat_settings', s.id, req.user.practice_id, { ...row, updated_by: req.user.id, updated_at: new Date().toISOString() });
      await audit(db, req, 'chat.settings.update', 'chat_settings', s.id, null, { before: { gifs_enabled: s.gifs_enabled, digest_minutes: s.digest_minutes }, after: { gifs_enabled: row.gifs_enabled ?? s.gifs_enabled, digest_minutes: row.digest_minutes ?? s.digest_minutes } });
      publish(req.user.practice_id, { type: 'chat', event: 'settings', to: null, by: req.user.id });
    }
    const now = await settingsOf(req.user.practice_id);
    res.json({ gifs_enabled: !!now.gifs_enabled, gif_provider: gifSearch.provider, digest_minutes: now.digest_minutes });
  });

  // ---- GIFs (off unless the practice turns them on) ----
  const gifsOn = async (req) => {
    if (!(await settingsOf(req.user.practice_id)).gifs_enabled) throw new HttpError(403, 'GIFs are turned off for this practice');
  };
  r.get('/chat/gifs', async (req, res) => {
    await gifsOn(req);
    const q = await cleanGifQuery(db, req.user.practice_id, req.query.q);
    try {
      res.json({ provider: gifSearch.provider, query: q, results: await gifSearch.search(q || 'happy') });
    } catch (err) {
      throw new HttpError(502, `GIF search isn’t working right now (${err.message})`);
    }
  });
  // Real GIFs are fetched here for the browser (the app's pages only load images from itself), from the
  // provider's media hosts only. Not patient data, so a small memory cache keeps repeats quick.
  const media = new Map();
  r.get('/chat/gifs/media', async (req, res) => {
    await gifsOn(req);
    let url;
    try { url = new URL(String(req.query.u || '')); } catch { throw new HttpError(400, 'Not a GIF address'); }
    if (url.protocol !== 'https:' || !GIF_MEDIA_HOSTS.test(url.hostname)) throw new HttpError(400, 'Not a GIF address');
    let hit = media.get(url.toString());
    if (!hit) {
      const r2 = await fetchImpl(url.toString());
      const type = String(r2.headers.get('content-type') || '').split(';')[0];
      if (!r2.ok || !/^image\/(gif|webp|png|jpeg)$/.test(type)) throw new HttpError(502, 'That GIF couldn’t be loaded');
      const buf = Buffer.from(await r2.arrayBuffer());
      if (buf.length > 8 * 1024 * 1024) throw new HttpError(413, 'That GIF is too big');
      hit = { type, buf };
      media.set(url.toString(), hit);
      if (media.size > 200) media.delete(media.keys().next().value);
    }
    res.set({ 'Content-Type': hit.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' }).send(hit.buf);
  });

  // ---- Tasks ----
  const loadTasks = async (ids) => {
    if (!ids.length) return [];
    const rows = await db.all(`${TASK_SELECT} WHERE t.id IN (${marks(ids)})`, ...ids);
    const items = await db.all(`SELECT i.id, i.task_id, i.text, i.position, i.done_at, i.done_by, u.name AS done_by_name FROM task_checklist_items i LEFT JOIN users u ON u.id = i.done_by WHERE i.task_id IN (${marks(ids)}) AND i.removed_at IS NULL ORDER BY i.position, i.id`, ...ids);
    const byId = new Map(rows.map((t) => [t.id, t]));
    return ids.map((id) => byId.get(id)).filter(Boolean).map((t) => ({
      ...t,
      patient: t.patient_id ? { id: t.patient_id, name: nameOf(t) } : null,
      checklist: items.filter((i) => i.task_id === t.id).map(({ task_id: _t, ...i }) => i),
    }));
  };
  const scopedTask = async (req, id) => {
    const t = await findOr404(db, 'tasks', id, req.user.practice_id, 'Task');
    if (t.patient_id && !(await canSeePatient(db, req.user, t.patient_id))) throw new HttpError(404, 'Task not found');
    return t;
  };
  const tellAssignee = (req, task, event) => publish(req.user.practice_id, { type: 'tasks', event, task_id: task.id, assigned_to: task.assigned_to ?? null, by: req.user.id });

  // My tasks: open ones assigned to me (overdue / today / upcoming / someday, sorted on screen), what I ticked
  // off today (so it can be undone), and my repeating tasks. view=assigned: what I've given others.
  r.get('/chat/tasks', async (req, res) => {
    const pid = req.user.practice_id;
    await runRecurringTasks(db, { practiceId: pid });
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const s = patientScope(req.user);
    const scope = `AND (t.patient_id IS NULL OR EXISTS (SELECT 1 FROM patients p WHERE p.id = t.patient_id AND p.practice_id = t.practice_id${s.sql}))`;
    const assigned = req.query.view === 'assigned';
    const open = await db.all(
      `SELECT t.id FROM tasks t WHERE t.practice_id = ? AND t.status = 'open' AND ${assigned ? 't.created_by = ? AND (t.assigned_to IS NULL OR t.assigned_to <> t.created_by)' : 't.assigned_to = ?'} ${scope}
       ORDER BY t.due_date IS NULL, t.due_date, CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.id LIMIT 500`, pid, req.user.id, ...s.args,
    );
    const done = await db.all(
      `SELECT t.id FROM tasks t WHERE t.practice_id = ? AND t.status = 'done' AND ${assigned ? 't.created_by = ?' : 't.assigned_to = ?'} AND t.completed_at >= ? ${scope} ORDER BY t.completed_at DESC LIMIT 50`,
      pid, req.user.id, new Date(Date.now() - 86400_000).toISOString(), ...s.args,
    );
    const series = await db.all(
      `SELECT s.id, s.title, s.rule, s.weekday, s.month_day, s.next_due, s.assigned_to, u.name AS assigned_to_name FROM task_series s LEFT JOIN users u ON u.id = s.assigned_to
       WHERE s.practice_id = ? AND s.active = 1 AND (s.assigned_to = ? OR s.created_by = ?) ORDER BY s.next_due`, pid, req.user.id, req.user.id,
    );
    res.json({ today, tasks: await loadTasks(open.map((x) => x.id)), done: await loadTasks(done.map((x) => x.id)), series });
  });

  async function createTask(req, input, fromMessage = null) {
    const pid = req.user.practice_id;
    const title = String(input.title ?? (fromMessage?.body || '')).replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!title) throw new HttpError(400, 'Say what needs doing');
    requireOneOf(input.priority, ['low', 'normal', 'high'], 'priority');
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const due = validDate(input.due_date, 'due_date');
    const assignedTo = input.assigned_to === undefined ? req.user.id : input.assigned_to == null ? null : Number(input.assigned_to);
    if (assignedTo) {
      const u = await findOr404(db, 'users', assignedTo, pid, 'Team member');
      if (!u.active) throw new HttpError(400, `${u.name} no longer works here`);
    }
    let patientId = input.patient_id === undefined ? fromMessage?.patient_id ?? null : input.patient_id == null ? null : Number(input.patient_id);
    if (patientId) {
      await findOr404(db, 'patients', patientId, pid, 'Patient');
      if (!(await canSeePatient(db, req.user, patientId))) throw new HttpError(404, 'Patient not found');
    } else patientId = null;
    const checklist = (Array.isArray(input.checklist) ? input.checklist : []).map((x) => String(typeof x === 'object' ? x?.text ?? '' : x).trim().slice(0, 200)).filter(Boolean).slice(0, 30);
    const notes = input.notes ? String(input.notes).trim().slice(0, 2000) : null;
    const priority = input.priority || 'normal';
    const repeat = cleanRepeat(input.repeat, due || today);
    let taskId;
    if (repeat) {
      // A repeating task: the series makes each one on its day (the first straight away).
      const first = firstOnOrAfter(repeat, due || today);
      const seriesId = await insert(db, 'task_series', {
        practice_id: pid, title, notes, assigned_to: assignedTo, patient_id: patientId, priority, rule: repeat.rule, weekday: repeat.weekday, month_day: repeat.month_day,
        checklist: checklist.length ? JSON.stringify(checklist) : null, next_due: first, created_by: req.user.id,
      });
      await audit(db, req, 'task_series.create', 'task_series', seriesId, { rule: repeat.rule, assigned_to: assignedTo, patient_id: patientId });
      const made = await runRecurringTasks(db, { seriesId, today });
      taskId = made[0] ?? (await db.get('SELECT task_id FROM task_occurrences WHERE series_id = ? ORDER BY due_date LIMIT 1', seriesId))?.task_id;
    } else {
      taskId = await db.tx(async () => {
        const id = await insert(db, 'tasks', { practice_id: pid, title, notes, assigned_to: assignedTo, patient_id: patientId, priority, due_date: due, created_by: req.user.id, chat_message_id: fromMessage?.id ?? null });
        for (const [i, text] of checklist.entries()) await db.run('INSERT INTO task_checklist_items (practice_id, task_id, text, position) VALUES (?, ?, ?, ?)', pid, id, text, i);
        return id;
      });
      await audit(db, req, 'task.create', 'tasks', taskId, { patient_id: patientId, assigned_to: assignedTo, ...(fromMessage ? { chat_message_id: fromMessage.id } : {}) });
      tellAssignee(req, { id: taskId, assigned_to: assignedTo }, 'created');
    }
    if (fromMessage && taskId) await db.run('UPDATE tasks SET chat_message_id = ? WHERE id = ? AND chat_message_id IS NULL', fromMessage.id, taskId);
    return (await loadTasks([taskId]))[0];
  }

  r.post('/chat/tasks', taskWriter, async (req, res) => {
    let from = null;
    if (req.body?.message_id != null) from = (await readableMessage(db, req.user, req.body.message_id)).message;
    res.status(201).json(await createTask(req, req.body || {}, from));
  });

  // Turn a message into a task: its text (unless retitled), its patient, and a link back to it.
  r.post('/chat/messages/:mid/task', taskWriter, async (req, res) => {
    const { message, channel } = await readableMessage(db, req.user, req.params.mid);
    if (message.status === 'deleted') throw new HttpError(400, 'This message was deleted');
    const task = await createTask(req, req.body || {}, message);
    await announce(db, channel, { event: 'edit', message_id: message.id, parent_id: message.parent_id, by: req.user.id });
    res.status(201).json(task);
  });

  r.put('/chat/tasks/:tid', taskWriter, async (req, res) => {
    const t = await scopedTask(req, req.params.tid);
    const b = req.body || {};
    const row = {};
    if (b.title !== undefined) {
      row.title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!row.title) throw new HttpError(400, 'Say what needs doing');
    }
    if (b.notes !== undefined) row.notes = b.notes ? String(b.notes).trim().slice(0, 2000) : null;
    if (b.due_date !== undefined) row.due_date = validDate(b.due_date || null, 'due_date');
    if (b.priority !== undefined) { requireOneOf(b.priority, ['low', 'normal', 'high'], 'priority'); row.priority = b.priority; }
    if (b.assigned_to !== undefined) {
      row.assigned_to = b.assigned_to == null ? null : Number(b.assigned_to);
      if (row.assigned_to) await findOr404(db, 'users', row.assigned_to, req.user.practice_id, 'Team member');
    }
    if (b.patient_id !== undefined) {
      row.patient_id = b.patient_id == null ? null : Number(b.patient_id);
      if (row.patient_id) {
        await findOr404(db, 'patients', row.patient_id, req.user.practice_id, 'Patient');
        if (!(await canSeePatient(db, req.user, row.patient_id))) throw new HttpError(404, 'Patient not found');
      }
    }
    await update(db, 'tasks', t.id, req.user.practice_id, row);
    await audit(db, req, 'task.update', 'tasks', t.id, { patient_id: row.patient_id ?? t.patient_id ?? null }, { before: Object.fromEntries(Object.keys(row).map((k) => [k, t[k]])), after: row });
    const task = (await loadTasks([t.id]))[0];
    tellAssignee(req, task, 'updated');
    res.json(task);
  });

  // Done in one key, and back again with Undo (the audit log keeps both).
  const setDone = (done) => async (req, res) => {
    const t = await scopedTask(req, req.params.tid);
    if ((t.status === 'done') !== done) {
      await update(db, 'tasks', t.id, req.user.practice_id, done
        ? { status: 'done', completed_at: new Date().toISOString(), completed_by: req.user.id }
        : { status: 'open', completed_at: null, completed_by: null });
      await audit(db, req, 'task.update', 'tasks', t.id, { status: done ? 'done' : 'open', patient_id: t.patient_id ?? null });
      // A repeating task ticked off: the next one appears now rather than at the next job run.
      const occ = await db.get('SELECT series_id FROM task_occurrences WHERE task_id = ?', t.id);
      if (done && occ) await runRecurringTasks(db, { seriesId: occ.series_id });
    }
    const task = (await loadTasks([t.id]))[0];
    tellAssignee(req, task, 'updated');
    res.json(task);
  };
  r.post('/chat/tasks/:tid/done', taskWriter, setDone(true));
  r.post('/chat/tasks/:tid/reopen', taskWriter, setDone(false));

  r.post('/chat/tasks/:tid/checklist', taskWriter, async (req, res) => {
    const t = await scopedTask(req, req.params.tid);
    const text = String(req.body?.text || '').trim().slice(0, 200);
    if (!text) throw new HttpError(400, 'Type the checklist item');
    const n = Number((await db.get('SELECT COUNT(*) AS n FROM task_checklist_items WHERE task_id = ?', t.id))?.n || 0);
    if (n >= 50) throw new HttpError(400, 'A checklist can have up to 50 items');
    await insert(db, 'task_checklist_items', { practice_id: t.practice_id, task_id: t.id, text, position: n });
    res.status(201).json((await loadTasks([t.id]))[0]);
  });
  r.put('/chat/tasks/:tid/checklist/:iid', taskWriter, async (req, res) => {
    const t = await scopedTask(req, req.params.tid);
    const item = await findOr404(db, 'task_checklist_items', req.params.iid, req.user.practice_id, 'Checklist item');
    if (item.task_id !== t.id) throw new HttpError(404, 'Checklist item not found');
    const row = {};
    if (req.body?.done !== undefined) Object.assign(row, req.body.done ? { done_at: item.done_at || new Date().toISOString(), done_by: item.done_by || req.user.id } : { done_at: null, done_by: null });
    if (req.body?.text !== undefined) {
      row.text = String(req.body.text || '').trim().slice(0, 200);
      if (!row.text) throw new HttpError(400, 'Type the checklist item');
    }
    if (req.body?.removed !== undefined) row.removed_at = req.body.removed ? new Date().toISOString() : null;
    await update(db, 'task_checklist_items', item.id, req.user.practice_id, row);
    res.json((await loadTasks([t.id]))[0]);
  });

  // Stop a repeating task (the ones already made stay on the list).
  r.post('/chat/series/:sid/stop', taskWriter, async (req, res) => {
    const s = await findOr404(db, 'task_series', req.params.sid, req.user.practice_id, 'Repeating task');
    if (s.active) {
      await update(db, 'task_series', s.id, req.user.practice_id, { active: 0, ended_at: new Date().toISOString(), ended_by: req.user.id });
      await audit(db, req, 'task_series.stop', 'task_series', s.id, { title: s.title });
    }
    res.json({ ok: true });
  });

  return r;
}
