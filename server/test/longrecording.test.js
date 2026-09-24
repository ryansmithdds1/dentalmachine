// Long recordings (LR1-LR3): chunks upload idempotently and out of order, a page resumes by asking what's
// missing, the audio is encrypted at rest, a 90-minute transcript is merged from its chunks with timestamps and
// split into windows for the draft, the draft maps each item to its transcript line, retention removes audio and
// transcript (audited) but never the note, and failed transcriptions raise a Needs-attention item that resolves
// on retry. The routes aren't mounted in app.js by this file's author, so they're mounted on a small app here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './helpers.js';
import longRecordingRoutes from '../src/routes/longrecording.js';
import { authenticate, HttpError } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';
import { createStorage } from '../src/storage.js';
import { createExamTranscriber, mergeTranscripts, windows, extractFromTranscript, runRecordingJobs, runRecordingRetention, roleOf } from '../src/longrecording.js';

const h = harness();
const dir = mkdtempSync(join(tmpdir(), 'dm-lr-'));
const removed = [];
// Encrypted storage like documents; `remove` records what retention deletes.
const base = createStorage({ dir, key: 'long-recording-test-key' });
const storage = { ...base, async remove(key) { removed.push(key); } };
const sandbox = createExamTranscriber({ config: { transcribe: 'sandbox' } });
// A speech service that can be made to fail.
const flaky = { mode: 'test', diarizes: true, fail: false, calls: 0, async transcribe(audio, opts) { this.calls++; if (this.fail) throw new Error('Speech service unavailable'); return sandbox.transcribe(audio, opts); } };
let origin;
let server;
before(async () => {
  for (let i = 0; !h.db && i < 3000; i++) await new Promise((r) => setTimeout(r, 20));
  const app = express();
  app.use(actorMiddleware(h.db, flushChanges));
  app.use(express.json());
  const api = express.Router();
  api.use(authenticate(h.db, 'test-secret'));
  api.use((req, _res, next) => {
    setActor({ source: 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
    next();
  });
  api.use(officeAccess(h.db));
  api.use(longRecordingRoutes({ db: h.db, config: h.config, storage, examTranscriber: flaky }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : err.status || 500).json({ error: err.message, details: err.details }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); rmSync(dir, { recursive: true, force: true }); });

const call = (token) => async (method, path, body, headers = {}) => {
  const raw = Buffer.isBuffer(body);
  const res = await fetch(`${origin}/api${path}`, {
    method, headers: { 'Content-Type': raw ? 'audio/webm' : 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = buf;
  try { data = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, data, type: res.headers.get('content-type') };
};
const chunk = (lines) => Buffer.from(`SANDBOX\n${lines.map(([sp, at, text]) => `${sp}|${at}|${text}`).join('\n')}`);
const cid = () => `test-${Math.random().toString(36).slice(2, 12)}`;

// An exam in three 30-second parts: the dentist (speaker 0), the patient (1) and the assistant (2).
const EXAM = [
  chunk([[0, 1, 'Medical history reviewed, no changes. Blood pressure 124 over 80.'], [0, 8, 'Number 30 has distal caries into dentin, and #3 has a cracked mesial marginal ridge.'], [1, 20, 'Yes, it hurts when I chew on that side.']]),
  chunk([[0, 2, 'Probing depths on 30 are 3 2 4, bleeding on probing.'], [2, 10, 'Got it, recorded, suction here.'], [0, 15, 'I recommend a crown on #3; the other option is to watch it. Risks of waiting include fracture, do you understand?'], [1, 25, 'I understand. Let’s do the filling today and wait on the crown.']]),
  chunk([[0, 1, 'Two carpules of 4% articaine with epi, infiltration buccal on 30.'], [0, 9, 'Placing composite on number 30 DO, shade A2, Vitrebond liner.'], [0, 20, 'Post-op: you will be numb for two hours, avoid chewing on that side, ibuprofen as needed.']]),
];

async function setUp() {
  const p = await h.practice({ timezone: 'UTC' });
  const pid = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', p.patient.id)).practice_id;
  await p.api.get('/note-templates'); // the office's starter templates
  const appt = (await h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, '2026-09-01 09:00', '2026-09-01 10:30', 'in_chair')", pid, p.patient.id, p.provider.id)).id;
  return { ...p, pid, appt, api2: call(p.token) };
}

test('start needs the patient’s agreement and is idempotent; chunks are idempotent, out of order, resumable; audio encrypted at rest', async () => {
  const s = await setUp();
  const api = s.api2;
  const clientId = cid();
  assert.equal((await api('POST', '/long-recordings', { patient_id: s.patient.id, client_id: clientId })).status, 400); // no consent
  const start = await api('POST', '/long-recordings', { patient_id: s.patient.id, appointment_id: s.appt, client_id: clientId, consent: true });
  assert.equal(start.status, 201, JSON.stringify(start.data));
  assert.equal(start.data.consent, 1);
  assert.ok(start.data.consent_at);
  const again = await api('POST', '/long-recordings', { patient_id: s.patient.id, appointment_id: s.appt, client_id: clientId, consent: true });
  assert.equal(again.status, 200);
  assert.equal(again.data.id, start.data.id);
  const sid = start.data.id;
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'recording.start' AND entity_id = ?", sid));

  // Out of order: part 3, then part 1.
  assert.equal((await api('PUT', `/long-recordings/${sid}/chunks/2`, EXAM[2], { 'X-Start-Ms': '60000', 'X-Duration-Ms': '30000' })).status, 201);
  assert.equal((await api('PUT', `/long-recordings/${sid}/chunks/0`, EXAM[0], { 'X-Start-Ms': '0', 'X-Duration-Ms': '30000' })).status, 201);
  // The same part again (a retry after a dropped response): accepted, not stored twice.
  const dup = await api('PUT', `/long-recordings/${sid}/chunks/0`, EXAM[0], { 'X-Start-Ms': '0' });
  assert.deepEqual([dup.status, dup.data.duplicate], [200, true]);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM recording_chunks WHERE session_id = ?', sid)).n, 2);
  // The same number with different audio is refused.
  assert.equal((await api('PUT', `/long-recordings/${sid}/chunks/0`, Buffer.from('other audio'))).status, 409);
  // A damaged upload is refused.
  assert.equal((await api('PUT', `/long-recordings/${sid}/chunks/1`, EXAM[1], { 'X-Chunk-Sha256': 'deadbeef' })).status, 400);

  // Pause and resume.
  assert.equal((await api('POST', `/long-recordings/${sid}/pause`)).data.status, 'paused');
  assert.equal((await api('POST', `/long-recordings/${sid}/resume`)).data.status, 'recording');

  // The page comes back (browser closed): it asks what's missing; finishing too early says which parts.
  const state = (await api('GET', `/long-recordings/${sid}`)).data;
  assert.deepEqual([state.received, state.missing], [[0, 2], [1]]);
  const early = await api('POST', `/long-recordings/${sid}/finish`, { chunk_count: 3 });
  assert.equal(early.status, 409);
  assert.deepEqual(early.data.details.missing, [1]);
  assert.equal((await api('PUT', `/long-recordings/${sid}/chunks/1`, EXAM[1], { 'X-Start-Ms': '30000' })).status, 201);

  // Encrypted at rest: the stored file isn't the audio.
  const stored = await h.db.get('SELECT storage_key, encrypted FROM recording_chunks WHERE session_id = ? AND seq = 0', sid);
  assert.equal(stored.encrypted, 1);
  const onDisk = readFileSync(join(dir, stored.storage_key));
  assert.equal(onDisk.subarray(0, 4).toString(), 'DMK2');
  assert.ok(!onDisk.includes(Buffer.from('caries')));
  assert.deepEqual(await storage.read(stored.storage_key, true), EXAM[0]);

  // Another practice can't see or add to it.
  const other = await setUp();
  assert.equal((await other.api2('GET', `/long-recordings/${sid}`)).status, 404);
  assert.equal((await other.api2('PUT', `/long-recordings/${sid}/chunks/3`, EXAM[0])).status, 404);

  // Finish → transcribed (in the background normally; ?wait=1 here).
  const done = await api('POST', `/long-recordings/${sid}/finish?wait=1`, { chunk_count: 3 });
  assert.equal(done.status, 202);
  assert.equal(done.data.status, 'transcribed', JSON.stringify(done.data));
  assert.equal((await api('PUT', `/long-recordings/${sid}/chunks/3`, EXAM[0])).status, 409); // finished
  assert.equal((await api('POST', `/long-recordings/${sid}/finish`, { chunk_count: 3 })).status, 202); // finishing again is harmless

  // Assembled transcript: in time order across parts, numbered, speakers separated and named.
  const t = (await api('GET', `/long-recordings/${sid}/transcript`)).data;
  assert.equal(t.speakers, 'separated');
  assert.deepEqual(t.lines.map((l) => l.n), t.lines.map((_, i) => i + 1));
  assert.ok(t.lines.every((l, i) => i === 0 || l.t >= t.lines[i - 1].t));
  assert.equal(t.lines.find((l) => /Placing composite/.test(l.text)).time, '1:09');
  assert.equal(t.lines.find((l) => /it hurts when I chew/.test(l.text)).speaker, 'Patient');
  assert.equal(t.lines.find((l) => /suction/.test(l.text)).speaker, 'Assistant');
  assert.equal(t.lines.find((l) => /distal caries/.test(l.text)).speaker, 'Doctor');
  const transcriptRow = await h.db.get('SELECT transcript_key, transcript_encrypted FROM recording_sessions WHERE id = ?', sid);
  assert.equal(transcriptRow.transcript_encrypted, 1);
  assert.ok(!readFileSync(join(dir, transcriptRow.transcript_key)).includes(Buffer.from('caries')));
  // Reading it, playing a part and downloading are each audited.
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'recording.transcript_view' AND entity_id = ?", sid));
  const play = await api('GET', `/long-recordings/${sid}/audio/1`);
  assert.deepEqual(play.data, EXAM[1]);
  const zip = await api('GET', `/long-recordings/${sid}/download`);
  assert.equal(zip.type, 'application/zip');
  assert.equal(zip.data.subarray(0, 2).toString(), 'PK');
  assert.deepEqual((await h.db.all("SELECT action FROM audit_log WHERE entity = 'recording_sessions' AND entity_id = ? AND action IN ('recording.play','recording.download') ORDER BY id", sid)).map((a) => a.action), ['recording.play', 'recording.download']);

  // The draft: the office's template, each section item pointing at its transcript line, codes to approve.
  const d = (await api('GET', `/long-recordings/${sid}/draft`)).data;
  const lineOf = (re) => t.lines.find((l) => re.test(l.text)).n;
  const section = (k) => d.sections.find((x) => x.key === k).items;
  assert.deepEqual(section('findings').find((i) => /distal caries/.test(i.text)).lines, [lineOf(/distal caries/)]);
  assert.ok(section('perio').some((i) => i.lines[0] === lineOf(/Probing depths/) && i.readings[0].join(' ') === '3 2 4'));
  assert.ok(section('treatment').some((i) => i.lines[0] === lineOf(/recommend a crown/)));
  assert.ok(section('options').some((i) => i.decision && i.lines[0] === lineOf(/Let’s do the filling/)));
  assert.ok(section('consent').some((i) => i.lines[0] === lineOf(/Risks of waiting/)));
  assert.ok(section('anesthetic').some((i) => i.lines[0] === lineOf(/articaine/)));
  assert.ok(section('materials').some((i) => i.lines[0] === lineOf(/shade A2/)));
  assert.ok(section('postop').some((i) => i.lines[0] === lineOf(/Post-op/)));
  const composite = d.suggested.find((x) => x.code === 'D2392');
  assert.deepEqual([composite.tooth, composite.surfaces, composite.status, composite.lines, composite.known], ['30', 'DO', 'completed', [lineOf(/Placing composite/)], true]);
  assert.ok(d.suggested.some((x) => x.code === 'D2740' && x.tooth === '3' && x.status === 'planned'));
  assert.ok(d.templates.includes('Composite restoration'));
  assert.match(d.note, /shade A2/); // the template's shade question answered from what was said
  assert.match(d.note, /4% articaine/);
  assert.match(d.note, /Findings by tooth:/);
  // Nothing charted or written by the draft itself.
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM procedures WHERE patient_id = ?', s.patient.id)).n, 0);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM clinical_notes WHERE patient_id = ?', s.patient.id)).n, 0);

  // The clinician saves the note: recorded as the approver of the AI draft.
  const note = (await s.api.post(`/patients/${s.patient.id}/notes`, { body: d.note, appointment_id: s.appt })).data;
  assert.equal((await api('POST', `/long-recordings/${sid}/saved`, { note_id: note.id, edited: true })).status, 200);
  const approval = await h.db.get("SELECT details FROM audit_log WHERE action = 'note.ai_draft_approved' AND entity_id = ?", note.id);
  assert.match(approval.details, /long recording/);
});

test('a long visit: 90 minutes of chunks merge in order, and the transcript is split into windows for drafting', () => {
  const parts = [];
  for (let seq = 0; seq < 180; seq++) {
    parts.push({ seq, start_ms: seq * 30_000, diarized: true, utterances: [
      { speaker: 0, start: 1, end: 5, text: `Checking tooth number ${(seq % 32) + 1}, no caries, margins intact on the restoration.` },
      { speaker: 1, start: 12, end: 14, text: 'Okay, I understand.' },
      { speaker: 0, start: 28, end: 30, text: seq === 5 ? 'Boundary words' : `Moving on ${seq}.` },
    ] });
  }
  // A recorder restart repeating the last words at the start of the next part.
  parts[6].utterances.unshift({ speaker: 0, start: 0, end: 0.5, text: 'Boundary words' });
  const merged = mergeTranscripts(parts.reverse());
  assert.equal(merged.lines.length, 180 * 3);
  assert.ok(merged.lines.every((l, i) => i === 0 || l.t > merged.lines[i - 1].t));
  assert.equal(merged.lines.at(-1).t, 179 * 30_000 + 28_000);
  const w = windows(merged.lines, 20_000);
  assert.ok(w.length >= 2);
  assert.equal(w.flat().length, merged.lines.length);
  assert.ok(w.every((x) => x.join('\n').length <= 20_100));
  assert.match(w[1][0], /^L\d+ \[\d+:\d\d\] (Doctor|Patient|Assistant): /);
  // Without speaker separation, sentences are split and each speaker is a guess.
  const plain = mergeTranscripts([{ seq: 0, start_ms: 0, diarized: false, utterances: [{ speaker: null, start: 0, end: 30, text: 'Number 14 has recurrent decay. Does it hurt? Yes it hurts when I drink cold water.' }] }]);
  assert.equal(plain.speakers, 'guessed');
  assert.deepEqual(plain.lines.map((l) => l.speaker), ['Doctor', 'Doctor', 'Patient']); // the question is the dentist's
  assert.equal(roleOf('Suction please, got it.'), 'Assistant');
  // The rules draft finds work with its teeth in any line of a long visit.
  const x = extractFromTranscript(merged.lines);
  assert.ok(x.sections.findings.length === 0); // "no caries" isn't a finding
});

test('failed transcription goes to Needs attention, retries with backoff, and resolves when it works', async () => {
  const s = await setUp();
  const api = s.api2;
  const sid = (await api('POST', '/long-recordings', { patient_id: s.patient.id, client_id: cid(), consent: true })).data.id;
  await api('PUT', `/long-recordings/${sid}/chunks/0`, EXAM[0]);
  flaky.fail = true;
  const fin = await api('POST', `/long-recordings/${sid}/finish?wait=1`, { chunk_count: 1 });
  assert.equal(fin.data.status, 'failed');
  assert.equal(fin.data.attempts, 1);
  assert.ok(fin.data.next_attempt_at);
  const issue = await h.db.get('SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ?', s.pid, `recording-transcribe:${sid}`);
  assert.equal(issue.status, 'open');
  assert.equal(issue.patient_id, s.patient.id);
  assert.equal((await api('GET', `/long-recordings/${sid}/draft`)).status, 409);
  // The job doesn't retry before the backoff is up …
  await runRecordingJobs(h.db, { storage, examTranscriber: flaky, config: {} }, { now: new Date() });
  assert.equal((await h.db.get('SELECT attempts FROM recording_sessions WHERE id = ?', sid)).attempts, 1);
  // … fails again later (counted on the same Needs-attention item) …
  await runRecordingJobs(h.db, { storage, examTranscriber: flaky, config: {} }, { now: new Date(Date.now() + 6 * 60_000) });
  assert.equal((await h.db.get('SELECT attempts FROM recording_sessions WHERE id = ?', sid)).attempts, 2);
  assert.equal((await h.db.get('SELECT occurrences FROM issues WHERE id = ?', issue.id)).occurrences, 2);
  // … and when the service is back, a retry (by a person here) works and resolves it.
  flaky.fail = false;
  const retried = await api('POST', `/long-recordings/${sid}/retry`);
  assert.equal(retried.data.status, 'transcribed');
  assert.equal((await h.db.get('SELECT status FROM issues WHERE id = ?', issue.id)).status, 'resolved');
  assert.equal((await api('POST', `/long-recordings/${sid}/retry`)).status, 409);
});

test('retention: audio and transcript removed after the office’s days (audited), the signed note stays; discard now', async () => {
  const s = await setUp();
  const api = s.api2;
  assert.equal((await api('PUT', '/long-recordings/settings', { retention_days: 0 })).status, 400);
  assert.equal((await api('PUT', '/long-recordings/settings', { retention_days: 30 })).data.retention_days, 30);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'recording.retention' AND practice_id = ?", s.pid));
  const make = async () => {
    const sid = (await api('POST', '/long-recordings', { patient_id: s.patient.id, client_id: cid(), consent: true })).data.id;
    await api('PUT', `/long-recordings/${sid}/chunks/0`, EXAM[0]);
    await api('POST', `/long-recordings/${sid}/finish?wait=1`, { chunk_count: 1 });
    return sid;
  };
  const oldSigned = await make();
  const oldUnsigned = await make();
  const fresh = await make();
  const signedNote = (await s.api.post(`/patients/${s.patient.id}/notes`, { body: 'Exam from recording.' })).data;
  await h.db.run("UPDATE clinical_notes SET signed = 1, signed_at = datetime('now') WHERE id = ?", signedNote.id);
  const unsignedNote = (await s.api.post(`/patients/${s.patient.id}/notes`, { body: 'Draft from recording.' })).data;
  await h.db.run('UPDATE recording_sessions SET note_id = ? WHERE id = ?', signedNote.id, oldSigned);
  await h.db.run('UPDATE recording_sessions SET note_id = ? WHERE id = ?', unsignedNote.id, oldUnsigned);
  await h.db.run("UPDATE recording_sessions SET finished_at = '2020-01-01 00:00:00' WHERE id IN (?, ?)", oldSigned, oldUnsigned);
  const keys = (await h.db.all('SELECT storage_key, transcript_key FROM recording_chunks WHERE session_id = ?', oldSigned)).flatMap((c) => [c.storage_key, c.transcript_key]);

  const purged = await runRecordingRetention(h.db, { storage });
  assert.ok(purged.includes(oldSigned));
  assert.ok(!purged.includes(oldUnsigned)); // its note isn't signed yet
  assert.ok(!purged.includes(fresh));
  for (const k of keys) assert.ok(removed.includes(k));
  const row = await h.db.get('SELECT status, transcript_key, draft, purged_at FROM recording_sessions WHERE id = ?', oldSigned);
  assert.deepEqual([row.status, row.transcript_key, row.draft, !!row.purged_at], ['purged', null, null, true]);
  const a = await h.db.get("SELECT source, reason, patient_id FROM audit_log WHERE action = 'recording.purged' AND entity_id = ?", oldSigned);
  assert.equal(a.source, 'automation');
  assert.match(a.reason, /30 days/);
  assert.equal(a.patient_id, s.patient.id);
  assert.equal((await api('GET', `/long-recordings/${oldSigned}/transcript`)).status, 410);
  assert.equal((await api('GET', `/long-recordings/${oldSigned}/audio/0`)).status, 410);
  assert.equal((await h.db.get('SELECT body FROM clinical_notes WHERE id = ?', signedNote.id)).body, 'Exam from recording.');
  // Running it again does nothing more.
  assert.deepEqual((await runRecordingRetention(h.db, { storage })).filter((id) => id === oldSigned), []);

  // The patient withdraws consent: removed now, with the reason.
  assert.equal((await api('POST', `/long-recordings/${fresh}/discard`, {})).status, 400);
  const gone = await api('POST', `/long-recordings/${fresh}/discard`, { reason: 'Patient withdrew consent' });
  assert.equal(gone.data.status, 'discarded');
  assert.equal((await h.db.get("SELECT reason FROM audit_log WHERE action = 'recording.discarded' AND entity_id = ?", fresh)).reason, 'Patient withdrew consent');
});
