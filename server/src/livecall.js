// Live transcription of a call while it's happening (PH6): the phone provider transcribes both sides in real time
// and posts each phrase (partial and final) to us; the call screen filters its "Next openings" as the caller talks.
// Behind this adapter so the vendor can change:
//   LIVE_TRANSCRIPTION=twilio   Twilio Real-Time Transcription: <Start><Transcription> in the call's TwiML; Twilio posts
//                               phrases to /api/webhooks/twilio/voice/transcription (signed like every Twilio webhook).
//                               Nothing is fetched from here, so there is no outside call to log; the audio goes to
//                               Twilio's transcription engine under the practice's Twilio BAA (docs/HIPAA-vendors.md).
//   LIVE_TRANSCRIPTION=sandbox  No provider: staff screens (and tests) play scripted phrases through the same path.
//   unset                       Off: the call screen shows its quick filter row (day chips, AM/PM, provider) instead.
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

// A caller asking for a time, phrase by phrase (what the sandbox plays when no script is given).
export const SANDBOX_SCRIPT = [
  { track: 'office', text: 'Thank you for calling, this is the front desk. How can I help?' },
  { track: 'caller', text: 'Hi, I need to come in for a cleaning.' },
  { track: 'caller', text: 'Do you have anything Thursday afternoon?' },
];

// Twilio's transcription callback: TranscriptionEvent, TranscriptionData ({"transcript": …}), Final, Track, SequenceId.
export function parseTwilioTranscription(body = {}) {
  if (body.TranscriptionEvent && body.TranscriptionEvent !== 'transcription-content') return null;
  let text = '';
  try { text = JSON.parse(body.TranscriptionData || '{}').transcript || ''; } catch { text = ''; }
  if (!text.trim()) return null;
  return {
    track: body.Track === 'outbound_track' ? 'office' : 'caller', // inbound_track: the audio coming in from the caller
    text: text.trim(), final: String(body.Final) === 'true', seq: body.SequenceId != null && String(body.Final) === 'true' ? Number(body.SequenceId) : null,
  };
}

export function createLiveTranscription({ config = {} } = {}) {
  const mode = config.liveTranscription ?? process.env.LIVE_TRANSCRIPTION ?? null;
  if (mode === 'twilio') {
    return {
      mode, label: 'Twilio real-time transcription', realtime: true,
      // Goes before the <Dial>: both sides, with partial results so the screen reacts mid-sentence.
      twiml: (callbackUrl) => `<Start><Transcription statusCallbackUrl="${xml(callbackUrl)}" track="both_tracks" partialResults="true" languageCode="en-US"/></Start>`,
      parse: parseTwilioTranscription,
      sandbox: false,
    };
  }
  if (mode === 'sandbox') {
    return { mode, label: 'Sandbox (scripted phrases)', realtime: true, twiml: () => '', parse: parseTwilioTranscription, sandbox: true, script: SANDBOX_SCRIPT };
  }
  return null;
}

// Plays phrases into the call as a provider would: each phrase first as growing partials (word by word), then final.
// `hear` is phonecoach.hearSpeech bound to the call. delayMs 0 plays it all at once (tests).
export async function playScript(hear, script, { delayMs = 0 } = {}) {
  const wait = () => (delayMs ? new Promise((r) => setTimeout(r, delayMs)) : null);
  for (const line of script) {
    const words = String(line.text || '').split(/\s+/).filter(Boolean);
    if (line.track === 'caller' && delayMs) {
      for (let i = 1; i < words.length; i++) {
        await hear({ track: 'caller', text: words.slice(0, i).join(' '), final: false });
        await wait();
      }
    }
    await hear({ track: line.track === 'office' ? 'office' : 'caller', text: words.join(' '), final: true });
    await wait();
  }
}
