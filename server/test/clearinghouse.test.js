import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { harness } from './helpers.js';
import { createClearinghouse, processInbound } from '../src/clearinghouse.js';
import { parse277, parse999, build276, parseX12, sandbox999, sandbox277, sandbox835 } from '../src/x12.js';

const h = harness();

// A practice with a completed crown on a Delta policy and a claim ready to send.
async function claimReady() {
  const ctx = await h.practice();
  const { api, provider, patient } = ctx;
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W123', group_number: 'G1', annual_max: 150000, deductible: 0, pct_basic: 80 })).data;
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: provider.id, complete: true })).data;
  const claim = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [proc.id] })).data;
  return { ...ctx, carrier, policy, claim };
}

test('sandbox clearinghouse: submit → 999 → 277CA → 835 posts payment automatically', async () => {
  const { api, claim, patient } = await claimReady();
  assert.equal((await api.get('/clearinghouse')).data.mode, 'sandbox');
  const sent = await api.post('/claims/submit', { claim_ids: [claim.id] });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.deepEqual(sent.data.responses.map((f) => f.type).sort(), ['277CA', '835', '999']);

  const after = (await api.get(`/claims/${claim.id}`)).data;
  assert.equal(after.status, 'paid');
  assert.equal(after.paid_amount, claim.estimated_amount);
  assert.match(after.payer_claim_number, /^SBX/);
  const events = (await api.get(`/claims/${claim.id}/events`)).data;
  assert.deepEqual(events.map((e) => [e.source, e.status]), [['submit', 'sent'], ['999', 'received'], ['277CA', 'accepted'], ['835', 'paid']]);
  const ledger = (await api.get(`/patients/${patient.id}/ledger`)).data;
  assert.ok((ledger.entries || ledger).some((e) => e.type === 'insurance_payment'));

  // Real-time claim status (sandbox) after payment.
  const status = (await api.post(`/claims/${claim.id}/status-check`)).data;
  assert.equal(status.category, 'F1');
  assert.equal(status.status, 'finalized');

  // Polling again finds nothing new; the ERA is listed under Remittance.
  assert.deepEqual((await api.post('/clearinghouse/poll')).data.files, []);
  assert.equal((await api.get('/era')).data.length, 1);
  const overview = (await api.get('/clearinghouse')).data;
  assert.equal(overview.batches[0].status, 'accepted');
  assert.equal(overview.inbox.length, 3);
});

test('a rejected batch (999) sends claims back for correction', async () => {
  const { api, claim } = await claimReady();
  const sent = await api.post('/claims/837', { claim_ids: [claim.id] }); // manual download marks it submitted
  const control = parseX12(sent.data).find((s) => s.id === 'GS').e[6];
  // Record the batch as if it had been uploaded, then load the clearinghouse's rejection.
  const batch = await h.db.run("INSERT INTO edi_batches (practice_id, control, claim_ids, status) VALUES (?, ?, ?, 'sent')", claim.practice_id, String(Number(control)), JSON.stringify([claim.id]));
  await h.db.run('UPDATE claims SET batch_id = ? WHERE id = ?', batch.id, claim.id);
  const rejection = sandbox999({ groupControl: control, accepted: false }).replace('IK5*R', 'IK3*NM1*12**8~IK4*9*67*7*BADID~IK5*R');
  const ack = parse999(rejection);
  assert.equal(ack.status, 'rejected');
  assert.match(ack.errors.join(), /invalid code value/);
  const up = await api.post(`/clearinghouse/responses?filename=reject.999`, rejection);
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const c = (await api.get(`/claims/${claim.id}`)).data;
  assert.equal(c.status, 'draft');
  assert.equal(c.ch_status, 'rejected');
  assert.equal((await api.get('/clearinghouse')).data.needs_attention[0].id, claim.id);
});

