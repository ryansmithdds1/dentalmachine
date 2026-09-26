import { HttpError } from './auth.js';
import { refuseTraining } from './training.js';
import { insert, audit } from './util.js';
import { logIntegration, raiseIssue, resolveIssue } from './issues.js';

// Prescription drug monitoring program (PDMP) checks before a controlled substance (README.md, “PDMP”; action A178).
//   PDMP=none      no connection: the prescriber checks the state's website and records that they did (or why not)
//   PDMP=sandbox   simulated answers for demos and tests (the default outside production)
//   PDMP=gateway   a PMP gateway service (Bamboo Health PMP Gateway style: PDMP_URL, PDMP_CLIENT_ID, PDMP_SECRET,
//                  PDMP_STATE, PDMP_NAME). Swapping vendors means changing only this adapter.
// Every call is logged in Connection activity (integration_log: service, operation, result, time, reference — never the
// patient's details), and a failure becomes a Needs attention item that clears when a later check works. What is kept is
// a short summary (counts and flags) on the check, never the vendor's full report.
export function pdmpConfig(env = process.env) {
  return {
    mode: env.PDMP || (env.NODE_ENV === 'production' ? 'none' : 'sandbox'),
    url: (env.PDMP_URL || '').replace(/\/$/, ''), clientId: env.PDMP_CLIENT_ID || null, secret: env.PDMP_SECRET || null,
    state: env.PDMP_STATE || null, name: env.PDMP_NAME || null,
  };
}

// How recent a check must be to count for a prescription.
export const PDMP_WINDOW_HOURS = 24;

const summarize = ({ prescriptions, prescribers, pharmacies, flags = [] }) => {
  const head = prescriptions
    ? `${prescriptions} controlled-substance prescription${prescriptions === 1 ? '' : 's'} in the last 12 months from ${prescribers} prescriber${prescribers === 1 ? '' : 's'} and ${pharmacies} pharmac${pharmacies === 1 ? 'y' : 'ies'}.`
    : 'No controlled-substance prescriptions in the last 12 months.';
  return flags.length ? `${head} Flag: ${flags.join('; ')} — review the full report before prescribing.` : head;
};

export function createPdmp({ config = pdmpConfig(), fetchImpl = globalThis.fetch, db } = {}) {
  const base = { mode: config.mode, state: config.state };
  if (config.mode === 'sandbox') {
    return {
      ...base, name: 'PDMP sandbox (simulated)', automatic: true,
      async query({ patient, practiceId }) {
        const started = Date.now();
        // Made-up but steady answers per patient, so demos and tests can rely on them.
        const n = (patient.id * 7) % 4;
        const res = { prescriptions: n, prescribers: Math.min(n, 1 + (patient.id % 2)), pharmacies: n ? 1 : 0, flags: n >= 3 ? ['3 or more prescriptions in 12 months'] : [] };
        const ref = `SBX-PDMP-${Date.now().toString(36).toUpperCase()}`;
        await logIntegration(db, { practiceId, service: 'PDMP (sandbox)', operation: 'POST /patient-report', ok: true, ms: Date.now() - started, externalId: ref });
        return { ...res, flagged: res.flags.length > 0, summary: summarize(res), external_ref: ref };
      },
    };
  }
  if (config.mode === 'gateway') {
    if (!config.url || !config.clientId || !config.secret) throw new Error('PDMP=gateway needs PDMP_URL, PDMP_CLIENT_ID and PDMP_SECRET');
    return {
      ...base, name: config.name || 'State PDMP', automatic: true,
      async query({ patient, provider }) {
        // Demographics go in the body (loggedFetch records only the host and path).
        let r;
        try {
          r = await fetchImpl(`${config.url}/v1/patient-reports`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString('base64')}` },
            body: JSON.stringify({
              state: config.state, requester: { name: provider?.name, npi: provider?.npi, dea: provider?.dea_number, role: 'prescriber' },
              patient: { first_name: patient.first_name, last_name: patient.last_name, dob: patient.dob, gender: patient.gender, zip: patient.zip, state: patient.state },
            }),
          });
        } catch (err) {
          throw new HttpError(502, `The PDMP couldn't be reached (${err.message})`);
        }
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new HttpError(502, `The PDMP answered with an error (${r.status}${data.error ? `: ${String(data.error).slice(0, 120)}` : ''})`);
        const s = data.summary || {};
        const res = { prescriptions: Number(s.prescriptions) || 0, prescribers: Number(s.prescribers) || 0, pharmacies: Number(s.pharmacies) || 0, flags: Array.isArray(s.flags) ? s.flags.map((f) => String(f).slice(0, 120)).slice(0, 5) : [] };
        return { ...res, flagged: res.flags.length > 0, summary: summarize(res), external_ref: data.report_id ? String(data.report_id).slice(0, 80) : null, report_url: data.report_url || null };
      },
    };
  }
  if (config.mode !== 'none') throw new Error(`PDMP must be none, sandbox or gateway (not ${config.mode})`);
  return { ...base, name: 'State PDMP website', automatic: false };
}

