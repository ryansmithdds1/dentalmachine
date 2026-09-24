import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, recorded, publicPractice } from '../util.js';
import { build837D } from '../x12.js';
import { raiseIssue, resolveIssue, logIntegration } from '../issues.js';

// Daily workflows, batch 4 (docs/workflows/specs/32-…44-*.md): the server pieces those screens need that no
// other module already offers. Mounted in app.js next to the other signed-in routes:
//   api.use(dailyRoutes({ db, config, clearinghouse }));

// Pre-authorization (workflow 38): send the predetermination straight to the clearinghouse, the way claims go,
// instead of downloading an 837 file and uploading it by hand. Practices without a clearinghouse connection get
// 409 with `download: true`, and the screen falls back to the file.
export default function dailyRoutes({ db, config = {}, clearinghouse: ch }) {
  const r = Router();

  r.post('/daily/preauths/:aid/send', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const pa = await findOr404(db, 'preauths', req.params.aid, pid, 'Pre-authorization');
    if (!['draft', 'denied'].includes(pa.status)) {
      // Asked twice (a double click, a retry): the first send stands; say so rather than send it again.
      return res.json({ preauth: pa, already_sent: true });
    }
    if (!ch?.batch) throw new HttpError(409, 'No clearinghouse connection is set up — download the 837 file and upload it instead', { download: true, mode: ch?.mode || 'manual' });
    const procedureIds = JSON.parse(pa.procedure_ids || '[]').map(Number).filter(Number.isInteger);
    if (!procedureIds.length) throw new HttpError(400, 'This pre-authorization has no procedures');
    const practice = publicPractice(await db.get('SELECT * FROM practices WHERE id = ?', pid));
    const policy = await db.get('SELECT * FROM patient_insurance WHERE id = ? AND practice_id = ?', pa.patient_insurance_id, pid);
    if (!policy) throw new HttpError(404, 'Policy not found');
    const items = await db.all(
      `SELECT pr.fee, pr.code, pr.tooth, pr.surfaces, NULL AS completed_at, pv.name AS provider_name, pv.npi AS provider_npi
       FROM procedures pr LEFT JOIN providers pv ON pv.id = pr.provider_id WHERE pr.practice_id = ? AND pr.id IN (${procedureIds.map(() => '?').join(',')})`,
      pid, ...procedureIds,
    );
    const control = (Date.now() % 1e9) || 1;
    const file = build837D({
      practice, taxonomy: practice.billing_provider_taxonomy, control,
      senderId: config.ediSubmitterId || String(practice.tax_id || '').replace(/\D/g, '') || `DM${practice.id}`, receiverId: config.ediReceiverId || 'CLEARINGHOUSE',
      claims: [{
        claim: { control_number: `PD${pa.id}`, total_fee: pa.total_fee, predetermination: true },
        policy, patient: await db.get('SELECT * FROM patients WHERE id = ?', pa.patient_id), carrier: await db.get('SELECT * FROM insurance_carriers WHERE id = ?', policy.carrier_id), items,
      }],
    });
    // Take it first, so two people (or a retry) can't both send it; put it back if the clearinghouse can't be reached.
    const took = await recorded(db, 'preauths', pa.id, () => db.run(
      "UPDATE preauths SET status = 'submitted', submitted_at = ? WHERE id = ? AND status IN ('draft','denied')", new Date().toISOString(), pa.id,
    ));
    if (!took.changes) return res.json({ preauth: await db.get('SELECT * FROM preauths WHERE id = ?', pa.id), already_sent: true });
    const filename = `DM${pid}_PD${pa.id}_${control}.837`;
    const t0 = Date.now();
    try {
      await ch.batch.submit({ filename, content: file }); // network I/O outside any transaction
    } catch (err) {
      await recorded(db, 'preauths', pa.id, () => db.run('UPDATE preauths SET status = ?, submitted_at = ? WHERE id = ?', pa.status, pa.submitted_at ?? null, pa.id));
      await logIntegration(db, { practiceId: pid, service: ch.name || 'Clearinghouse', operation: 'preauth.submit', ok: false, ms: Date.now() - t0, error: err.message });
      await raiseIssue(db, {
        practiceId: pid, kind: 'claim', key: `preauth-send:${pa.id}`, title: `Pre-authorization #${pa.id} didn’t reach the clearinghouse`,
        detail: err.message, role: 'billing', entity: 'preauths', entityId: pa.id, patientId: pa.patient_id,
      });
      // 424, not 502: the browser treats 502–504 as "this server is offline" and would hide the reason.
      throw new HttpError(424, `Couldn't reach the clearinghouse: ${err.message}. Nothing was sent; try again.`);
    }
    await logIntegration(db, { practiceId: pid, service: ch.name || 'Clearinghouse', operation: 'preauth.submit', ok: true, ms: Date.now() - t0, externalId: filename });
    await resolveIssue(db, pid, `preauth-send:${pa.id}`, 'Sent on a later attempt');
    await audit(db, req, 'preauth.submit', 'preauths', pa.id, { transport: ch.batch.transport, filename });
    res.status(201).json({ preauth: await db.get('SELECT * FROM preauths WHERE id = ?', pa.id), sent: true, transport: ch.batch.transport, clearinghouse: ch.name, filename });
  });

  return r;
}
