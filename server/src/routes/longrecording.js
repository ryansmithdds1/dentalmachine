import express, { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, change } from '../util.js';
import { canSeePatient } from '../officeaccess.js';
import { failed } from '../issues.js';
import {
  createExamTranscriber, processRecording, purgeRecording, readTranscript, buildDraft, sha256, clock, CHUNK_SECONDS, MAX_CHUNK_BYTES,
} from '../longrecording.js';
import { buildZip } from '../zip.js';

// Long recordings (LR1-LR3): start (with the patient's agreement), upload ~30-second chunks as they're recorded
// (each one idempotent by its number and content; out of order is fine; a resumed page asks which it still
// owes), pause/resume, finish (→ transcribed in the background), the transcript and audio (every view audited),
// the draft, and the office's retention setting.
export default function longRecordingRoutes({ db, config = {}, storage, transcriber = null, examTranscriber, fetchImpl }) {
  const r = Router();
  const engine = () => (examTranscriber !== undefined ? examTranscriber : createExamTranscriber({ config, fetchImpl, transcriber }));
  const deps = () => ({ storage, examTranscriber: engine(), config });
  const MUTABLE = ['recording', 'paused'];

  async function sessionOr404(req) {
    const s = await findOr404(db, 'recording_sessions', req.params.sid, req.user.practice_id, 'Recording');
    if (!(await canSeePatient(db, req.user, s.patient_id))) throw new HttpError(404, 'Recording not found');
    return s;
  }
  const view = async (s) => {
    const chunks = await db.all('SELECT seq, start_ms, duration_ms, size FROM recording_chunks WHERE session_id = ? ORDER BY seq', s.id);
    const received = chunks.map((c) => c.seq);
    const top = received.length ? Math.max(...received) : -1;
    const missing = [];
    for (let i = 0; i <= Math.max(top, (s.chunk_count ?? 0) - 1); i++) if (!received.includes(i)) missing.push(i);
    const rest = { ...s };
    delete rest.draft;
    delete rest.transcript_key;
    return { ...rest, received, missing, has_transcript: !!s.transcript_key, has_draft: !!s.draft, duration: clock(s.duration_ms || 0) };
  };
  const kick = (s) => setImmediate(() => processRecording(db, deps(), s.id).catch(failed(db, { practiceId: s.practice_id, kind: 'ai', key: `recording-transcribe:${s.id}`, role: 'clinical', title: 'A long visit recording couldn’t be transcribed', patientId: s.patient_id })));

  r.get('/long-recordings/status', requirePermission('clinical:write'), async (req, res) => {
    const e = engine();
    const p = await db.get('SELECT recording_retention_days FROM practices WHERE id = ?', req.user.practice_id);
    res.json({ enabled: !!e && !!storage, vendor: e?.mode ?? null, speakers: e?.diarizes ? 'separated' : 'guessed', chunk_seconds: CHUNK_SECONDS, max_chunk_bytes: MAX_CHUNK_BYTES, retention_days: p?.recording_retention_days ?? 90, encrypted: !!storage?.encrypted });
  });

  // The office's retention: how long audio and transcript are kept (the signed note is kept regardless).
  r.put('/long-recordings/settings', requirePermission('clinical:read'), async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Administrator access required');
    const days = Number(req.body?.retention_days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new HttpError(400, 'retention_days must be a whole number of days from 1 to 3650');
    await change(db, 'practices', req.user.practice_id, { recording_retention_days: days });
    await audit(db, req, 'recording.retention', 'practices', req.user.practice_id, { retention_days: days });
    res.json({ retention_days: days });
  });

  r.get('/patients/:id/long-recordings', requirePermission('clinical:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const rows = await db.all('SELECT s.*, u.name AS recorded_by FROM recording_sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.patient_id = ? AND s.practice_id = ? ORDER BY s.id DESC LIMIT 50', patient.id, req.user.practice_id);
    res.json(await Promise.all(rows.map(view)));
  });

  // Start. The browser names the session (client_id), so a retried start returns the same one.
  r.post('/long-recordings', requirePermission('clinical:write'), async (req, res) => {
    const pid = req.user.practice_id;
    if (!engine() || !storage) throw new HttpError(409, 'Long recordings need a transcription service on the server (TRANSCRIBE)');
    const clientId = String(req.body?.client_id || '').trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) throw new HttpError(400, 'client_id is required (8-64 letters, numbers, - or _)');
    const existing = await db.get('SELECT * FROM recording_sessions WHERE practice_id = ? AND client_id = ?', pid, clientId);
    if (existing) {
      if (!(await canSeePatient(db, req.user, existing.patient_id))) throw new HttpError(404, 'Recording not found');
      return res.json(await view(existing));
    }
    if (req.body?.consent !== true) throw new HttpError(400, 'Tick “Patient agreed to recording” first');
    const patient = await findOr404(db, 'patients', req.body?.patient_id, pid, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    let visit = null;
    if (req.body?.appointment_id) {
      visit = await findOr404(db, 'appointments', req.body.appointment_id, pid, 'Appointment');
      if (visit.patient_id !== patient.id) throw new HttpError(400, "That visit is another patient's");
    }
    const provider = req.body?.provider_id ? await findOr404(db, 'providers', req.body.provider_id, pid, 'Provider') : null;
    const mime = String(req.body?.mime || 'audio/webm').split(';')[0].trim().toLowerCase();
    if (!/^audio\/[a-z0-9.+-]+$/.test(mime)) throw new HttpError(400, 'mime must be an audio type');
    const row = await db.run(
      `INSERT INTO recording_sessions (practice_id, location_id, patient_id, appointment_id, provider_id, user_id, client_id, consent, consent_at, consent_by, mime)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), ?, ?) ON CONFLICT DO NOTHING`,
      pid, visit?.location_id ?? req.location_id ?? patient.location_id ?? null, patient.id, visit?.id ?? null, provider?.id ?? visit?.provider_id ?? null, req.user.id, clientId, req.user.id, mime,
    );
    const s = await db.get('SELECT * FROM recording_sessions WHERE practice_id = ? AND client_id = ?', pid, clientId);
    if (row.changes) await audit(db, req, 'recording.start', 'recording_sessions', s.id, { consent: 'Patient agreed to recording', appointment_id: s.appointment_id }, { patientId: patient.id });
    res.status(row.changes ? 201 : 200).json(await view(s));
  });

  r.get('/long-recordings/:sid', requirePermission('clinical:read'), async (req, res) => {
    res.json(await view(await sessionOr404(req)));
  });

  // One chunk. Same number and same bytes again: accepted as already there. Same number, different bytes: refused.
  r.put('/long-recordings/:sid/chunks/:seq', requirePermission('clinical:write'), express.raw({ type: () => true, limit: MAX_CHUNK_BYTES }), async (req, res) => {
    const s = await sessionOr404(req);
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0 || seq > 20_000) throw new HttpError(400, 'Chunk number must be 0-20000');
    const audio = Buffer.isBuffer(req.body) ? req.body : null;
    if (!audio?.length) throw new HttpError(400, 'No audio');
    const hash = sha256(audio);
    if (req.get('X-Chunk-Sha256') && req.get('X-Chunk-Sha256') !== hash) throw new HttpError(400, 'The chunk arrived damaged — send it again');
    const had = await db.get('SELECT seq, sha256 FROM recording_chunks WHERE session_id = ? AND seq = ?', s.id, seq);
    if (had) {
      if (had.sha256 !== hash) throw new HttpError(409, `Part ${seq + 1} was already received with different audio`);
      return res.json({ seq, duplicate: true });
    }
    if (!MUTABLE.includes(s.status)) throw new HttpError(409, 'This recording is finished; nothing more can be added');
    const start = Math.max(0, Math.round(Number(req.get('X-Start-Ms')) || seq * CHUNK_SECONDS * 1000));
    const duration = Math.max(0, Math.min(10 * 60_000, Math.round(Number(req.get('X-Duration-Ms')) || CHUNK_SECONDS * 1000)));
    const mime = String(req.get('Content-Type') || s.mime || 'audio/webm').split(';')[0];
    const saved = await storage.save(s.practice_id, audio);
    const ins = await db.run(
      'INSERT INTO recording_chunks (practice_id, session_id, seq, start_ms, duration_ms, size, sha256, mime, storage_key, encrypted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      s.practice_id, s.id, seq, start, duration, audio.length, hash, mime, saved.storageKey, saved.encrypted ? 1 : 0,
    );
    if (!ins.changes) {
      // The same chunk raced in twice; the first one stands.
      const now = await db.get('SELECT sha256 FROM recording_chunks WHERE session_id = ? AND seq = ?', s.id, seq);
      if (now.sha256 !== hash) throw new HttpError(409, `Part ${seq + 1} was already received with different audio`);
      return res.json({ seq, duplicate: true });
    }
    await db.run('UPDATE recording_sessions SET duration_ms = CASE WHEN duration_ms > ? THEN duration_ms ELSE ? END WHERE id = ?', start + duration, start + duration, s.id);
    res.status(201).json({ seq, size: audio.length });
  });

  const pauseLog = async (s, action) => {
    const list = JSON.parse(s.pauses || '[]');
    list.push({ action, at: new Date().toISOString() });
    return JSON.stringify(list.slice(-500));
  };
  r.post('/long-recordings/:sid/pause', requirePermission('clinical:write'), async (req, res) => {
    const s = await sessionOr404(req);
    if (s.status === 'paused') return res.json(await view(s));
    if (s.status !== 'recording') throw new HttpError(409, 'Not recording');
    await db.run("UPDATE recording_sessions SET status = 'paused', pauses = ? WHERE id = ?", await pauseLog(s, 'pause'), s.id);
    res.json(await view(await db.get('SELECT * FROM recording_sessions WHERE id = ?', s.id)));
  });
  r.post('/long-recordings/:sid/resume', requirePermission('clinical:write'), async (req, res) => {
    const s = await sessionOr404(req);
    if (s.status === 'recording') return res.json(await view(s));
    if (s.status !== 'paused') throw new HttpError(409, 'This recording is finished');
    await db.run("UPDATE recording_sessions SET status = 'recording', pauses = ? WHERE id = ?", await pauseLog(s, 'resume'), s.id);
    res.json(await view(await db.get('SELECT * FROM recording_sessions WHERE id = ?', s.id)));
  });

  // Finish: every chunk 0..n-1 must be here (the page sends what it still has, then finishes again).
  r.post('/long-recordings/:sid/finish', requirePermission('clinical:write'), async (req, res) => {
    const s = await sessionOr404(req);
    if (!MUTABLE.includes(s.status)) return res.status(202).json(await view(s));
    const count = Number(req.body?.chunk_count);
    if (!Number.isInteger(count) || count < 1 || count > 20_001) throw new HttpError(400, 'chunk_count is required');
    const have = new Set((await db.all('SELECT seq FROM recording_chunks WHERE session_id = ?', s.id)).map((c) => c.seq));
    const missing = [];
    for (let i = 0; i < count; i++) if (!have.has(i)) missing.push(i);
    if (missing.length) throw new HttpError(409, `${missing.length} part${missing.length === 1 ? '' : 's'} of the recording haven’t arrived yet`, { missing });
    const done = await db.run("UPDATE recording_sessions SET status = 'uploaded', chunk_count = ?, finished_at = datetime('now') WHERE id = ? AND status IN ('recording','paused')", count, s.id);
    const after = await db.get('SELECT * FROM recording_sessions WHERE id = ?', s.id);
    if (done.changes) {
      await audit(db, req, 'recording.finish', 'recording_sessions', s.id, { chunks: count, minutes: Math.round((after.duration_ms || 0) / 60000) }, { patientId: s.patient_id });
      if (req.query.wait !== '1') kick(after);
      else await processRecording(db, deps(), s.id);
    }
    res.status(202).json(await view(await db.get('SELECT * FROM recording_sessions WHERE id = ?', s.id)));
  });

  r.post('/long-recordings/:sid/retry', requirePermission('clinical:write'), async (req, res) => {
    const s = await sessionOr404(req);
    if (s.status !== 'failed') throw new HttpError(409, 'Only a recording whose transcription failed can be retried');
    await audit(db, req, 'recording.retry', 'recording_sessions', s.id, { attempts: s.attempts }, { patientId: s.patient_id });
    await processRecording(db, deps(), s.id);
    res.json(await view(await db.get('SELECT * FROM recording_sessions WHERE id = ?', s.id)));
  });

  // The patient changed their mind, or it was the wrong patient: the audio and transcript are removed now.
  r.post('/long-recordings/:sid/discard', requirePermission('clinical:write'), async (req, res) => {
    const s = await sessionOr404(req);
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) throw new HttpError(400, 'Say why the recording is being removed');
    if (s.purged_at) return res.json(await view(s));
    if (s.status === 'transcribing') throw new HttpError(409, 'Wait for the transcription to finish, then remove it');
    const out = await purgeRecording(db, storage, s, reason);
    await db.run("UPDATE recording_sessions SET status = 'discarded' WHERE id = ?", s.id);
    await audit(db, req, 'recording.discarded', 'recording_sessions', s.id, out, { reason, patientId: s.patient_id, before: { status: s.status }, after: { status: 'discarded' } });
    res.json(await view(await db.get('SELECT * FROM recording_sessions WHERE id = ?', s.id)));
  });

  // Reading the transcript, playing a part and downloading the audio are each recorded (who, when, which).
  r.get('/long-recordings/:sid/transcript', requirePermission('clinical:read'), async (req, res) => {
    const s = await sessionOr404(req);
    if (!s.transcript_key) throw new HttpError(s.purged_at ? 410 : 409, s.purged_at ? 'This recording was removed after the office’s retention period' : 'Not transcribed yet');
    const t = await readTranscript(storage, s);
    await audit(db, req, 'recording.transcript_view', 'recording_sessions', s.id, { lines: t.lines.length }, { patientId: s.patient_id });
    res.json({ ...t, lines: t.lines.map((l) => ({ ...l, time: clock(l.t) })) });
  });
  r.get('/long-recordings/:sid/audio/:seq', requirePermission('clinical:read'), async (req, res) => {
    const s = await sessionOr404(req);
    const c = await db.get('SELECT * FROM recording_chunks WHERE session_id = ? AND seq = ?', s.id, Number(req.params.seq));
    if (!c) throw new HttpError(404, 'Not found');
    if (!c.storage_key) throw new HttpError(410, 'This recording was removed after the office’s retention period');
    const audio = await storage.read(c.storage_key, !!c.encrypted);
    await audit(db, req, 'recording.play', 'recording_sessions', s.id, { part: c.seq + 1 }, { patientId: s.patient_id });
    res.set('Content-Type', c.mime || 'audio/webm').set('Cache-Control', 'no-store').send(audio);
  });
  r.get('/long-recordings/:sid/download', requirePermission('clinical:read'), async (req, res) => {
    const s = await sessionOr404(req);
    const chunks = await db.all('SELECT * FROM recording_chunks WHERE session_id = ? AND storage_key IS NOT NULL ORDER BY seq', s.id);
    if (!chunks.length) throw new HttpError(410, 'This recording was removed after the office’s retention period');
    const ext = (m) => (/ogg/.test(m) ? 'ogg' : /mp4|m4a|aac/.test(m) ? 'm4a' : /wav/.test(m) ? 'wav' : 'webm');
    const files = [];
    for (const c of chunks) files.push({ name: `part-${String(c.seq + 1).padStart(4, '0')}-${clock(c.start_ms).replace(':', 'm')}s.${ext(c.mime || s.mime)}`, data: await storage.read(c.storage_key, !!c.encrypted) });
    if (s.transcript_key) {
      const t = await readTranscript(storage, s);
      files.push({ name: 'transcript.txt', data: t.lines.map((l) => `L${l.n} [${clock(l.t)}] ${l.speaker}${l.separated ? '' : ' (guessed)'}: ${l.text}`).join('\n') });
    }
    await audit(db, req, 'recording.download', 'recording_sessions', s.id, { parts: chunks.length }, { patientId: s.patient_id });
    res.set('Content-Type', 'application/zip').set('Content-Disposition', `attachment; filename="recording-${s.id}.zip"`).send(buildZip(files));
  });

  // The draft note (built when the transcript was); ?rebuild=1 builds it again (e.g. after templates changed).
  r.get('/long-recordings/:sid/draft', requirePermission('clinical:write'), async (req, res) => {
    const s = await sessionOr404(req);
    if (s.status !== 'transcribed' || !s.transcript_key) throw new HttpError(409, s.status === 'failed' ? `Transcription failed: ${s.last_error || 'unknown error'}` : 'Not transcribed yet');
    let draft = s.draft ? JSON.parse(s.draft) : null;
    if (!draft || req.query.rebuild === '1') {
      draft = await buildDraft(db, config, s, await readTranscript(storage, s));
      await db.run('UPDATE recording_sessions SET draft = ? WHERE id = ?', JSON.stringify(draft), s.id);
    }
    await audit(db, req, 'recording.draft_view', 'recording_sessions', s.id, null, { patientId: s.patient_id });
    res.json({ session_id: s.id, appointment_id: s.appointment_id, ...draft });
  });

  // The note that came of it: the AI drafted it, this person reviewed (maybe edited) and saved it.
  r.post('/long-recordings/:sid/saved', requirePermission('clinical:write'), async (req, res) => {
    const s = await sessionOr404(req);
    const note = await findOr404(db, 'clinical_notes', req.body?.note_id, req.user.practice_id, 'Note');
    if (note.patient_id !== s.patient_id) throw new HttpError(400, "That note is another patient's");
    if (s.note_id === note.id) return res.json({ ok: true });
    await db.run('UPDATE recording_sessions SET note_id = ? WHERE id = ?', note.id, s.id);
    await audit(db, req, 'note.ai_draft_approved', 'clinical_notes', note.id, { drafted_by: 'AI scribe (long recording)', approved_by: req.user.name, edited_before_saving: !!req.body?.edited, recording: s.id, charting_accepted: Array.isArray(req.body?.accepted) ? req.body.accepted.slice(0, 50) : [] }, { patientId: note.patient_id });
    res.json({ ok: true });
  });

  return r;
}