test('277 claim status parsing and 276 request', async () => {
  const x12 = 'ISA*00*          *00*          *ZZ*PAYER          *ZZ*DM             *260101*1200*^*00501*000000001*0*P*:~GS*HN*PAYER*DM*20260101*1200*1*X*005010X212~ST*277*0001*005010X212~BHT*0010*08*1*20260101*1200*DG~HL*1**20*1~NM1*PR*2*DELTA*****PI*94276~HL*2*1*PT~TRN*2*DM42~STC*F2:88:PR*20260105**235*0~REF*1K*CLM9~SE*9*0001~GE*1*1~IEA*1*000000001~';
  const out = parse277(x12);
  assert.equal(out.kind, '277');
  assert.deepEqual([out.claims[0].control_number, out.claims[0].group, out.claims[0].payer_claim_number], ['DM42', 'finalized', 'CLM9']);
  assert.match(out.claims[0].text, /denied/);
  const req = build276({
    practice: { name: 'Bright Smiles', npi: '1234567893' }, senderId: 'S', receiverId: 'R', trace: 'T1',
    bundle: { claim: { control_number: 'DM42', total_fee: 23500 }, patient: { first_name: 'Jane', last_name: 'Doe', dob: '1985-04-12' }, policy: { relationship: 'self', subscriber_name: 'Jane Doe', subscriber_id: 'W1' }, carrier: { name: 'Delta', payer_id: '94276' }, items: [{ completed_at: '2026-01-02' }] },
  });
  assert.match(req, /ST\*276\*0001\*005010X212/);
  assert.match(req, /TRN\*1\*DM42/);
  assert.match(req, /DTP\*472\*RD8\*20260102-20260102/);
});

// ---- SFTP transport against a real SSH/SFTP server ----
const { Server, utils: { sftp: { OPEN_MODE, STATUS_CODE } } } = ssh2;
function sftpServer(files) {
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
  const dirs = new Set(['/', '/inbound', '/outbound', '/archive']);
  const attrs = (size, dir) => ({ mode: dir ? 0o40755 : 0o100644, uid: 0, gid: 0, size, atime: 0, mtime: 0 });
  return new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'dm' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => client.on('session', (acceptSession) => {
      acceptSession().on('sftp', (acceptSftp) => {
        const sftp = acceptSftp();
        const handles = new Map();
        let next = 0;
        const handle = (v) => {
          const b = Buffer.alloc(4);
          b.writeUInt32BE(++next);
          handles.set(next, v);
          return b;
        };
        const get = (b) => handles.get(b.readUInt32BE(0));
        const stat = (id, path) => (dirs.has(path) ? sftp.attrs(id, attrs(0, true)) : files.has(path) ? sftp.attrs(id, attrs(files.get(path).length)) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE));
        sftp.on('REALPATH', (id, path) => sftp.name(id, [{ filename: path === '.' ? '/' : path, longname: path, attrs: attrs(0, true) }]));
        sftp.on('STAT', stat).on('LSTAT', stat);
        sftp.on('OPEN', (id, path, flags) => {
          if (flags & OPEN_MODE.WRITE) files.set(path, Buffer.alloc(0));
          else if (!files.has(path)) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
          sftp.handle(id, handle({ path }));
        });
        sftp.on('WRITE', (id, h2, offset, data) => {
          const { path } = get(h2);
          const cur = files.get(path);
          const out = Buffer.alloc(Math.max(cur.length, offset + data.length));
          cur.copy(out);
          data.copy(out, offset);
          files.set(path, out);
          sftp.status(id, STATUS_CODE.OK);
        });
        sftp.on('READ', (id, h2, offset, length) => {
          const data = files.get(get(h2).path);
          if (offset >= data.length) return sftp.status(id, STATUS_CODE.EOF);
          sftp.data(id, data.subarray(offset, offset + length));
        });
        sftp.on('FSTAT', (id, h2) => sftp.attrs(id, attrs(files.get(get(h2).path)?.length || 0)));
        sftp.on('CLOSE', (id) => sftp.status(id, STATUS_CODE.OK));
        sftp.on('OPENDIR', (id, path) => (dirs.has(path) ? sftp.handle(id, handle({ dir: path, done: false })) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE)));
        sftp.on('READDIR', (id, h2) => {
          const d = get(h2);
          if (d.done) return sftp.status(id, STATUS_CODE.EOF);
          d.done = true;
          const entries = [...files.keys()].filter((p) => p.startsWith(`${d.dir}/`) && !p.slice(d.dir.length + 1).includes('/'))
            .map((p) => ({ filename: p.slice(d.dir.length + 1), longname: `-rw-r--r-- 1 dm dm ${files.get(p).length} Jan 1 00:00 ${p.slice(d.dir.length + 1)}`, attrs: attrs(files.get(p).length) }));
          sftp.name(id, entries);
        });
        sftp.on('RENAME', (id, from, to) => {
          files.set(to, files.get(from));
          files.delete(from);
          sftp.status(id, STATUS_CODE.OK);
        });
        for (const ev of ['REMOVE', 'MKDIR', 'SETSTAT', 'FSETSTAT']) sftp.on(ev, (id) => sftp.status(id, STATUS_CODE.OK));
      });
    }));
  });
}

