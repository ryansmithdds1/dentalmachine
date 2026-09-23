// Spoken perio charting: what the recognizer heard, turned into readings and commands.
// "3 2 3 4 bleeding 5 3" → depths 3,2,3,4 (bleeding on the 4), 5, 3. Speech engines hear numbers as
// words or homophones ("to", "for", "ate"), so those count too.
const WORDS = {
  zero: 0, oh: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, tree: 3, free: 3, four: 4, for: 4, fore: 4, five: 5, six: 6, sicks: 6,
  seven: 7, eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
};
const COMMANDS = [
  [/^(bleeding|bleed|blood|bop)$/, 'bop'], [/^(pus|suppuration|suppurating|sup)$/, 'sup'], [/^plaque$/, 'plaque'],
  [/^(skip|next|pass)$/, 'skip'], [/^(back|undo|previous|oops)$/, 'back'], [/^missing$/, 'missing'], [/^(stop|done|finish|finished)$/, 'stop'],
];

export function parseSpeech(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === 'next' && words[i + 1] === 'tooth') { out.push({ cmd: 'next_tooth' }); i++; continue; }
    if (/^\d+$/.test(w)) {
      // "323" said quickly comes back as one number: three readings, unless it's 10–15.
      const n = Number(w);
      if (n >= 10 && n <= 15) out.push({ n });
      else for (const d of w) out.push({ n: Number(d) });
      continue;
    }
    if (w in WORDS) { out.push({ n: WORDS[w] }); continue; }
    const hit = COMMANDS.find(([re]) => re.test(w));
    if (hit) out.push({ cmd: hit[1] });
  }
  return out;
}

export const speechSupported = () => typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
