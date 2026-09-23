import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { HttpError } from './auth.js';
import { insert } from './util.js';
import { parse999, parse277, parseX12, x12Type, sandbox999, sandbox277, sandbox835 } from './x12.js';
import { postEra, practiceForEra, claimForControl, claimEvent } from './era.js';

// Clearinghouse connection.
//   CLEARINGHOUSE=manual  (default) files are downloaded and uploaded by hand in the clearinghouse portal.
//   CLEARINGHOUSE=sandbox a built-in simulated clearinghouse and payer, for demos and training.
//   CLEARINGHOUSE=sftp    batch files over SFTP — the transport DentalXChange, Change Healthcare/Optum,
//                         Availity, Vyne/Tesia, Claim.MD and most others offer: 837D up; 999, 277CA and 835 down.
// Real-time eligibility (270/271) and claim status (276/277) use the CAQH CORE connectivity rule
// (HTTPS multipart POST) when CH_REALTIME_URL is set; most clearinghouses expose this endpoint.
export function clearinghouseConfig(env = process.env) {
  return {
    mode: env.CLEARINGHOUSE || (env.EDI_MODE === 'sandbox' ? 'sandbox' : 'manual'),
    name: env.CLEARINGHOUSE_NAME || null,
    sftp: env.CH_SFTP_HOST ? {
      host: env.CH_SFTP_HOST, port: Number(env.CH_SFTP_PORT) || 22, username: env.CH_SFTP_USERNAME,
      password: env.CH_SFTP_PASSWORD || undefined,
      privateKey: env.CH_SFTP_PRIVATE_KEY ? (existsSync(env.CH_SFTP_PRIVATE_KEY) ? readFileSync(env.CH_SFTP_PRIVATE_KEY) : env.CH_SFTP_PRIVATE_KEY) : undefined,
      uploadDir: env.CH_SFTP_UPLOAD_DIR || '/inbound', downloadDir: env.CH_SFTP_DOWNLOAD_DIR || '/outbound', archiveDir: env.CH_SFTP_ARCHIVE_DIR || null,
    } : null,
    realtime: env.CH_REALTIME_URL ? { url: env.CH_REALTIME_URL, username: env.CH_REALTIME_USERNAME, password: env.CH_REALTIME_PASSWORD, senderId: env.EDI_SUBMITTER_ID, receiverId: env.EDI_RECEIVER_ID } : null,
    sandboxDelaySeconds: Number(env.CH_SANDBOX_DELAY_SECONDS) || 0,
    pollMinutes: Number(env.CH_POLL_MINUTES) || 15,
  };
}

export function createClearinghouse({ db, config = clearinghouseConfig(), fetchImpl = globalThis.fetch, sftpClient } = {}) {
  const batch = config.mode === 'sandbox' ? sandboxBatch(db, config) : config.mode === 'sftp' && config.sftp ? sftpBatch(config.sftp, sftpClient) : null;
  const realtime = config.realtime ? coreRealtime(config.realtime, fetchImpl) : null;
  return {
    mode: config.mode,
    name: config.name || { sandbox: 'Sandbox clearinghouse', sftp: 'Clearinghouse (SFTP)', manual: 'Manual upload' }[config.mode] || config.mode,
    batch,
    realtime,
    pollMinutes: config.pollMinutes,
  };
}

// ---- SFTP batch transport ----
function sftpBatch(cfg, clientFactory) {
  const connect = async () => {
    let client;
    if (clientFactory) client = clientFactory();
    else {
      const { default: SftpClient } = await import('ssh2-sftp-client');
      client = new SftpClient();
    }
    await client.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, privateKey: cfg.privateKey, readyTimeout: 20_000 });
    return client;
  };
  return {
    transport: 'sftp',
    async submit({ filename, content }) {
      const client = await connect();
      try {
        await client.put(Buffer.from(content), `${cfg.uploadDir}/${filename}`);
      } finally {
        await client.end();
      }
      return { reference: filename };
    },
    async fetch() {
      const client = await connect();
      try {
        const files = (await client.list(cfg.downloadDir)).filter((f) => f.type === '-');
        const out = [];
        for (const f of files) out.push({ name: f.name, content: (await client.get(`${cfg.downloadDir}/${f.name}`)).toString('latin1') });
        return out;
      } finally {
        await client.end();
      }
    },
    // Move a processed file out of the download folder (only when an archive folder is configured).
    async done(names) {
      if (!cfg.archiveDir || !names.length) return;
      const client = await connect();
      try {
        for (const n of names) await client.rename(`${cfg.downloadDir}/${n}`, `${cfg.archiveDir}/${n}`);
      } finally {
        await client.end();
      }
    },
  };
}

