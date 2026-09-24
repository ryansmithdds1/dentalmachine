import { Router } from 'express';
import { requirePermission, HttpError, can } from '../auth.js';
import { audit, findOr404, insert, update, isRealDate, practiceNow } from '../util.js';
import { currentActor } from '../actor.js';
import { publish } from '../events.js';
import { appointmentScope, canSeePatient } from '../officeaccess.js';
import {
  prefOptions, patientPrefs, latestPersonal, strikesFor, strikeWarning, cardData, layoutsFor, cleanLayout, PREF_CATEGORIES, CARD_ITEMS,
  DEFAULT_LAYOUT, USER_LAYOUT_KEY, OFFICE_REASONS,
} from '../cards.js';

// Patient preferences (PP1), personal connection notes (PP2), and what the schedule's cards show (S6).
// docs/workflows/specs/PP-DN-S8-S6.md.
//   GET  /preference-options                  the practice's list (starter set added on first read); ?all=1 with retired
//   POST /preference-options                  add one (administrators)          PUT /preference-options/:id  rename / order / retire
//   GET  /patients/:id/preferences            the patient's preferences (urgent first)
//   POST /patients/:id/preferences            add one ({ option_id, urgent, note }) — adding it again just updates urgent/note
//   PUT  /patient-preferences/:id             urgent on/off, note           POST /patient-preferences/:id/remove  (kept, marked removed)
//   GET  /patients/:id/personal-notes         the timeline (who, when); ?all=1 includes removed ones
//   POST /patients/:id/personal-notes         a new note ({ body, client_key })   POST /personal-notes/:id/remove  (kept, marked removed)
//   GET  /patients/:id/connection             for the patient bar and chart header: urgent/all preferences, latest personal note, strikes
//   GET  /schedule-cards?from=&to=            per visit on the schedule: what its chips need, plus the doctor's slot notes and the layout
//   GET  /card-layout                         the practice's layout, the person's own, and what a card can show
//   PUT  /card-layout                         the practice's layout (administrators)   PUT /me/card-layout  a person's own (null = use the office's)
//   POST /appointments/:id/labels             put an office label on a visit or take it off ({ label_key, on })
const clean = (v, max) => (v == null ? null : String(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) || null);
const sourceNow = () => currentActor()?.source || 'human';

