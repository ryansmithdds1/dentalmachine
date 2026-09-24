// Sandbox peers (demos and tests): 48 made-up practices with plausible numbers, so a practice that joins in
// sandbox mode sees percentiles, peer groups and leaderboards straight away. Every one is marked synthetic (the
// leaderboard labels them "sample"), and the numbers come from a fixed seed, so tests see the same peers each time.
// Nothing here is real data; in production (BENCHMARK_URL set) none of it exists.
import { createHash } from 'node:crypto';
import { ensureServiceSchema } from './service.js';
import { PRACTICE_TYPES, REGIONS, SIZE_BANDS, PAYER_MIX, YEARS_BANDS } from './catalog.js';

export const SANDBOX_PRACTICES = 48;
const hex = (s, n) => createHash('sha256').update(s).digest('hex').slice(0, n);

// mulberry32: small, fast, deterministic.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const pick = (r, list, weights) => {
  const total = weights.reduce((s, w) => s + w, 0);
  let x = r() * total;
  for (let i = 0; i < list.length; i++) if ((x -= weights[i]) < 0) return list[i];
  return list.at(-1);
};
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const dollars = (x) => Math.max(0, Math.round(x) * 100);
const pct = (x) => Math.round(clamp(x, 0, 100) * 10) / 10;
const NAMED = ['Dr. Maya Chen', 'Dr. Sam Ortiz', 'Dr. Priya Nair', 'Dr. Leo Brandt', 'Dr. Ana Ruiz', 'Dr. Tom Walsh'];

export function sandboxPractices() {
  const r = rng(4821);
  const out = [];
  for (let i = 0; i < SANDBOX_PRACTICES; i++) {
    const practice = {
      participant_id: `bp_${hex(`sandbox-practice-${i}`, 24)}`,
      practice_type: pick(r, Object.keys(PRACTICE_TYPES), [70, 8, 5, 5, 3, 3, 2, 4]),
      region: pick(r, Object.keys(REGIONS).filter((k) => k !== 'other'), [22, 24, 32, 22]),
      size_band: pick(r, Object.keys(SIZE_BANDS), [35, 40, 18, 7]),
      payer_mix: pick(r, Object.keys(PAYER_MIX), [55, 32, 13]),
      years_band: pick(r, Object.keys(YEARS_BANDS).filter((k) => k !== 'unknown'), [20, 45, 35]),
      skill: normal(r),
      people: [],
    };
    const dentists = { solo: 1, small: 2, medium: 4, large: 7 }[practice.size_band];
    for (let d = 0; d < dentists + Math.max(1, Math.round(dentists * 1.2)); d++) {
      const role = d < dentists ? 'dentist' : 'hygienist';
      practice.people.push({
        role, provider_key: `k_${hex(`sandbox-${i}-${d}`, 16)}`, anon_code: String(1000 + Math.floor(r() * 9000)),
        display_name: role === 'dentist' && d === 0 && i % 8 === 0 ? NAMED[(i / 8) % NAMED.length] : null,
        skill: 0.6 * practice.skill + 0.8 * normal(r),
      });
    }
    out.push(practice);
  }
  return out;
}