let sftpSrv;
let sftpPort;
const remote = new Map();
before(async () => {
  sftpSrv = sftpServer(remote);
  await new Promise((r) => sftpSrv.listen(0, '127.0.0.1', r));
  sftpPort = sftpSrv.address().port;
});
after(() => sftpSrv?.close());

test('SFTP transport uploads 837s and downloads, routes and archives responses', async () => {
  const { claim } = await claimReady();
  const ch = createClearinghouse({
    db: h.db,
    config: { mode: 'sftp', sftp: { host: '127.0.0.1', port: sftpPort, username: 'dm', password: 'secret', uploadDir: '/inbound', downloadDir: '/outbound', archiveDir: '/archive' }, pollMinutes: 15 },
  });
  await ch.batch.submit({ filename: 'test.837', content: 'ISA*00*test~' });
  assert.equal(remote.get('/inbound/test.837').toString(), 'ISA*00*test~');

  // The clearinghouse drops a 277CA for our claim in the outbound folder.
  const ctl = `DM${claim.id}`;
  await h.db.run('UPDATE claims SET control_number = ?, status = ? WHERE id = ?', ctl, 'submitted', claim.id);
  const ca = `ISA*00*          *00*          *ZZ*CH             *ZZ*DM             *260101*1200*^*00501*000000002*0*P*:~GS*HN*CH*DM*20260101*1200*2*X*005010X214~ST*277*0001*005010X214~BHT*0085*08*1*20260101*1200*TH~HL*1**20*1~HL*2*1*PT~TRN*2*${ctl}~STC*A7:562:85*20260101**235*0~SE*7*0001~GE*1*2~IEA*1*000000002~`;
  remote.set('/outbound/response1.277', Buffer.from(ca));
  const files = await ch.batch.fetch();
  assert.deepEqual(files.map((f) => f.name), ['response1.277']);
  const res = await processInbound(h.db, files[0]);
  assert.equal(res.type, '277CA');
  assert.equal(res.practice_id, claim.practice_id);
  await ch.batch.done(['response1.277']);
  assert.ok(remote.has('/archive/response1.277') && !remote.has('/outbound/response1.277'));
  const c = await h.db.get('SELECT * FROM claims WHERE id = ?', claim.id);
  assert.equal(c.status, 'draft', 'payer rejection returns the claim for correction');
  assert.equal(c.ch_status, 'rejected');
  assert.match(c.ch_message, /invalid information/);
  // Same file again is ignored.
  assert.ok((await processInbound(h.db, files[0])).duplicate);
});

// ---- CAQH CORE real-time connectivity ----
test('real-time eligibility and claim status over CAQH CORE multipart', async () => {
  const seen = [];
  const srv = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
    seen.push(Object.fromEntries([...form.keys()].map((k) => [k, form.get(k)])));
    const isElig = form.get('PayloadType').startsWith('X12_270');
    const payload = isElig
      ? 'ISA*00*          *00*          *ZZ*CH             *ZZ*DM             *260101*1200*^*00501*000000001*0*P*:~GS*HB*CH*DM*20260101*1200*1*X*005010X279A1~ST*271*0001*005010X279A1~BHT*0022*11*T*20260101*1200~HL*1**20*1~NM1*PR*2*DELTA~EB*1*IND*35**PPO GOLD~EB*F*IND*35***23*2000~EB*F*IND*35***29*1500~EB*A*IND*25*****0.2~SE*9*0001~GE*1*1~IEA*1*000000001~'
      : `ISA*00*          *00*          *ZZ*CH             *ZZ*DM             *260101*1200*^*00501*000000001*0*P*:~GS*HN*CH*DM*20260101*1200*1*X*005010X212~ST*277*0001*005010X212~BHT*0010*08*1*20260101*1200*DG~HL*1**20*1~HL*2*1*PT~TRN*2*${form.get('Payload').match(/TRN\*1\*([^~]+)/)[1]}~STC*P1:20:PR*20260101**235~SE*7*0001~GE*1*1~IEA*1*000000001~`;
    const out = new FormData();
    for (const [k, v] of Object.entries({ PayloadType: isElig ? 'X12_271_Response_005010X279A1' : 'X12_277_Response_005010X212', ProcessingMode: 'RealTime', PayloadID: form.get('PayloadID'), TimeStamp: new Date().toISOString(), SenderID: 'CH', ReceiverID: 'DM', CORERuleVersion: '2.2.0', ErrorCode: 'Success', ErrorMessage: '', Payload: payload })) out.append(k, v);
    const r = new Response(out);
    res.writeHead(200, { 'content-type': r.headers.get('content-type') });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const ch = createClearinghouse({ db: h.db, config: { mode: 'manual', realtime: { url: `http://127.0.0.1:${srv.address().port}/core`, username: 'user', password: 'pw', senderId: 'DM1', receiverId: 'CH' } } });
    const x271 = await ch.realtime.eligibility('ISA*00*request270~');
    assert.match(x271, /ST\*271/);
    assert.equal(seen[0].PayloadType, 'X12_270_Request_005010X279A1');
    assert.equal(seen[0].ProcessingMode, 'RealTime');
    assert.equal(seen[0].CORERuleVersion, '2.2.0');
    assert.equal(seen[0].UserName, 'user');
    assert.equal(seen[0].Payload, 'ISA*00*request270~');
    const x277 = await ch.realtime.claimStatus('ISA*~TRN*1*DM77~');
    assert.equal(parse277(x277).claims[0].control_number, 'DM77');
    assert.equal(parse277(x277).claims[0].group, 'pending');
  } finally {
    srv.close();
  }
});

