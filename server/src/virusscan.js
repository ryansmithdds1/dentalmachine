// Virus scanning for uploaded files, behind an adapter so the scanner can be swapped:
//  • ClamAV (clamd over TCP, INSTREAM) when CLAMAV_HOST is set (CLAMAV_PORT, default 3310);
//  • otherwise a sandbox that passes everything except the standard EICAR test file, so the "infected"
//    path can be tried in a demo without a real scanner.
// Each scan is logged in Settings → Connection activity (no file contents). An infected file is refused
// (422), audited and put in Needs attention; a scanner that can't be reached refuses the upload (503) and
// raises one Needs attention item, resolved by the next scan that works.
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { HttpError } from './auth.js';
import { logIntegration, raiseIssue, resolveIssue } from './issues.js';
import { audit } from './util.js';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export function createVirusScanner({ host = process.env.CLAMAV_HOST || null, port = Number(process.env.CLAMAV_PORT) || 3310, timeoutMs = 30_000 } = {}) {
  if (!host) {
    return {
      mode: 'sandbox', name: 'Sandbox (no virus scanner configured)',
      async scan(buf) {
        return buf.includes(Buffer.from(EICAR)) ? { clean: false, signature: 'EICAR-Test-File (sandbox)' } : { clean: true };
      },
    };
  }
  return {
    mode: 'clamav', name: `ClamAV (${host}:${port})`,
    scan: (buf) => clamdScan({ host, port, timeoutMs }, buf),
  };
}

// clamd's INSTREAM: "zINSTREAM\0", then chunks of [4-byte big-endian length][bytes], then a zero length.
// It answers "stream: OK", "stream: <signature> FOUND" or "<message> ERROR".
export function clamdScan({ host, port, timeoutMs = 30_000 }, buf) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let answer = '';
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(v);
    };
    socket.setTimeout(timeoutMs, () => done(reject, new Error('The virus scanner did not answer in time')));
    socket.on('error', (err) => done(reject, new Error(`The virus scanner can’t be reached (${err.code || err.message})`)));
    socket.on('data', (d) => {
      answer += d.toString('latin1');
      if (answer.includes('\0') || answer.includes('\n')) finish();
    });
    socket.on('end', () => finish());
    const finish = () => {
      const line = answer.replace(/\0/g, '').trim();
      if (/\bOK$/.test(line)) return done(resolve, { clean: true });
      const found = /^(?:stream|[^:]*):\s*(.+?)\s+FOUND$/.exec(line);
      if (found) return done(resolve, { clean: false, signature: found[1].slice(0, 120) });
      return done(reject, new Error(`The virus scanner answered: ${line.slice(0, 120) || 'nothing'}`));
    };
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const CHUNK = 64 * 1024;
      for (let i = 0; i < buf.length; i += CHUNK) {
        const part = buf.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        socket.write(len);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

// Scans an upload before it's stored. ctx: { req (for the audit), practiceId, patientId, filename }.
export async function checkUpload(db, scanner, buf, { req, practiceId, patientId = null, filename = 'file' }) {
  if (!scanner) return 'not_scanned';
  const started = Date.now();
  let out;
  try {
    out = await scanner.scan(buf);
  } catch (err) {
    if (scanner.mode !== 'sandbox') {
      await logIntegration(db, { practiceId, service: 'ClamAV', operation: 'scan', ok: false, ms: Date.now() - started, error: err.message });
    }
    await raiseIssue(db, {
      practiceId, kind: 'integration', key: 'virusscan:down', severity: 'high', role: 'admin',
      title: 'Uploads are paused: the virus scanner can’t be reached', detail: `${scanner.name}: ${err.message}. Files can’t be added to charts until it answers again.`,
    });
    throw new HttpError(503, 'The virus scanner isn’t answering, so the file wasn’t saved — try again in a minute (the office has been alerted)');
  }
  if (scanner.mode !== 'sandbox') await logIntegration(db, { practiceId, service: 'ClamAV', operation: 'scan', ok: true, ms: Date.now() - started });
  await resolveIssue(db, practiceId, 'virusscan:down', 'Resolved automatically: the virus scanner answered again');
  if (out.clean) return scanner.mode === 'sandbox' ? 'not_scanned' : 'clean';
  const sha = createHash('sha256').update(buf).digest('hex');
  await audit(db, req, 'document.virus_blocked', patientId ? 'patients' : 'documents', patientId, {
    patient_id: patientId, filename, signature: out.signature, sha256: sha, scanner: scanner.mode,
  });
  await raiseIssue(db, {
    practiceId, kind: 'records', key: `virus:${sha.slice(0, 32)}`, severity: 'high', role: 'admin', patientId,
    title: `A file with a virus was blocked: ${filename}`,
    detail: `${out.signature} — found by ${scanner.name}. The file was not saved. Check the computer it came from${req?.user?.name ? ` (uploaded by ${req.user.name})` : ''}.`,
  });
  throw new HttpError(422, `This file contains a virus (${out.signature}) and was not saved. The office manager has been alerted.`, { virus: true, signature: out.signature });
}
