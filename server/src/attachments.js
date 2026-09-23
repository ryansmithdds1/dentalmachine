import { randomBytes } from 'node:crypto';
import { HttpError } from './auth.js';

// Claim attachments (x-rays, perio charts, narratives, EOBs). Each gets an attachment control number
// that goes in the 837's PWK segment so the payer can match it to the claim.
//   ATTACHMENTS=sandbox  pretend vendor: accepts everything (default when EDI_MODE=sandbox)
//   ATTACHMENTS=manual   no vendor: print a cover sheet and mail or fax it (PWK transmission BM / FX)
//   ATTACHMENTS=http     a vendor or bridge (NEA/Vyne, DentalXChange…): ATTACHMENTS_URL + ATTACHMENTS_API_KEY
export const REPORT_TYPES = {
  RB: 'X-rays (radiology)', P6: 'Periodontal chart', OZ: 'Narrative / support data', EB: 'Other payer’s EOB',
  DG: 'Diagnostic report', B4: 'Referral', '06': 'Initial assessment', '77': 'Photos / support data for verification',
};
export const TRANSMISSION = { EL: 'Electronically', BM: 'By mail', FX: 'By fax' };

// Procedures payers commonly want attachments for.
const NEEDS = [
  [/^D27|^D29[5-7]|^D6[27]/, 'RB', 'Crowns, build-ups and bridges usually need a pre-op x-ray'],
  [/^D434[1-2]|^D4910|^D426/, 'P6', 'Scaling and root planing and perio surgery usually need a perio chart and x-rays'],
  [/^D33|^D34/, 'RB', 'Root canals usually need a pre-op x-ray'],
  [/^D72[1-5]/, 'RB', 'Surgical extractions usually need an x-ray'],
  [/^D60[1-6]/, 'RB', 'Implants usually need x-rays and a narrative'],
];

export function attachmentHints(items, attachments) {
  const have = new Set(attachments.map((a) => a.report_type));
  const out = [];
  for (const [re, type, why] of NEEDS) {
    const codes = items.filter((i) => re.test(i.code)).map((i) => i.code);
    if (codes.length && !have.has(type)) out.push(`${why} (${[...new Set(codes)].join(', ')})`);
  }
  return out;
}

export function attachmentConfig(env = process.env, ediMode = env.EDI_MODE) {
  const mode = env.ATTACHMENTS || (ediMode === 'sandbox' ? 'sandbox' : 'manual');
  return { mode, url: env.ATTACHMENTS_URL || null, key: env.ATTACHMENTS_API_KEY || null };
}

export function createAttachmentSender(cfg, fetchImpl = globalThis.fetch) {
  if (cfg.mode === 'sandbox') {
    return { mode: 'sandbox', electronic: true, async send() { return { control_number: `SBX${randomBytes(5).toString('hex').toUpperCase()}`, status: 'accepted' }; } };
  }
  if (cfg.mode === 'http') {
    if (!cfg.url) throw new Error('ATTACHMENTS=http needs ATTACHMENTS_URL');
    return {
      mode: 'http', electronic: true,
      async send(payload) {
        const res = await fetchImpl(cfg.url, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) }, body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.control_number) throw new HttpError(502, `Attachment service: ${data.error || data.message || res.status}`);
        return { control_number: String(data.control_number), status: data.status === 'rejected' ? 'rejected' : 'sent', vendor_ref: data.id || null };
      },
    };
  }
  // Manual: we number it ourselves; the cover sheet with this number goes with the mail or fax.
  return { mode: 'manual', electronic: false, async send({ claim_control }) { return { control_number: `${claim_control}A${randomBytes(3).toString('hex').toUpperCase()}`.slice(0, 50), status: 'sent' }; } };
}

