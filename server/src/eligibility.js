import { HttpError } from './auth.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { insert, practiceNow, localNow, audit } from './util.js';
import { withActor, currentActor } from './actor.js';
import { build270, parse271, x12Type } from './x12.js';
import { benefitsUsed, benefitYear } from './services.js';
import { DEFAULT_FREQUENCIES, savePolicy, withPlan } from './benefits.js';
import { planIdentity, evidenceOf, recordElectronicBreakdown } from './planverify.js';

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
    // The training patient (training.js) is answered by the built-in simulated payer, whatever is connected: nothing
    // about it goes to the clearinghouse.
    if (automatic || patient.is_training) {
      const live = !!ch?.realtime && !patient.is_training;
      const response = live ? await ch.realtime.eligibility(request) : await sandbox271(policy, patient, trace);
      let summary;
      try {
        summary = parse271(response);
      } catch {
        throw new HttpError(502, `The clearinghouse answered with a ${x12Type(response) || 'non-X12'} instead of an eligibility response (271)`);
      }
      row = { ...row, response_x12: response, summary: JSON.stringify({ ...summary, ...(live ? {} : { sandbox: true }), ...(patient.is_training ? { training: true } : {}) }), status: summary.errors.length ? 'error' : summary.active ? 'active' : 'inactive' };
    }
    const id = await insert(db, 'eligibility_checks', row);
    const mode = ch?.realtime && !patient.is_training ? 'realtime' : row.response_x12 ? 'sandbox' : 'manual';
    const settled = row.response_x12 ? await settle(id, { source: live(mode) }) : null;
    return { id, status: row.status, mode, ...(settled || {}) };
  }
  const live = (mode) => (mode === 'sandbox' ? 'automation' : 'integration');

  // Copies a response's benefits onto the policy (and its plan) so estimates use them. What "Apply to policy"
  // has always applied: max, deductible, deductible met this benefit year, percentages and frequency limits.
  async function apply(checkId) {
    const e = await db.get('SELECT * FROM eligibility_checks WHERE id = ?', checkId);
    const s = e?.summary && JSON.parse(e.summary);
    if (!s) throw new HttpError(409, 'No response to apply yet');
    const policy = await db.get('SELECT * FROM patient_insurance WHERE id = ?', e.patient_insurance_id);
    const row = {};
    if (s.annual_max != null) row.annual_max = s.annual_max;
    if (s.deductible != null) row.deductible = s.deductible;
    if (s.deductible != null && s.deductible_remaining != null) row.deductible_met = Math.max(0, s.deductible - s.deductible_remaining);
    for (const tier of ['preventive', 'basic', 'major']) if (s.coinsurance?.[tier] != null) row[`pct_${tier}`] = s.coinsurance[tier];
    const { plan } = await withPlan(db, policy);
    if (s.frequencies?.length) row.frequencies = mergeFrequencies(plan.frequencies ? JSON.parse(plan.frequencies) : null, s.frequencies);
    if (row.deductible_met != null) row.deductible_year = benefitYear(policy, (await practiceNow(db, e.practice_id)).slice(0, 10)).start;
    const before = pickFields(policy, row);
    // Plan-wide numbers (max, deductible, percentages) update the shared plan; the deductible met is this patient's.
    await db.tx(async () => {
      await savePolicy(db, e.practice_id, policy.id, row);
      await db.run("UPDATE insurance_plans SET verified_at = datetime('now'), verified_source = 'eligibility' WHERE id = ?", plan.id);
    });
    const after = pickFields(await db.get('SELECT * FROM patient_insurance WHERE id = ?', policy.id), row);
    // The rest of the breakdown the payer sent (per-category percentages, waiting periods, ortho, clauses, the
    // patient's used and remaining amounts) and the verification record — planverify.js. A person pressing
    // "Apply" has decided past the plan-identity guard; the automatic path hasn't.
    const breakdown = await recordElectronicBreakdown(db, e, { sandbox: !!s.sandbox, force: currentActor()?.source === 'human' });
    return { check: e, summary: s, policy, fields: Object.keys(row), before, after, breakdown };
  }

  // A response that came back: applied to the policy on its own when it's clean; anything that needs a
  // person (coverage not active, a payer error, numbers that disagree with a verified plan) goes to
  // Needs attention instead, and nothing is changed.
  async function settle(checkId, { source = 'integration' } = {}) {
    const e = await db.get('SELECT * FROM eligibility_checks WHERE id = ?', checkId);
    const s = e?.summary && JSON.parse(e.summary);
    if (!s) return null;
    const policy = await db.get('SELECT * FROM patient_insurance WHERE id = ?', e.patient_insurance_id);
    const { plan } = await withPlan(db, policy);
    const today = (await practiceNow(db, e.practice_id)).slice(0, 10);
    const reasons = eligibilityProblems(s, { plan, today });
    // Plan-wide numbers change everyone on the plan, so only when the plan on file is certainly this patient's.
    if (!reasons.length) {
      const identity = await planIdentity(db, policy, evidenceOf(e));
      if (!identity.ok) reasons.push(...identity.reasons.map((r) => `the plan on file may not be theirs: ${r}`));
    }
    const key = `eligibility-review:${policy.id}`;
    const patient = await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', e.patient_id);
    if (reasons.length) {
      await saveSummary(e.id, { ...s, review: { reasons, at: new Date().toISOString() } });
      await raiseIssue(db, {
        practiceId: e.practice_id, kind: 'eligibility', key, role: 'front_desk', entity: 'patient_insurance', entityId: policy.id, patientId: e.patient_id,
        title: `Insurance needs a look: ${patient.first_name} ${patient.last_name} — ${reasons[0]}`, detail: reasons.join('; '),
      });
      return { applied: false, reasons };
    }
    const actor = { source, actor: source === 'automation' ? 'Eligibility check (sandbox)' : 'Eligibility response from the payer', practiceId: e.practice_id };
    const out = await withActor(actor, async () => {
      const done = await apply(e.id);
      await audit(db, null, 'eligibility.auto_apply', 'patient_insurance', policy.id, { check_id: e.id, fields: done.fields }, {
        source, actor: actor.actor, before: done.before, after: done.after, patientId: e.patient_id, reason: 'The payer’s response matched the plan on file, so it was applied automatically',
      });
      return done;
    });
    await saveSummary(e.id, { ...s, applied: { at: new Date().toISOString(), auto: true, fields: out.fields } });
    await resolveIssue(db, e.practice_id, key, 'Resolved automatically: a later insurance check came back clean and was applied');
    return { applied: true, fields: out.fields };
  }
  const saveSummary = (id, s) => db.run('UPDATE eligibility_checks SET summary = ? WHERE id = ?', JSON.stringify(s), id);

  // A person applied it anyway, or kept what's on file: the exception is closed either way.
  async function resolveReview(checkId, { applied, userName }) {
    const e = await db.get('SELECT * FROM eligibility_checks WHERE id = ?', checkId);
    const s = e?.summary ? JSON.parse(e.summary) : null;
    if (!s) return;
    const at = new Date().toISOString();
    await saveSummary(e.id, { ...s, ...(applied ? { applied: { at, auto: false, by: userName } } : {}), ...(s.review ? { review: { ...s.review, resolved_at: at, resolved_by: userName, outcome: applied ? 'applied' : 'kept' } } : {}) });
    await resolveIssue(db, e.practice_id, `eligibility-review:${e.patient_insurance_id}`, applied ? `Applied to the policy by ${userName}` : `Kept what's on file (${userName})`);
  }

  // A day's booked patients with their primary policy and latest check.
  async function forDay(practiceId, date) {
    return await db.all(
      `SELECT a.id AS appointment_id, a.start_time, a.patient_id, p.first_name, p.last_name, pi.id AS policy_id, c.name AS carrier_name, pi.subscriber_id,
         e.id AS check_id, e.status, e.summary, e.created_at AS checked_at
       FROM real_appointments a JOIN real_patients p ON p.id = a.patient_id
       LEFT JOIN real_patient_insurance pi ON pi.id = (SELECT x.id FROM real_patient_insurance x WHERE x.patient_id = a.patient_id AND x.active = 1 ORDER BY CASE x.priority WHEN 'primary' THEN 0 ELSE 1 END, x.id LIMIT 1)
       LEFT JOIN insurance_carriers c ON c.id = pi.carrier_id
       LEFT JOIN real_eligibility_checks e ON e.id = (SELECT MAX(y.id) FROM real_eligibility_checks y WHERE y.patient_insurance_id = pi.id)
       WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status NOT IN ('cancelled','no_show')
       ORDER BY a.start_time`, practiceId, `${date} 00:00`, `${date} 24:00`,
    );
  }

  // Checks everyone on the day whose insurance wasn't checked in the last maxAgeDays. One failure doesn't stop the rest.
  async function batch(practiceId, date, { userId = null, maxAgeDays = 7 } = {}) {
    const since = new Date(Date.now() - maxAgeDays * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const rows = await forDay(practiceId, date);
    const seen = new Set();
    const out = { date, checked: 0, applied: 0, needs_look: 0, skipped: 0, failed: [], results: [] };
    for (const r of rows) {
      if (!r.policy_id || seen.has(r.policy_id)) continue;
      seen.add(r.policy_id);
      if (r.checked_at && r.checked_at >= since && r.status !== 'pending') { out.skipped++; continue; }
      try {
        const done = await check(await db.get('SELECT * FROM patient_insurance WHERE id = ?', r.policy_id), { userId });
        out.checked++;
        if (done.applied) out.applied++;
        if (done.reasons?.length) out.needs_look++;
        out.results.push({ patient_id: r.patient_id, status: done.status, applied: !!done.applied, reasons: done.reasons || [] });
      } catch (err) {
        out.failed.push({ patient_id: r.patient_id, error: err.message });
      }
    }
    return out;
  }

  return { automatic, check, forDay, batch, apply, settle, resolveReview };
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
    // The evening run is the system's own work, so what it applies is recorded as automation.
    const out = await withActor({ source: 'automation', actor: 'Nightly insurance check', practiceId: p.id }, () => eligibility.batch(p.id, tomorrow));
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

const pickFields = (row, keys) => Object.fromEntries(Object.keys(keys).filter((k) => k !== 'frequencies' && k !== 'deductible_year').map((k) => [k, row?.[k] ?? null]));

// Payer rejection codes (AAA03) the front desk can act on.
const AAA = {
  15: 'the payer needs more information', 42: 'the payer’s system is down — try again later', 43: 'the provider isn’t registered with this payer',
  58: 'the date of birth doesn’t match', 72: 'the member ID isn’t right', 73: 'the name doesn’t match', 75: 'the payer can’t find this subscriber', 76: 'duplicate member ID',
};
const dollars = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 })}`;

// What in a 271 needs a person. Empty means it's clean and can be applied on its own. Plan-wide numbers only
// count as a mismatch once someone has verified the plan: until then the payer's figures are the better ones.
export function eligibilityProblems(s, { plan = null, today = null } = {}) {
  const out = [];
  if (s.errors?.length) out.push(`the payer couldn’t check it (${s.errors.map((e) => AAA[Number(e.code)] || `code ${e.code}`).join(', ')})`);
  else if (s.active === false) out.push('coverage isn’t active');
  else if (s.active == null) out.push('the payer didn’t say whether coverage is active');
  if (s.plan_begin && today && s.plan_begin > today) out.push(`coverage doesn’t start until ${s.plan_begin}`);
  if (plan?.verified_at && !out.length) {
    const cmp = [['annual_max', 'annual max', s.annual_max, dollars], ['deductible', 'deductible', s.deductible, dollars],
      ['pct_preventive', 'preventive', s.coinsurance?.preventive, (v) => `${v}%`], ['pct_basic', 'basic', s.coinsurance?.basic, (v) => `${v}%`], ['pct_major', 'major', s.coinsurance?.major, (v) => `${v}%`]];
    for (const [k, label, payer, fmt] of cmp) {
      if (payer != null && plan[k] != null && Number(payer) !== Number(plan[k])) out.push(`${label}: the payer says ${fmt(payer)}, the plan on file says ${fmt(plan[k])}`);
    }
  }
  return out;
}
