import { HttpError } from './auth.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { insert, practiceNow, localNow } from './util.js';
import { build270, parse271, x12Type } from './x12.js';
import { benefitsUsed } from './services.js';
import { DEFAULT_FREQUENCIES } from './benefits.js';

// Eligibility (270/271): one policy on demand, or a whole day's patients — the office runs tomorrow's list,
// and it runs by itself each evening when a real-time clearinghouse is connected.
export function createEligibility({ db, config = {}, clearinghouse: ch = null }) {
  const ids = (practice) => ({
    senderId: config.ediSubmitterId || String(practice.tax_id || '').replace(/\D/g, '') || `DM${practice.id}`,
    receiverId: config.ediReceiverId || 'CLEARINGHOUSE',
  });
  const automatic = !!(ch?.realtime || config.ediMode === 'sandbox' || ch?.mode === 'sandbox');

  async function sandbox271(policy, patient, trace) {
    const used = await benefitsUsed(db, policy);
    // The patient's last cleaning and bitewings here, as a payer would report them from its claims.
    const last = async (codes) => (await db.get(
      `SELECT MAX(substr(completed_at, 1, 10)) AS d FROM procedures WHERE patient_id = ? AND status = 'completed' AND code IN (${codes.map(() => '?').join(',')})`, patient.id, ...codes,
    ))?.d;
    const [prophy, bw] = [await last(['D1110', 'D1120']), await last(['D0272', 'D0274'])];
    const pct = (v) => (1 - v / 100).toFixed(2);
    return [
      'ISA*00*          *00*          *ZZ*SANDBOX        *ZZ*DENTALMACHINE  *000101*0000*^*00501*000000001*0*T*:',
      'GS*HB*SANDBOX*DENTALMACHINE*20000101*0000*1*X*005010X279A1', 'ST*271*0001*005010X279A1', `BHT*0022*11*${trace}*20000101*0000`,
      'HL*1**20*1', 'NM1*PR*2*SANDBOX PAYER*****PI*00000', 'HL*2*1*21*1', 'NM1*1P*2*PROVIDER', 'HL*3*2*22*0',
      `NM1*IL*1*${patient.last_name.toUpperCase()}*${patient.first_name.toUpperCase()}****MI*${policy.subscriber_id}`,
      `DTP*346*D8*${new Date().getUTCFullYear()}0101`,
      'EB*1*IND*35**DENTAL PPO',
      `EB*C*IND*35***23*${(policy.deductible / 100).toFixed(2)}`,
      `EB*C*IND*35***29*${(Math.max(0, policy.deductible - policy.deductible_met) / 100).toFixed(2)}`,
      `EB*F*IND*35***23*${(policy.annual_max / 100).toFixed(2)}`,
      `EB*F*IND*35***29*${(Math.max(0, policy.annual_max - used) / 100).toFixed(2)}`,
      `EB*A*IND*23^41*****${pct(policy.pct_preventive)}`,
      `EB*A*IND*25^26^24^40*****${pct(policy.pct_basic)}`,
      `EB*A*IND*36^39*****${pct(policy.pct_major)}`,
      `EB*C*FAM*35***23*${((policy.deductible * 3) / 100).toFixed(2)}`,
      `EB*C*FAM*35***29*${(Math.max(0, policy.deductible * 3 - policy.deductible_met) / 100).toFixed(2)}`,
      'EB*F*IND*38***32*1500.00', 'EB*F*IND*38***33*1500.00',
      `EB*C*IND*35***23*${((policy.deductible * 2) / 100).toFixed(2)}*****N`,
      `EB*F*IND*35***23*${((policy.annual_max * 0.75) / 100).toFixed(2)}*****N`,
      `EB*A*IND*23^41*****${pct(Math.max(0, policy.pct_preventive - 20))}****N`,
      `EB*A*IND*25^26^24^40*****${pct(Math.max(0, policy.pct_basic - 20))}****N`,
      `EB*A*IND*36^39*****${pct(Math.max(0, policy.pct_major - 20))}****N`,
      'EB*F*IND*41**********AD:D1110', 'HSD*VS*2***22', ...(prophy ? [`DTP*304*D8*${prophy.replace(/-/g, '')}`] : []),
      'EB*F*IND*41**********AD:D0274', 'HSD*VS*1***34*12', ...(bw ? [`DTP*304*D8*${bw.replace(/-/g, '')}`] : []),
      'EB*F*IND*41**********AD:D0330', 'HSD*VS*1***21*5',
      'MSG*SANDBOX RESPONSE - NOT FROM A REAL PAYER', 'SE*20*0001', 'GE*1*1', 'IEA*1*000000001',
    ].join('~') + '~';
  }

  // Checks one policy. Without a real-time connection the 270 is kept for manual upload and the check stays pending.
  async function check(policy, { userId = null } = {}) {
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', policy.patient_id);
    const carrier = await db.get('SELECT * FROM insurance_carriers WHERE id = ?', policy.carrier_id);
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', policy.practice_id);
    const trace = `EL${Date.now()}`;
    const request = build270({ practice, patient, policy, carrier, ...ids(practice), control: (Date.now() % 1_000_000_000) || 1, trace });
    let row = { practice_id: policy.practice_id, patient_id: patient.id, patient_insurance_id: policy.id, request_x12: request, created_by: userId, status: 'pending' };
    if (automatic) {
      const live = !!ch?.realtime;
      const response = live ? await ch.realtime.eligibility(request) : await sandbox271(policy, patient, trace);
      let summary;
      try {
        summary = parse271(response);
      } catch {
        throw new HttpError(502, `The clearinghouse answered with a ${x12Type(response) || 'non-X12'} instead of an eligibility response (271)`);
      }
      row = { ...row, response_x12: response, summary: JSON.stringify({ ...summary, ...(live ? {} : { sandbox: true }) }), status: summary.errors.length ? 'error' : summary.active ? 'active' : 'inactive' };
    }
    const id = await insert(db, 'eligibility_checks', row);
    return { id, status: row.status, mode: ch?.realtime ? 'realtime' : row.response_x12 ? 'sandbox' : 'manual' };
  }

  // A day's booked patients with their primary policy and latest check.
  async function forDay(practiceId, date) {
    return await db.all(
      `SELECT a.id AS appointment_id, a.start_time, a.patient_id, p.first_name, p.last_name, pi.id AS policy_id, c.name AS carrier_name, pi.subscriber_id,
         e.id AS check_id, e.status, e.summary, e.created_at AS checked_at
       FROM appointments a JOIN patients p ON p.id = a.patient_id
       LEFT JOIN patient_insurance pi ON pi.id = (SELECT x.id FROM patient_insurance x WHERE x.patient_id = a.patient_id AND x.active = 1 ORDER BY CASE x.priority WHEN 'primary' THEN 0 ELSE 1 END, x.id LIMIT 1)
       LEFT JOIN insurance_carriers c ON c.id = pi.carrier_id
       LEFT JOIN eligibility_checks e ON e.id = (SELECT MAX(y.id) FROM eligibility_checks y WHERE y.patient_insurance_id = pi.id)
       WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status NOT IN ('cancelled','no_show')
       ORDER BY a.start_time`, practiceId, `${date} 00:00`, `${date} 24:00`,
    );
  }

  // Checks everyone on the day whose insurance wasn't checked in the last maxAgeDays. One failure doesn't stop the rest.
  async function batch(practiceId, date, { userId = null, maxAgeDays = 7 } = {}) {
    const since = new Date(Date.now() - maxAgeDays * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const rows = await forDay(practiceId, date);
    const seen = new Set();
    const out = { date, checked: 0, skipped: 0, failed: [], results: [] };
    for (const r of rows) {
      if (!r.policy_id || seen.has(r.policy_id)) continue;
      seen.add(r.policy_id);
      if (r.checked_at && r.checked_at >= since && r.status !== 'pending') { out.skipped++; continue; }
      try {
        const done = await check(await db.get('SELECT * FROM patient_insurance WHERE id = ?', r.policy_id), { userId });
        out.checked++;
        out.results.push({ patient_id: r.patient_id, status: done.status });
      } catch (err) {
        out.failed.push({ patient_id: r.patient_id, error: err.message });
      }
    }
    return out;
  }

  return { automatic, check, forDay, batch };
}

// Nightly: after 5pm practice time, check tomorrow's patients once.
export async function runEligibilityBatches(db, eligibility, now = new Date()) {
  if (!eligibility.automatic) return [];
  const done = [];
  for (const p of await db.all('SELECT id, timezone, eligibility_batch_date FROM practices')) {
    const local = localNow(p.timezone, now);
    if (Number(local.slice(11, 13)) < 17) continue;
    const tomorrow = new Date(Date.parse(`${local.slice(0, 10)}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
    if (p.eligibility_batch_date === tomorrow) continue;
    await db.run('UPDATE practices SET eligibility_batch_date = ? WHERE id = ?', tomorrow, p.id);
    const out = await eligibility.batch(p.id, tomorrow);
    done.push({ practice_id: p.id, ...out });
    // Patients whose insurance couldn't be checked are one item for the front desk, not a log line.
    const key = `eligibility:${tomorrow}`;
    if (out.failed.length) {
      await raiseIssue(db, {
        practiceId: p.id, kind: 'eligibility', key, role: 'front_desk',
        title: `Insurance couldn't be checked for ${out.failed.length} patient${out.failed.length === 1 ? '' : 's'} on ${tomorrow}`,
        detail: [...new Set(out.failed.map((f) => f.error))].slice(0, 5).join('; '),
      });
    } else await resolveIssue(db, p.id, key);
  }
  return done;
}

// Frequency limits from a 271 replace the plan's rule for the same procedures (or are added).
export function mergeFrequencies(current, fromPayer) {
  const list = (current || DEFAULT_FREQUENCIES).map((f) => ({ ...f }));
  for (const f of fromPayer || []) {
    const i = list.findIndex((x) => x.codes.some((c) => f.codes.some((code) => code.startsWith(c))));
    const rule = { count: f.count, ...(f.months ? { months: f.months } : { per: 'benefit_year' }) };
    if (i >= 0) {
      const { months: _m, per: _p, ...rest } = list[i];
      list[i] = { ...rest, ...rule };
    } else list.push({ label: f.codes.join(', '), codes: f.codes, ...rule });
  }
  return list;
}