export default function cardRoutes({ db }) {
  const r = Router();
  const changed = (req, what, patientId = null) => publish(req.user.practice_id, { type: 'cards', what, patient_id: patientId, by: req.user.id });
  const patientFor = async (req, id) => {
    const p = await findOr404(db, 'patients', id, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, p.id))) throw new HttpError(404, 'Patient not found');
    return p;
  };
  const admin = (req) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can change this for the whole office');
  };

  // ---------------------------------------------------------------- PP1
  r.get('/preference-options', requirePermission('patients:read'), async (req, res) => {
    res.json(await prefOptions(db, req.user.practice_id, { all: req.query.all === '1' }));
  });

  r.post('/preference-options', requirePermission('patients:read'), async (req, res) => {
    admin(req);
    const label = clean(req.body?.label, 60);
    if (!label) throw new HttpError(400, 'Give the preference a name');
    const category = req.body?.category || 'other';
    if (!PREF_CATEGORIES.includes(category)) throw new HttpError(400, `category must be one of: ${PREF_CATEGORIES.join(', ')}`);
    const pid = req.user.practice_id;
    const same = await db.get('SELECT * FROM patient_pref_options WHERE practice_id = ? AND lower(label) = lower(?) AND active = 1', pid, label);
    if (same) return res.json(same);
    const pos = (await db.get('SELECT COALESCE(MAX(position), 0) AS n FROM patient_pref_options WHERE practice_id = ?', pid)).n + 1;
    const id = await insert(db, 'patient_pref_options', { practice_id: pid, label, category, position: pos, created_by: req.user.id });
    const row = await db.get('SELECT * FROM patient_pref_options WHERE id = ?', id);
    await audit(db, req, 'preference_option.create', 'patient_pref_options', id, { label, category }, { after: { label, category } });
    changed(req, 'options');
    res.status(201).json(row);
  });

  r.put('/preference-options/:id', requirePermission('patients:read'), async (req, res) => {
    admin(req);
    const before = await findOr404(db, 'patient_pref_options', req.params.id, req.user.practice_id, 'Preference');
    const next = {};
    if (req.body?.label !== undefined) {
      next.label = clean(req.body.label, 60);
      if (!next.label) throw new HttpError(400, 'Give the preference a name');
    }
    if (req.body?.category !== undefined) {
      if (!PREF_CATEGORIES.includes(req.body.category)) throw new HttpError(400, `category must be one of: ${PREF_CATEGORIES.join(', ')}`);
      next.category = req.body.category;
    }
    if (req.body?.position !== undefined) {
      const n = Number(req.body.position);
      if (!Number.isInteger(n) || n < 0 || n > 10000) throw new HttpError(400, 'position must be a whole number');
      next.position = n;
    }
    if (req.body?.active !== undefined) {
      next.active = req.body.active ? 1 : 0;
      Object.assign(next, next.active ? { retired_at: null, retired_by: null } : { retired_at: (await practiceNow(db, req.user.practice_id)), retired_by: req.user.id });
    }
    if (Object.keys(next).length) {
      await update(db, 'patient_pref_options', before.id, req.user.practice_id, next);
      await audit(db, req, next.active === 0 ? 'preference_option.retire' : 'preference_option.change', 'patient_pref_options', before.id, { label: next.label ?? before.label }, {
        before: Object.fromEntries(Object.keys(next).map((k) => [k, before[k]])), after: next,
      });
      changed(req, 'options');
    }
    res.json(await db.get('SELECT * FROM patient_pref_options WHERE id = ?', before.id));
  });

  r.get('/patients/:id/preferences', requirePermission('patients:read'), async (req, res) => {
    const p = await patientFor(req, req.params.id);
    res.json(await patientPrefs(db, req.user.practice_id, p.id));
  });

  // Adding the same preference twice (a double click, two people at once) keeps one: the second just sets
  // urgent / the note. The partial unique index backs this up.
  r.post('/patients/:id/preferences', requirePermission('patients:write'), async (req, res) => {
    const p = await patientFor(req, req.params.id);
    const pid = req.user.practice_id;
    const option = await findOr404(db, 'patient_pref_options', req.body?.option_id, pid, 'Preference');
    if (!option.active) throw new HttpError(409, 'That preference has been retired from the list');
    const urgent = req.body?.urgent ? 1 : 0;
    const note = clean(req.body?.note, 200);
    const had = await db.get("SELECT * FROM patient_prefs WHERE patient_id = ? AND option_id = ? AND status = 'active'", p.id, option.id);
    if (had) {
      const next = { urgent, ...(req.body?.note !== undefined ? { note } : {}) };
      if (had.urgent !== urgent || (next.note !== undefined && next.note !== had.note)) {
        await update(db, 'patient_prefs', had.id, pid, { urgent, note: next.note !== undefined ? next.note : had.note, updated_by: req.user.id, updated_at: await practiceNow(db, pid) });
        await audit(db, req, 'patient_preference.change', 'patient_prefs', had.id, { label: option.label, patient_id: p.id }, {
          patientId: p.id, before: { urgent: had.urgent, note: had.note }, after: { urgent, note: next.note !== undefined ? next.note : had.note },
        });
        changed(req, 'prefs', p.id);
      }
      return res.json((await patientPrefs(db, pid, p.id)).find((x) => x.id === had.id));
    }
    let id;
    try {
      id = await insert(db, 'patient_prefs', { practice_id: pid, patient_id: p.id, option_id: option.id, urgent, note, source: sourceNow(), added_by: req.user.id });
    } catch (err) {
      // Someone added it at the same moment: theirs stands.
      const race = await db.get("SELECT id FROM patient_prefs WHERE patient_id = ? AND option_id = ? AND status = 'active'", p.id, option.id);
      if (!race) throw err;
      return res.json((await patientPrefs(db, pid, p.id)).find((x) => x.id === race.id));
    }
    await audit(db, req, 'patient_preference.add', 'patient_prefs', id, { label: option.label, urgent: !!urgent, patient_id: p.id }, { patientId: p.id, after: { option: option.label, urgent, note } });
    changed(req, 'prefs', p.id);
    res.status(201).json((await patientPrefs(db, pid, p.id)).find((x) => x.id === id));
  });

  const prefFor = async (req) => {
    const row = await findOr404(db, 'patient_prefs', req.params.id, req.user.practice_id, 'Preference');
    if (!(await canSeePatient(db, req.user, row.patient_id))) throw new HttpError(404, 'Preference not found');
    return row;
  };

  r.put('/patient-preferences/:id', requirePermission('patients:write'), async (req, res) => {
    const row = await prefFor(req);
    if (row.status !== 'active') throw new HttpError(409, 'That preference was removed');
    const next = {
      urgent: req.body?.urgent === undefined ? row.urgent : req.body.urgent ? 1 : 0,
      note: req.body?.note === undefined ? row.note : clean(req.body.note, 200),
    };
    if (next.urgent !== row.urgent || next.note !== row.note) {
      await update(db, 'patient_prefs', row.id, req.user.practice_id, { ...next, updated_by: req.user.id, updated_at: await practiceNow(db, req.user.practice_id) });
      await audit(db, req, 'patient_preference.change', 'patient_prefs', row.id, { patient_id: row.patient_id }, { patientId: row.patient_id, before: { urgent: row.urgent, note: row.note }, after: next });
      changed(req, 'prefs', row.patient_id);
    }
    res.json((await patientPrefs(db, req.user.practice_id, row.patient_id)).find((x) => x.id === row.id));
  });

  r.post('/patient-preferences/:id/remove', requirePermission('patients:write'), async (req, res) => {
    const row = await prefFor(req);
    if (row.status === 'removed') return res.json({ ok: true, already: true });
    const reason = clean(req.body?.reason, 200);
    await update(db, 'patient_prefs', row.id, req.user.practice_id, { status: 'removed', removed_by: req.user.id, removed_at: await practiceNow(db, req.user.practice_id), remove_reason: reason });
    const option = await db.get('SELECT label FROM patient_pref_options WHERE id = ?', row.option_id);
    await audit(db, req, 'patient_preference.remove', 'patient_prefs', row.id, { label: option?.label, patient_id: row.patient_id }, {
      patientId: row.patient_id, reason, before: { status: 'active', urgent: row.urgent }, after: { status: 'removed' },
    });
    changed(req, 'prefs', row.patient_id);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- PP2
  const notesOf = (pid, patientId, all) => db.all(
    `SELECT n.id, n.patient_id, n.body, n.source, n.created_at, n.removed_at, n.remove_reason, u.name AS by_name, x.name AS removed_by_name
     FROM personal_notes n LEFT JOIN users u ON u.id = n.created_by LEFT JOIN users x ON x.id = n.removed_by
     WHERE n.practice_id = ? AND n.patient_id = ?${all ? '' : ' AND n.removed_at IS NULL'} ORDER BY n.created_at DESC, n.id DESC`,
    pid, patientId,
  );

  r.get('/patients/:id/personal-notes', requirePermission('patients:read'), async (req, res) => {
    const p = await patientFor(req, req.params.id);
    res.json(await notesOf(req.user.practice_id, p.id, req.query.all === '1'));
  });

  r.post('/patients/:id/personal-notes', requirePermission('patients:write'), async (req, res) => {
    const p = await patientFor(req, req.params.id);
    const pid = req.user.practice_id;
    const body = clean(req.body?.body, 280);
    if (!body) throw new HttpError(400, 'Write a few words');
    const key = clean(req.body?.client_key, 80);
    if (key) {
      const had = await db.get('SELECT id FROM personal_notes WHERE practice_id = ? AND client_key = ?', pid, key);
      if (had) return res.json((await notesOf(pid, p.id, true)).find((n) => n.id === had.id));
    }
    const id = await insert(db, 'personal_notes', { practice_id: pid, patient_id: p.id, location_id: req.location_id ?? p.location_id ?? null, body, client_key: key, source: sourceNow(), created_by: req.user.id });
    await audit(db, req, 'personal_note.add', 'personal_notes', id, { patient_id: p.id }, { patientId: p.id, after: { body } });
    changed(req, 'personal', p.id);
    res.status(201).json((await notesOf(pid, p.id, true)).find((n) => n.id === id));
  });

  r.post('/personal-notes/:id/remove', requirePermission('patients:write'), async (req, res) => {
    const row = await findOr404(db, 'personal_notes', req.params.id, req.user.practice_id, 'Note');
    if (!(await canSeePatient(db, req.user, row.patient_id))) throw new HttpError(404, 'Note not found');
    if (row.removed_at) return res.json({ ok: true, already: true });
    const reason = clean(req.body?.reason, 200);
    await update(db, 'personal_notes', row.id, req.user.practice_id, { removed_at: await practiceNow(db, req.user.practice_id), removed_by: req.user.id, remove_reason: reason });
    await audit(db, req, 'personal_note.remove', 'personal_notes', row.id, { patient_id: row.patient_id }, { patientId: row.patient_id, reason, before: { body: row.body, removed_at: null }, after: { removed_at: 'now' } });
    changed(req, 'personal', row.patient_id);
    res.json({ ok: true });
  });

  // Everything the patient bar and the chart header show from PP1, PP2 and S8, in one request.
  r.get('/patients/:id/connection', requirePermission('patients:read'), async (req, res) => {
    const p = await patientFor(req, req.params.id);
    const pid = req.user.practice_id;
    const [prefs, personal, strikes] = await Promise.all([patientPrefs(db, pid, p.id), latestPersonal(db, pid, p.id), strikesFor(db, pid, p.id)]);
    const s = strikes[p.id] || null;
    res.json({
      prefs: prefs.map((x) => ({ id: x.id, option_id: x.option_id, label: x.label, category: x.category, urgent: !!x.urgent, note: x.note, by: x.added_by_name, at: x.added_at })),
      personal: personal[p.id] ? { id: personal[p.id].id, body: personal[p.id].body, at: personal[p.id].created_at, by: personal[p.id].by_name } : null,
      strikes: s, strike_warning: strikeWarning(p.preferred_name || p.first_name, s), office_reasons: OFFICE_REASONS,
    });
  });

  // ---------------------------------------------------------------- S6 + the schedule's card data
  r.get('/schedule-cards', requirePermission('schedule:read'), async (req, res) => {
    const from = req.query.from || req.query.date;
    const to = req.query.to || from;
    if (!isRealDate(from) || !isRealDate(to) || to < from) throw new HttpError(400, 'from and to must be real dates (YYYY-MM-DD)');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 31) throw new HttpError(400, 'At most a month at a time');
    const scope = appointmentScope(req.user);
    const data = await cardData(db, req.user, { from, to, scopeSql: scope.sql, scopeArgs: scope.args });
    const layouts = await layoutsFor(db, req.user);
    res.json({ ...data, layout: layouts.effective, own_layout: !!layouts.mine });
  });

  r.get('/card-layout', requirePermission('schedule:read'), async (req, res) => {
    const l = await layoutsFor(db, req.user);
    res.json({ ...l, default: DEFAULT_LAYOUT, items: CARD_ITEMS, can_edit_practice: req.user.role === 'admin' });
  });

  r.put('/card-layout', requirePermission('schedule:read'), async (req, res) => {
    admin(req);
    const pid = req.user.practice_id;
    const layout = req.body?.layout == null ? DEFAULT_LAYOUT : cleanLayout(req.body.layout);
    const before = await db.get('SELECT * FROM card_layouts WHERE practice_id = ?', pid);
    const json = JSON.stringify(layout);
    const now = await practiceNow(db, pid);
    if (before) await update(db, 'card_layouts', before.id, pid, { layout: json, updated_by: req.user.id, updated_at: now });
    else await db.run('INSERT INTO card_layouts (practice_id, layout, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (practice_id) DO UPDATE SET layout = excluded.layout, updated_by = excluded.updated_by, updated_at = excluded.updated_at', pid, json, req.user.id, now);
    const row = await db.get('SELECT id FROM card_layouts WHERE practice_id = ?', pid);
    await audit(db, req, 'card_layout.change', 'card_layouts', row.id, { reset: req.body?.layout == null }, { before: { layout: before?.layout ?? null }, after: { layout: json } });
    changed(req, 'layout');
    res.json(await layoutsFor(db, req.user));
  });

  // A person's own layout: a convenience kept in user_prefs (like the other remembered choices). null = the office's.
  r.put('/me/card-layout', requirePermission('schedule:read'), async (req, res) => {
    const before = await db.get('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?', req.user.id, USER_LAYOUT_KEY);
    if (req.body?.layout == null) {
      // Scratch: a remembered preference, not a record.
      if (before) await db.run('DELETE FROM user_prefs WHERE user_id = ? AND key = ?', req.user.id, USER_LAYOUT_KEY);
    } else {
      const json = JSON.stringify(cleanLayout(req.body.layout));
      await db.run(
        "INSERT INTO user_prefs (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        req.user.id, USER_LAYOUT_KEY, json,
      );
    }
    await audit(db, req, 'card_layout.personal', 'users', req.user.id, { reset: req.body?.layout == null });
    res.json(await layoutsFor(db, req.user));
  });

  r.post('/appointments/:id/labels', requirePermission('schedule:write'), async (req, res) => {
    const appt = await findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    const key = String(req.body?.label_key || '');
    const { effective } = await layoutsFor(db, req.user);
    const label = (effective.labels || []).find((l) => l.key === key);
    if (!label) throw new HttpError(400, 'That label isn’t one of the office’s labels (Customize cards → Office labels)');
    const on = req.body?.on !== false;
    const had = await db.get('SELECT * FROM appointment_labels WHERE appointment_id = ? AND label_key = ? AND removed_at IS NULL', appt.id, key);
    if (on && !had) {
      const id = await insert(db, 'appointment_labels', { practice_id: req.user.practice_id, appointment_id: appt.id, label_key: key, added_by: req.user.id });
      await audit(db, req, 'appointment.label', 'appointments', appt.id, { label: label.text, on: true, label_id: id }, { patientId: appt.patient_id });
    } else if (!on && had) {
      await update(db, 'appointment_labels', had.id, req.user.practice_id, { removed_at: await practiceNow(db, req.user.practice_id), removed_by: req.user.id });
      await audit(db, req, 'appointment.label', 'appointments', appt.id, { label: label.text, on: false, label_id: had.id }, { patientId: appt.patient_id });
    }
    publish(req.user.practice_id, { type: 'cards', what: 'labels', dates: [appt.start_time.slice(0, 10)], by: req.user.id });
    const labels = (await db.all('SELECT label_key FROM appointment_labels WHERE appointment_id = ? AND removed_at IS NULL', appt.id)).map((l) => l.label_key);
    res.json({ labels, can: can(req.user, 'schedule:write') });
  });

  return r;
}
