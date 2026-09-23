// Short, quiet sounds instead of a talking assistant: listening, done, needs a yes, didn't work.
let ctx = null;
const TONES = {
  listen: [[880, 0.06]],
  stop: [[660, 0.05]],
  done: [[660, 0.07], [990, 0.09]],
  ask: [[740, 0.08], [740, 0.08]],
  error: [[330, 0.14]],
};
export function chime(kind) {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    let t = ctx.currentTime;
    for (const [freq, len] of TONES[kind] || []) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + len + 0.02);
      t += len + 0.03;
    }
  } catch {
    /* no audio: the on-screen messages still say what happened */
  }
}
