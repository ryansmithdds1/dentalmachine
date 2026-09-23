import { financeOverview } from './metrics.js';

// Is each insurance plan worth taking? For the last N months: what the practice kept (office fee minus the
// PPO write-off) per chair hour spent on that carrier's patients, next to what a chair hour costs to run
// (from QuickBooks or the bank), and what dropping the plan would likely do.
//
// Chair time: each completed visit's minutes, split across carriers by the fees of the work done in it.
// Carrier: the one billed for the work (primary claim), else the patient's primary insurance, else "No insurance".
// Dropping a plan: `retention`% of its patients stay and pay the office fee (no write-off); the rest leave,
// and `refill`% of the chair time they used is filled at what the other patients net per hour.
const round = (n) => Math.round(n);
const per = (a, b) => (b > 0 ? Math.round(a / b) : null);
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

export async function ppoProfitability(db, pid, { today, months = 12, retention = 70, refill = 50, costPerHour = null }) {
  const start = new Date(Date.parse(`${today}T12:00:00Z`));
  start.setUTCMonth(start.getUTCMonth() - months);
  const from = start.toISOString().slice(0, 10);

  const procs = await db.all(
    `SELECT pr.id, pr.patient_id, pr.appointment_id, pr.code, pr.description, pr.fee, substr(pr.completed_at, 1, 10) AS d,
       cl.status AS claim_status, pi.carrier_id AS claim_carrier,
       ci.write_off, ci.adjusted_amount, ci.paid_amount, ci.estimated_amount
     FROM procedures pr
     LEFT JOIN claim_items ci ON ci.procedure_id = pr.id AND ci.claim_id IN (SELECT id FROM claims WHERE status <> 'void' AND primary_claim_id IS NULL)
     LEFT JOIN claims cl ON cl.id = ci.claim_id
     LEFT JOIN patient_insurance pi ON pi.id = cl.patient_insurance_id
     WHERE pr.practice_id = ? AND pr.status = 'completed' AND pr.completed_at >= ? AND pr.completed_at <= ?`, pid, from, `${today} 23:59:59`,
  );
  const primary = new Map((await db.all("SELECT patient_id, carrier_id FROM patient_insurance WHERE practice_id = ? AND active = 1 AND priority = 'primary' ORDER BY id", pid)).map((r) => [r.patient_id, r.carrier_id]));
  const carriers = new Map((await db.all('SELECT id, name FROM insurance_carriers WHERE practice_id = ?', pid)).map((c) => [c.id, c.name]));
  const visits = await db.all(
    `SELECT id, patient_id, start_time, end_time FROM appointments WHERE practice_id = ? AND status IN ('completed','checked_in','in_chair') AND start_time >= ? AND start_time <= ?`,
    pid, `${from} 00:00`, `${today} 23:59`,
  );
  const mins = (v) => Math.max(0, (Date.parse(`${v.end_time.replace(' ', 'T')}:00Z`) - Date.parse(`${v.start_time.replace(' ', 'T')}:00Z`)) / 60000);

  const groups = new Map();
  const group = (key) => {
    if (!groups.has(key)) groups.set(key, { key, carrier_id: key === 'none' ? null : key, name: key === 'none' ? 'No insurance' : carriers.get(key) || 'Unknown carrier', patients: new Set(), visits: 0, minutes: 0, gross: 0, write_off: 0, insurance: 0, codes: new Map() });
    return groups.get(key);
  };
  const keyFor = (p) => p.claim_carrier ?? primary.get(p.patient_id) ?? 'none';
  const byVisit = new Map();
  for (const p of procs) {
    const g = group(keyFor(p));
    // The write-off actually posted once the claim paid, else the estimate.
    const wo = ['paid', 'partially_paid'].includes(p.claim_status) && p.adjusted_amount ? p.adjusted_amount : p.write_off || 0;
    const ins = ['paid', 'partially_paid'].includes(p.claim_status) ? p.paid_amount || 0 : p.estimated_amount || 0;
    g.patients.add(p.patient_id);
    g.gross += p.fee;
    g.write_off += wo;
    g.insurance += ins;
    const c = g.codes.get(p.code) || { code: p.code, description: p.description, count: 0, fee: 0, allowed: 0 };
    c.count += 1;
    c.fee += p.fee;
    c.allowed += p.fee - wo;
    g.codes.set(p.code, c);
    if (p.appointment_id) {
      const list = byVisit.get(p.appointment_id) || [];
      list.push({ key: g.key, fee: p.fee });
      byVisit.set(p.appointment_id, list);
    }
  }
  for (const v of visits) {
    const done = byVisit.get(v.id);
    const m = mins(v);
    if (!done?.length) {
      const g = group(primary.get(v.patient_id) ?? 'none');
      g.minutes += m;
      g.visits += 1;
      g.patients.add(v.patient_id);
      continue;
    }
    const total = done.reduce((s, x) => s + x.fee, 0);
    const shares = new Map();
    for (const x of done) shares.set(x.key, (shares.get(x.key) || 0) + (total ? x.fee / total : 1 / done.length));
    for (const [key, share] of shares) {
      const g = group(key);
      g.minutes += m * share;
      g.visits += share;
    }
  }

  // What an hour in the chair costs: every business expense over chair hours, from the finance data.
  const fin = await financeOverview(db, pid, { months: Math.min(24, months), today });
  const s = fin.summary;
  const measured = s.months && s.chair_hours ? per(s.expenses, s.chair_hours) : null;
  const cost = costPerHour ?? measured;
  const variable = s.chair_hours ? per(fin.categories.filter((c) => ['supplies', 'lab'].includes(c.key)).reduce((t, c) => t + c.amount, 0), s.chair_hours) : null;
  const annual = 12 / months;

  const rows = [...groups.values()].map((g) => {
    const hours = g.minutes / 60;
    const net = g.gross - g.write_off;
    return {
      carrier_id: g.carrier_id, name: g.name, patients: g.patients.size, visits: round(g.visits), chair_hours: Math.round(hours * 10) / 10,
      gross: g.gross, write_off: g.write_off, net, insurance: g.insurance, patient_portion: net - g.insurance,
      write_off_pct: pct(g.write_off, g.gross), net_per_hour: per(net, hours), gross_per_hour: per(g.gross, hours),
      profit_per_hour: cost != null && hours > 0 ? per(net, hours) - cost : null,
      codes: [...g.codes.values()].sort((a, b) => b.fee - a.fee).slice(0, 12).map((c) => ({ code: c.code, description: c.description, count: c.count, fee: per(c.fee, c.count), allowed: per(c.allowed, c.count), pct_of_fee: pct(c.allowed, c.fee) })),
      _hours: hours,
    };
  }).sort((a, b) => b.net - a.net);

  for (const r of rows) {
    if (!r.carrier_id || !r._hours) continue;
    // The rest of the practice's net per hour: what freed-up time is worth when it's refilled.
    const others = rows.filter((x) => x !== r);
    const otherHours = others.reduce((t, x) => t + x._hours, 0);
    const alt = otherHours ? others.reduce((t, x) => t + x.net, 0) / otherHours : r.net / r._hours;
    const keep = retention / 100;
    const kept = r.write_off * keep;
    const lostNet = r.net * (1 - keep);
    const freed = r._hours * (1 - keep);
    const refilled = freed * (refill / 100) * alt;
    const saved = variable != null ? freed * (1 - refill / 100) * variable : 0;
    const change = kept - lostNet + refilled + saved;
    r.drop = {
      change_per_year: round(change * annual), recaptured_write_offs: round(kept * annual), lost_net: round(lostNet * annual),
      refilled: round(refilled * annual), variable_saved: round(saved * annual), freed_hours: Math.round(freed * annual),
      patients_leaving: Math.round(r.patients * (1 - keep)), alt_net_per_hour: round(alt),
    };
    // The fee increase that would make this plan pay for its chair time.
    r.raise_needed_pct = cost != null && r.net_per_hour && r.net_per_hour < cost ? Math.ceil(((cost / r.net_per_hour) - 1) * 100) : 0;
    r.verdict = r.profit_per_hour == null ? null : r.profit_per_hour >= 0 ? 'profitable' : change > 0 ? 'consider_dropping' : 'renegotiate';
  }
  for (const r of rows) delete r._hours;

  const insured = rows.filter((r) => r.carrier_id);
  const insights = [];
  for (const r of insured.filter((x) => x.verdict === 'consider_dropping')) insights.push({ tone: 'warn', text: `${r.name} nets $${(r.net_per_hour / 100).toFixed(0)} an hour against $${(cost / 100).toFixed(0)} to run the chair. Leaving it would likely be worth about $${Math.round(r.drop.change_per_year / 100).toLocaleString('en-US')} a year if ${retention}% of its ${r.patients} patients stay.` });
  for (const r of insured.filter((x) => x.verdict === 'renegotiate')) insights.push({ tone: 'info', text: `${r.name} loses money per chair hour, but its patients are worth keeping — ask for a ${r.raise_needed_pct}% fee increase.` });
  const heavy = insured.filter((r) => r.write_off_pct > 40);
  if (heavy.length) insights.push({ tone: 'info', text: `Write-offs above 40% of your fees: ${heavy.map((r) => `${r.name} (${r.write_off_pct}%)`).join(', ')}.` });

  return {
    from, to: today, months, retention, refill, cost_per_hour: cost, measured_cost_per_hour: measured, cost_months: s.months, variable_per_hour: variable,
    carriers: rows, insights,
  };
}
