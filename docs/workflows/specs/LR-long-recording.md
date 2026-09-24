# LR · Long recordings: a whole exam into the note (LR1–LR3)

**Budget: 4 actions** from the patient's Clinical notes tab: tick "Patient agreed to recording" → Start → Stop and
write the note → Save & sign (plus a tick for each suggested code to chart). Server: `server/src/longrecording.js`,
`server/src/routes/longrecording.js`. Screen: `client/src/components/patient/LongRecorder.jsx` (+ `recordingQueue.js`).
Tests: `server/test/longrecording.test.js`.

## Recording (LR1)
- Any computer, phone or iPad browser with a microphone (MediaRecorder). The recorder restarts every 30 seconds, so
  each **part is a complete audio file**; parts are saved on the device (IndexedDB) first and removed only when the
  server has confirmed them. Upload retries with backoff (1s → 30s) and resumes when the connection returns.
- `PUT /long-recordings/:id/chunks/:n` is idempotent: the same part again is accepted as a duplicate; the same
  number with different audio is refused (409); parts can arrive in any order; an optional SHA-256 header catches
  damage. `GET /long-recordings/:id` lists received and missing parts so a reloaded page finishes the job ("A
  recording from … wasn't finished on this device — Upload and finish").
- Start needs **"Patient agreed to recording"** ticked; the agreement (who, when) is stored on the session and
  audited. The browser names the session (`client_id`), so a retried start doesn't make two.
- Clear indicator: pulsing red "Recording 1:02:14", "● REC" in the tab title, leaving the page asks first; Pause /
  Resume (each noted on the session); a count of parts still waiting to upload.
- Finish (`POST …/finish`) refuses while any part is missing and says which.

## Transcription and draft (LR2)
- Each part goes to the transcription adapter on its own (Deepgram medical model with speaker separation and dental
  key terms; sandbox in tests; a dictation-only adapter works without speaker separation). Results are merged on the
  visit's clock into numbered lines (`L12 [03:40] Doctor: …`). Speakers are named by what they say; when the
  service didn't separate voices, each line's speaker is marked as a guess.
- The draft: the office's note template(s) for the visit's and heard work (merge fields filled, `[[questions]]`
  answered from what was said), then sections — findings by tooth, periodontal readings, treatment discussed,
  options and the patient's decision, consent / informed refusal, anesthetic, materials, post-op — **each item with
  the transcript line(s) it came from**, plus "not heard, so not in the note".
- Long visits: with AI on, the transcript is read in windows of ~20,000 characters and the items merged; otherwise
  the rules draft reads every line.
- Suggested charting and codes (done today / plan), each with its lines, are **unticked**; the clinician ticks what's
  right and the screen posts them as that person. Nothing is charted, saved or signed by the AI (rule 10);
  `note.ai_draft_approved` records the approver and what they accepted.

## Storage, retention, failures (LR3)
- Audio parts, per-part transcripts and the transcript are encrypted in storage like documents.
- Reading the transcript, playing a part, downloading (zip of parts + transcript) and opening the draft are audited.
- Retention per practice (`practices.recording_retention_days`, default 90, administrators, audited). The recording
  job (hourly) removes audio and transcript after that (kept longer while the note made from it is unsigned); the rows stay
  as the record, the removal is audited (`recording.purged`, automation), and the signed note is never touched.
  "Remove" on a recording does the same immediately with a reason (patient withdrew consent).
- A failed transcription marks the recording failed, schedules a retry (5, 15, 45 … minutes, 5 attempts) and puts
  it in **Needs attention** (one item per recording, counted up); a later success resolves it. "Retry" is on the
  recording in the notes tab.

## Edge cases
| Case | Behaviour |
|---|---|
| Connection drops mid-visit | recording continues; parts wait on the device and upload when it's back |
| Browser closed | parts already made are on the device; next visit to the patient's notes offers "Upload and finish" |
| Same part sent twice | 200 duplicate, stored once |
| Part sent after finishing | 409 |
| No transcription service | the recorder isn't shown; `POST /long-recordings` answers 409 |
| Recording never finished | removed after the retention period like the rest |