// One month of rows for one sandbox practice. Skill drives the related numbers together, so "what top performers
// do differently" has something real to find; each month adds a little noise.
function monthRows(p, month) {
  const r = rng(parseInt(hex(`${p.participant_id}-${month}`, 8), 16));
  const rows = [];
  const add = (who, metric, value, n) => rows.push({ provider_key: who.provider_key, role: who.role, anon_code: who.anon_code, display_name: who.display_name, metric, value, n });
  for (const who of p.people) {
    const s = who.skill + 0.35 * normal(r);
    const v = (mean, sd) => mean + sd * s + sd * 0.4 * normal(r);
    if (who.role === 'dentist') {
      add(who, 'dx_per_exam_new_patient', dollars(v(1100, 330)), 8 + Math.floor(r() * 30));
      add(who, 'dx_per_exam_recall', dollars(v(300, 110)), 40 + Math.floor(r() * 120));
      add(who, 'dx_per_exam_emergency', dollars(v(650, 220)), 5 + Math.floor(r() * 25));
      add(who, 'exam_value_1m', dollars(v(180, 60)), 200);
      add(who, 'exam_value_3m', dollars(v(260, 80)), 200);
      add(who, 'exam_value_5m', dollars(v(320, 95)), 200);
      const presented = clamp(v(80, 9), 30, 100);
      const accepted = clamp(presented * clamp(v(0.68, 0.1), 0.2, 1), 0, presented);
      const scheduled = clamp(accepted * clamp(v(0.8, 0.08), 0.3, 1), 0, accepted);
      const completed = clamp(scheduled * clamp(v(0.78, 0.08), 0.3, 1), 0, scheduled);
      add(who, 'conv_presented', pct(presented), 60);
      add(who, 'conv_accepted', pct(accepted), 60);
      add(who, 'conv_scheduled', pct(scheduled), 60);
      add(who, 'conv_completed', pct(completed), 60);
      add(who, 'case_acceptance', pct(v(55, 11)), 25);
      add(who, 'production_per_hour', dollars(v(650, 170)), 120);
      add(who, 'broken_rate', pct(clamp(11 - 3.5 * s + 1.5 * normal(r), 2, 30)), 300);
      add(who, 'schedule_fill', pct(v(84, 8)), 140);
    } else {
      add(who, 'dx_per_exam_recall', dollars(v(260, 90)), 60 + Math.floor(r() * 120));
      add(who, 'production_per_hour', dollars(v(190, 42)), 130);
      add(who, 'hygiene_reappointment', pct(v(82, 8)), 150);
      add(who, 'perio_pct', pct(v(28, 9)), 150);
      add(who, 'broken_rate', pct(clamp(12 - 3.5 * s + 1.5 * normal(r), 2, 30)), 300);
      add(who, 'schedule_fill', pct(v(86, 7)), 140);
    }
  }
  const practice = { role: 'practice', provider_key: `k_${hex(`sandbox-${p.participant_id}-practice`, 16)}`, anon_code: String(1000 + (parseInt(hex(p.participant_id, 4), 16) % 9000)), display_name: null };
  const s = p.skill + 0.3 * normal(r);
  const size = { solo: 1, small: 2.2, medium: 4.5, large: 8 }[p.size_band];
  add(practice, 'new_patients', Math.max(1, Math.round((24 + 8 * s + 6 * normal(r)) * size)), null);
  add(practice, 'collection_rate', pct(clamp(97 + 2 * s + 1.5 * normal(r), 80, 110)), null);
  add(practice, 'case_acceptance', pct(55 + 10 * s + 4 * normal(r)), 60);
  add(practice, 'broken_rate', pct(clamp(11 - 3 * s + 1.5 * normal(r), 2, 30)), 900);
  add(practice, 'reappointment_pct', pct(78 + 8 * s + 4 * normal(r)), 400);
  add(practice, 'recall_current', pct(64 + 10 * s + 5 * normal(r)), 1500);
  if (r() < 0.6) add(practice, 'labor_pct', pct(clamp(27 - 3 * s + 2 * normal(r), 15, 45)), null);
  return rows;
}

const shiftMonth = (m, k) => {
  const [y, mo] = m.split('-').map(Number);
  const i = y * 12 + (mo - 1) + k;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};

// Makes sure the sandbox peers exist, with rows for the month of `today` and the two before. Safe to call often.
export async function ensureSandboxPeers(db, today) {
  await ensureServiceSchema(db);
  const month = String(today).slice(0, 7);
  const months = [shiftMonth(month, -2), shiftMonth(month, -1), month];
  const practices = sandboxPractices();
  const have = await db.get('SELECT COUNT(*) AS n FROM bms_participants WHERE synthetic = 1');
  if (Number(have.n) < practices.length) {
    for (const p of practices) {
      const exists = await db.get('SELECT 1 AS x FROM bms_participants WHERE participant_id = ?', p.participant_id);
      if (!exists) {
        await db.run('INSERT INTO bms_participants (participant_id, public_key, practice_type, region, size_band, payer_mix, years_band, synthetic) VALUES (?, NULL, ?, ?, ?, ?, ?, 1) ON CONFLICT (participant_id) DO NOTHING',
          p.participant_id, p.practice_type, p.region, p.size_band, p.payer_mix, p.years_band);
      }
    }
  }
  for (const m of months) {
    const seeded = await db.get('SELECT COUNT(*) AS n FROM bms_rows r JOIN bms_participants p ON p.participant_id = r.participant_id WHERE p.synthetic = 1 AND r.month = ?', m);
    if (Number(seeded.n) > 0) continue;
    try {
      await db.tx(async () => {
        for (const p of practices) {
          for (const row of monthRows(p, m)) {
            await db.run('INSERT INTO bms_rows (participant_id, month, provider_key, role, anon_code, display_name, metric, value, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              p.participant_id, m, row.provider_key, row.role, row.anon_code, row.display_name, row.metric, row.value, row.n);
          }
        }
      });
    } catch (err) {
      // Two requests seeding the same month at once: the other one won, which is all we wanted.
      const now = await db.get('SELECT COUNT(*) AS n FROM bms_rows r JOIN bms_participants p ON p.participant_id = r.participant_id WHERE p.synthetic = 1 AND r.month = ?', m);
      if (!Number(now.n)) throw err;
    }
  }
}