// ---- CAQH CORE real-time (Phase II connectivity, HTTP MIME multipart) ----
function coreRealtime(cfg, fetchImpl) {
  const send = async (payloadType, x12) => {
    const form = new FormData();
    const fields = {
      PayloadType: payloadType, ProcessingMode: 'RealTime', PayloadID: randomUUID(), TimeStamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      UserName: cfg.username || '', Password: cfg.password || '', SenderID: cfg.senderId || '', ReceiverID: cfg.receiverId || '', CORERuleVersion: '2.2.0', Payload: x12,
    };
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await fetchImpl(cfg.url, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
    const type = res.headers.get('content-type') || '';
    let payload = null;
    let error = null;
    if (type.includes('multipart/form-data')) {
      const data = await res.formData();
      payload = data.get('Payload');
      if (data.get('ErrorCode') && data.get('ErrorCode') !== 'Success') error = `${data.get('ErrorCode')}: ${data.get('ErrorMessage') || ''}`.trim();
    } else {
      const text = await res.text();
      payload = text.slice(Math.max(0, text.indexOf('ISA')));
    }
    if (!res.ok || error || !payload || !String(payload).startsWith('ISA')) throw new HttpError(502, `Clearinghouse real-time request failed: ${error || `HTTP ${res.status}`}`);
    return String(payload);
  };
  return {
    eligibility: (x12) => send('X12_270_Request_005010X279A1', x12),
    claimStatus: (x12) => send('X12_276_Request_005010X212', x12),
  };
}

// ---- Sandbox: a simulated clearinghouse + payer ----
// Accepts every file (999), acknowledges each claim (277CA) and pays the insurance estimate on
// an 835, with the PPO write-off as a contractual adjustment; $0 estimates come back denied.
function sandboxBatch(db, config) {
  const later = (seconds) => new Date(Date.now() + seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return {
    transport: 'sandbox',
    async submit({ filename, content }) {
      const segs = parseX12(content);
      const gs = segs.find((s) => s.id === 'GS');
      const claims = [];
      let names = {};
      for (const s of segs) {
        if (s.id === 'NM1' && (s.e[1] === 'IL' || s.e[1] === 'QC')) names = { last_name: s.e[3], first_name: s.e[4] };
        if (s.id === 'CLM') claims.push({ control_number: s.e[1], ...names });
      }
      const now = later(0);
      await insert(db, 'edi_sandbox_mailbox', { name: `${filename}.999`, content: sandbox999({ groupControl: gs.e[6] }), available_at: now });
      const known = [];
      for (const c of claims) {
        const claim = await claimForControl(db, c.control_number);
        if (claim) known.push({ ...c, claim });
      }
      const pcn = (c) => `SBX${String(c.claim.id).padStart(8, '0')}`;
      await insert(db, 'edi_sandbox_mailbox', {
        name: `${filename}.277CA`, available_at: now,
        content: sandbox277({ claims: known.map((c) => ({ ...c, category: 'A2', code: '20', billed: c.claim.total_fee, paid: 0, payer_claim_number: pcn(c) })) }),
      });
      const byPayer = known.filter((c) => !c.claim.predetermination);
      if (byPayer.length) {
        await insert(db, 'edi_sandbox_mailbox', {
          name: `${filename}.835`, available_at: later(config.sandboxDelaySeconds),
          content: sandbox835({
            payee: await db.get('SELECT name, npi FROM practices WHERE id = ?', byPayer[0].claim.practice_id),
            eft: `SBX${Date.now()}`, date: new Date().toISOString().slice(0, 10),
            claims: byPayer.map((c) => {
              const paid = c.claim.estimated_amount;
              const writeOff = c.claim.write_off_estimate || 0;
              return { control_number: c.control_number, billed: c.claim.total_fee, paid, write_off: writeOff, patient: Math.max(0, c.claim.total_fee - writeOff - paid), payer_claim_number: pcn(c) };
            }),
          }),
        });
      }
      return { reference: filename };
    },
    async fetch() {
      const rows = await db.all("SELECT * FROM edi_sandbox_mailbox WHERE picked_up_at IS NULL AND available_at <= ? ORDER BY id", later(0));
      for (const r of rows) await db.run("UPDATE edi_sandbox_mailbox SET picked_up_at = datetime('now') WHERE id = ?", r.id);
      return rows.map((r) => ({ name: r.name, content: r.content }));
    },
    async done() {},
  };
}

// ---- Routing downloaded files ----
// Each file is processed once (by content hash) and filed under the practice it belongs to.
export async function processInbound(db, file) {
  const hash = createHash('sha256').update(file.content).digest('hex');
  if (await db.get('SELECT id FROM edi_inbox WHERE hash = ?', hash)) return { name: file.name, duplicate: true };
  const type = x12Type(file.content);
  let practiceId = null;
  let result = null;
  let error = null;
  try {
    if (type === '999') ({ practiceId, result } = await apply999(db, parse999(file.content)));
    else if (type === '277CA' || type === '277') ({ practiceId, result } = await apply277(db, parse277(file.content)));
    else if (type === '835') {
      practiceId = await practiceForEra(db, file.content);
      if (practiceId) {
        const era = await postEra(db, practiceId, file.content, { filename: file.name });
        result = { era_id: era.id, posted: era.claims.filter((c) => c.result === 'posted').length, denied: era.claims.filter((c) => c.result === 'denied').length, total_paid: era.total_paid };
      } else error = 'No matching claims — import it manually from Billing → Remittance';
    } else error = type ? `Unhandled transaction ${type}` : 'Not an X12 file';
  } catch (err) {
    error = err.message;
  }
  await insert(db, 'edi_inbox', { practice_id: practiceId, name: String(file.name).slice(0, 200), hash, type, content: file.content, result: result ? JSON.stringify(result) : null, error });
  return { name: file.name, type, practice_id: practiceId, result, error };
}

async function apply999(db, ack) {
  const b = await db.get("SELECT * FROM edi_batches WHERE control = ? ORDER BY id DESC LIMIT 1", String(Number(ack.group_control)));
  if (!b) return { practiceId: null, result: { unmatched_batch: ack.group_control } };
  const rejected = ack.status === 'rejected';
  await db.run("UPDATE edi_batches SET status = ?, message = ?, acknowledged_at = datetime('now') WHERE id = ?", ack.status, ack.errors.join('; ') || null, b.id);
  for (const id of JSON.parse(b.claim_ids)) {
    const claim = await db.get('SELECT * FROM claims WHERE id = ?', id);
    if (!claim) continue;
    if (rejected) {
      await db.run("UPDATE claims SET status = 'draft' WHERE id = ? AND status = 'submitted'", id);
      await claimEvent(db, claim, '999', 'rejected', `Clearinghouse rejected the file: ${ack.errors.join('; ') || 'format errors'} — fix and resend`);
    } else await claimEvent(db, claim, '999', 'received', 'Received by the clearinghouse');
  }
  return { practiceId: b.practice_id, result: { batch_id: b.id, status: ack.status } };
}

async function apply277(db, status) {
  let practiceId = null;
  const out = [];
  for (const c of status.claims) {
    const claim = await claimForControl(db, c.control_number);
    if (!claim) {
      out.push({ control_number: c.control_number, result: 'unmatched' });
      continue;
    }
    practiceId ??= claim.practice_id;
    if (c.payer_claim_number) await db.run('UPDATE claims SET payer_claim_number = ? WHERE id = ?', c.payer_claim_number, claim.id);
    const label = c.group === 'rejected' ? 'rejected' : c.group === 'accepted' ? 'accepted' : c.group;
    if (c.group === 'rejected' && claim.status === 'submitted') await db.run("UPDATE claims SET status = 'draft' WHERE id = ?", claim.id);
    await claimEvent(db, claim, status.kind, label, `${c.text}${c.category ? ` (${c.category})` : ''}${c.group === 'rejected' ? ' — fix and resend' : ''}`);
    out.push({ claim_id: claim.id, status: label });
  }
  return { practiceId, result: { kind: status.kind, claims: out } };
}

// Downloads and processes everything waiting at the clearinghouse. Safe to run from several servers
// (callers wrap it in runExclusive) and to re-run (files are de-duplicated by content).
export async function pollClearinghouse(db, ch) {
  if (!ch.batch) return [];
  const files = await ch.batch.fetch();
  const results = [];
  for (const f of files) results.push(await processInbound(db, f));
  await ch.batch.done(results.filter((r) => !r.error).map((r) => r.name));
  return results;
}