// ---- Hardening: responses that arrive twice, late, out of scope, split or bundled ----
const era835 = (claims, eft = `EFT${Math.random().toString(36).slice(2, 8)}`) =>
  sandbox835({ payee: { name: 'Practice', npi: '1234567893' }, eft, date: '2026-01-15', claims: claims.map((c) => ({ billed: 23500, patient: 0, write_off: 0, payer_claim_number: 'PCN1', ...c })) });
// Two transactions (two payers' remittances) in one interchange.
function bundle835(a, b) {
  const segs = (x) => x.split('~').filter(Boolean);
  const inner = (x) => segs(x).filter((s) => !/^(ISA|GS|GE|IEA)\*/.test(s));
  const outer = segs(a);
  return [...outer.filter((s) => /^(ISA|GS)\*/.test(s)), ...inner(a), ...inner(b), ...outer.filter((s) => /^(GE|IEA)\*/.test(s))].join('~') + '~';
}
async function manuallySent(api, claim) {
  const sent = await api.post('/claims/837', { claim_ids: [claim.id] });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  return Number(parseX12(sent.data).find((s) => s.id === 'GS').e[6]);
}

test('responses are scoped: one practice cannot post to or reject another practice\'s claims', async () => {
  const a = await claimReady();
  const b = await h.practice();
  await manuallySent(a.api, a.claim);
  const up = await b.api.post('/era/import?filename=x.835', era835([{ control_number: `DM${a.claim.id}`, paid: 23500 }]));
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(up.data.claims[0].result, 'unmatched');
  assert.equal((await a.api.get(`/claims/${a.claim.id}`)).data.status, 'submitted');
  const rej = await b.api.post('/clearinghouse/responses?filename=x.277', sandbox277({ claims: [{ control_number: `DM${a.claim.id}`, category: 'A7', code: '21', last_name: 'X', first_name: 'Y' }] }));
  assert.equal(rej.status, 201);
  assert.equal((await a.api.get(`/claims/${a.claim.id}`)).data.status, 'submitted');
});

test('the same response file processed twice at once is applied once', async () => {
  const { api, claim, patient } = await claimReady();
  await manuallySent(api, claim);
  const file = { name: 'dup.835', content: era835([{ control_number: `DM${claim.id}`, paid: claim.estimated_amount, write_off: 23500 - claim.estimated_amount }]) };
  const results = await Promise.all([processInbound(h.db, file), processInbound(h.db, file), processInbound(h.db, file)]);
  assert.equal(results.filter((r) => r.duplicate).length, 2);
  const payments = (await api.get(`/patients/${patient.id}/ledger`)).data;
  assert.equal((payments.entries || payments).filter((e) => e.type === 'insurance_payment').length, 1);
  assert.equal((await api.get(`/claims/${claim.id}`)).data.status, 'paid');
});

