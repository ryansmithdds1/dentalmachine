// Spoken perio charting: what the recognizer heard, turned into readings and commands.
// "3 2 3 4 bleeding 5 3" → depths 3,2,3,4 (bleeding on the 4), 5, 3. Speech engines hear numbers as
// words or homophones ("to", "for", "ate"), so those count too.
const WORDS = {
  zero: 0, oh: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, tree: 3, free: 3, four: 4, for: 4, fore: 4, five: 5, six: 6, sicks: 6,
  seven: 7, eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
};
const COMMANDS = [
  [/^(bleeding|bleed|blood|bop)$/, 'bop'], [/^(pus|suppuration|suppurating|sup)$/, 'sup'], [/^plaque$/, 'plaque'],
  [/^(skip|pass)$/, 'skip'], [/^(back|undo|previous|oops)$/, 'back'], [/^missing$/, 'missing'], [/^(stop|done|finish|finished)$/, 'stop'],
];
const SIDE = { buccal: 'b', facial: 'b', lingual: 'l', palatal: 'l' };
const number = (w) => (/^\d+$/.test(w) ? Number(w) : w in WORDS ? WORDS[w] : null);

// Tokens: { n } a reading; { cmd } a command. Commands that take a place: { cmd: 'tooth', n } ("tooth 14",
// "number 14", "go to 14"), { cmd: 'side', side: 'b' | 'l' } ("lingual"), { cmd: 'row', row: 'pd' | 'gm' }
// ("margins", "recession", "depths"). "Bleeding all" marks the whole tooth just charted.
export function parseSpeech(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if (w === 'next' && next === 'tooth') { out.push({ cmd: 'next_tooth' }); i++; continue; }
    if (w === 'next') { out.push({ cmd: 'skip' }); continue; }
    // A tooth to go to: "tooth 14", "number fourteen", "go to 3" (not "tooth" followed by a reading list).
    if ((w === 'tooth' || w === 'number' || (w === 'go' && next === 'to')) && words[i + (w === 'go' ? 2 : 1)] != null) {
      const at = i + (w === 'go' ? 2 : 1);
      const t = number(words[at]);
      if (t >= 1 && t <= 32) { out.push({ cmd: 'tooth', n: t }); i = at; continue; }
    }
    if (w in SIDE) { out.push({ cmd: 'side', side: SIDE[w] }); continue; }
    if (/^(depths?|pockets?|probing)$/.test(w)) { out.push({ cmd: 'row', row: 'pd' }); continue; }
    if (/^(margins?|recession|gm)$/.test(w) || (w === 'gingival' && /^margins?$/.test(next || ''))) {
      out.push({ cmd: 'row', row: 'gm' });
      if (w === 'gingival') i++;
      continue;
    }
    // Gingival margin above the CEJ: "minus 2", "negative two".
    if ((w === 'minus' || w === 'negative') && number(next ?? '') != null) { out.push({ n: -Math.min(number(next), 9) }); i++; continue; }
    if (/^\d+$/.test(w)) {
      // "323" said quickly comes back as one number: three readings, unless it's 10–15.
      const n = Number(w);
      if (n >= 10 && n <= 15) out.push({ n });
      else for (const d of w) out.push({ n: Number(d) });
      continue;
    }
    if (w in WORDS) { out.push({ n: WORDS[w] }); continue; }
    const hit = COMMANDS.find(([re]) => re.test(w));
    if (hit) {
      if (hit[1] === 'bop' && (next === 'all' || next === 'everywhere')) { out.push({ cmd: 'bop_all' }); i++; continue; }
      out.push({ cmd: hit[1] });
    } else if (w === 'all' && /^(bleeding|bleed)$/.test(next || '')) { out.push({ cmd: 'bop_all' }); i++; }
  }
  return out;
}

export const speechSupported = () => typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