// Runs (or records) one check. manual: the prescriber looked on the state's website and says what they found.
export async function runCheck(db, pdmp, req, patient, { provider = null, manual = false, summary = '' }) {
  const pid = req.user.practice_id;
  const row = { practice_id: pid, patient_id: patient.id, provider_id: provider?.id ?? null, checked_by: req.user.id, state: pdmp.state || patient.state || null };
  if (manual || !pdmp.automatic) {
    const said = String(summary || '').trim().slice(0, 500);
    if (!said) throw new HttpError(400, 'Say what the state PDMP showed (e.g. “no controlled prescriptions in 12 months”)', { missing: ['summary'] });
    const id = await insert(db, 'pdmp_checks', { ...row, mode: 'manual', status: 'done', summary: `Checked on the state PDMP website: ${said}` });
    await audit(db, req, 'pdmp.check', 'pdmp_checks', id, { mode: 'manual', patient_id: patient.id }, { patientId: patient.id });
    return db.get('SELECT * FROM pdmp_checks WHERE id = ?', id);
  }
  await refuseTraining(db, patient.id, 'a PDMP check with the state');
  try {
    const out = await pdmp.query({ patient, provider, practiceId: pid });
    const id = await insert(db, 'pdmp_checks', {
      ...row, mode: pdmp.mode, status: 'done', summary: out.summary, prescriptions_count: out.prescriptions, prescribers_count: out.prescribers, pharmacies_count: out.pharmacies,
      flagged: out.flagged ? 1 : 0, external_ref: out.external_ref,
    });
    await resolveIssue(db, pid, 'pdmp-failed', 'Resolved: a later PDMP check went through');
    await audit(db, req, 'pdmp.check', 'pdmp_checks', id, { mode: pdmp.mode, flagged: !!out.flagged, patient_id: patient.id }, { patientId: patient.id });
    return { ...(await db.get('SELECT * FROM pdmp_checks WHERE id = ?', id)), report_url: out.report_url || null };
  } catch (err) {
    const message = err instanceof HttpError ? err.message : `The PDMP check failed (${err.message})`;
    const id = await insert(db, 'pdmp_checks', { ...row, mode: pdmp.mode, status: 'failed', error: message.slice(0, 300) });
    await audit(db, req, 'pdmp.check_failed', 'pdmp_checks', id, { mode: pdmp.mode, patient_id: patient.id }, { patientId: patient.id });
    await raiseIssue(db, {
      practiceId: pid, kind: 'integration', key: 'pdmp-failed', role: 'clinical', severity: 'high', entity: 'pdmp_checks', entityId: id, patientId: patient.id,
      title: 'A prescription monitoring program (PDMP) check didn’t go through', detail: `${message} Check the state PDMP website for this patient and record it on the prescription, or try again.`,
    });
    throw new HttpError(502, `${message} — check the state PDMP website and record what you found, or try again.`, { check_id: id });
  }
}

// Before a controlled substance: a PDMP check for this patient in the last day (the one given, or the latest), or the
// prescriber's reason for skipping it. Returns the columns to store on the prescription.
export async function pdmpForPrescription(db, practiceId, patientId, body) {
  const since = new Date(Date.now() - PDMP_WINDOW_HOURS * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  if (body.pdmp_check_id) {
    const c = await db.get("SELECT * FROM pdmp_checks WHERE id = ? AND practice_id = ? AND patient_id = ? AND status = 'done'", Number(body.pdmp_check_id), practiceId, patientId);
    if (!c) throw new HttpError(400, 'That PDMP check is not this patient’s');
    if (c.created_at < since) throw new HttpError(409, `That PDMP check is more than ${PDMP_WINDOW_HOURS} hours old — check again`, { pdmp_required: true });
    return { pdmp_check_id: c.id, pdmp_override_reason: null, check: c };
  }
  const recent = await db.get("SELECT * FROM pdmp_checks WHERE practice_id = ? AND patient_id = ? AND status = 'done' AND created_at >= ? ORDER BY id DESC LIMIT 1", practiceId, patientId, since);
  if (recent) return { pdmp_check_id: recent.id, pdmp_override_reason: null, check: recent };
  const reason = String(body.pdmp_override_reason || '').trim().slice(0, 300);
  if (reason.length >= 5) return { pdmp_check_id: null, pdmp_override_reason: reason, check: null };
  throw new HttpError(409, 'Check the prescription monitoring program (PDMP) before prescribing a controlled substance, or say why it was skipped', { pdmp_required: true });
}