test('a late rejection of an older submission does not undo a resend', async () => {
  const { api, claim } = await claimReady();
  const control = await manuallySent(api, claim);
  await h.db.run("INSERT INTO edi_batches (practice_id, control, claim_ids, status) VALUES (?, ?, ?, 'sent')", claim.practice_id, String(control), JSON.stringify([claim.id]));
  // Sending again needs a deliberate resend.
  const again = await api.post('/claims/submit', { claim_ids: [claim.id] });
  assert.equal(again.status, 409);
  assert.equal(again.data.details.already_sent, true);
  // Park the sandbox's instant answers so the resend stays in flight.
  const resend = await api.post('/claims/submit', { claim_ids: [claim.id], resend: true });
  assert.equal(resend.status, 201, JSON.stringify(resend.data));
  const now = (await api.get(`/claims/${claim.id}`)).data;
  assert.match(now.control_number, new RegExp(`^DM${claim.id}B${resend.data.batch_id}$`));
  // Now the first batch's rejection turns up.
  await api.post('/clearinghouse/responses?filename=old.999', sandbox999({ groupControl: control, accepted: false }));
  const c = (await api.get(`/claims/${claim.id}`)).data;
  assert.notEqual(c.status, 'draft');
  const events = (await api.get(`/claims/${claim.id}/events`)).data;
  assert.ok(events.some((e) => /earlier submission/.test(e.message)));
});

test('835 files: several remittances in one file, split claim lines, and patient-responsibility write-offs', async () => {
  const one = await claimReady();
  const two = await claimReady();
  await manuallySent(one.api, one.claim);
  await manuallySent(one.api, two.claim).catch(() => {}); // other practice — send through its own account
  await manuallySent(two.api, two.claim);
  // Claim one paid in two lines (150 + 50), $35 patient share, $0 contractual listed → rest written off.
  const fileA = era835([
    { control_number: `DM${one.claim.id}`, paid: 15000, patient: 3500, billed: 20000 },
    { control_number: `DM${one.claim.id}`, paid: 0, patient: 0, billed: 3500, write_off: 3500 },
  ]).replace(/CLP\*([^*]+)\*4\*/, 'CLP*$1*1*');
  const fileB = era835([{ control_number: `DM${two.claim.id}`, paid: 20000, billed: 23500, patient: 0 }]).replace(/CAS\*CO\*45/, 'CAS*PI*45');
  const both = bundle835(fileA, fileB);
  const res = await processInbound(h.db, { name: 'multi.835', content: both });
  assert.equal(res.error ?? null, null, JSON.stringify(res));
  const c1 = (await one.api.get(`/claims/${one.claim.id}`)).data;
  assert.equal(c1.status, 'paid');
  assert.equal(c1.paid_amount, 15000);
  assert.equal((await one.api.get(`/patients/${one.patient.id}/ledger`)).data.balance, 3500);
  const c2 = (await two.api.get(`/claims/${two.claim.id}`)).data;
  assert.equal(c2.status, 'paid');
  assert.equal(c2.paid_amount, 20000);
  assert.equal((await two.api.get(`/patients/${two.patient.id}/ledger`)).data.balance, 0);
});

test('a TA1 rejection sends the whole batch back; a non-277 status answer is a gateway error', async () => {
  const { api, claim } = await claimReady();
  const control = await manuallySent(api, claim);
  const batch = await h.db.run("INSERT INTO edi_batches (practice_id, control, claim_ids, status) VALUES (?, ?, ?, 'sent')", claim.practice_id, String(control), JSON.stringify([claim.id]));
  await h.db.run('UPDATE claims SET batch_id = ? WHERE id = ?', batch.id, claim.id);
  const ta1 = `ISA*00*          *00*          *ZZ*CH             *ZZ*DM             *260101*1200*^*00501*${String(control).padStart(9, '0')}*0*P*:~TA1*${String(control).padStart(9, '0')}*260101*1200*R*022~IEA*0*${String(control).padStart(9, '0')}~`;
  assert.equal((await api.post('/clearinghouse/responses?filename=r.ta1', ta1)).status, 201);
  const c = (await api.get(`/claims/${claim.id}`)).data;
  assert.equal(c.status, 'draft');
  assert.equal(c.ch_status, 'rejected');

  await manuallySent(api, claim);
  const ch = h.app.locals.clearinghouse;
  ch.realtime = { claimStatus: async () => sandbox999({ groupControl: 1 }) };
  try {
    const r = await api.post(`/claims/${claim.id}/status-check`);
    assert.equal(r.status, 502);
    assert.match(r.data.error, /999/);
  } finally {
    delete ch.realtime;
  }
});
