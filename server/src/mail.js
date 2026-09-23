import { HttpError } from './auth.js';

// Printed statements mailed by a print-and-mail service.
//   MAIL_DRIVER=none (default) statements without email are printed at the office.
//   MAIL_DRIVER=log  record letters without mailing them (development / testing).
//   MAIL_DRIVER=lob  Lob (lob.com) prints, stuffs and mails each letter (LOB_API_KEY; test_ keys never mail).
export function createMailer({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const mode = env.MAIL_DRIVER || 'none';
  if (mode === 'lob') {
    if (!env.LOB_API_KEY) throw new Error('MAIL_DRIVER=lob needs LOB_API_KEY');
    return {
      mode, enabled: true, name: 'Lob',
      async sendLetter({ to, from, html, description, idempotencyKey }) {
        const res = await fetchImpl('https://api.lob.com/v1/letters', {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${env.LOB_API_KEY}:`).toString('base64')}`, 'Content-Type': 'application/json',
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          body: JSON.stringify({
            description, to: lobAddress(to), from: lobAddress(from), file: html, color: false, double_sided: true,
            address_placement: 'top_first_page', use_type: 'operational', mail_type: 'usps_first_class',
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new HttpError(502, `Lob: ${data.error?.message || res.status}`);
        return { reference: data.id, expected_delivery_date: data.expected_delivery_date || null };
      },
    };
  }
  if (mode === 'log') {
    return { mode, enabled: true, name: 'Mail log (not sent)', async sendLetter({ to }) { return { reference: `log_${Date.now().toString(36)}_${String(to.zip || '').slice(0, 5)}`, expected_delivery_date: null }; } };
  }
  return { mode: 'none', enabled: false, name: 'Print at the office' };
}

const lobAddress = (a) => ({
  name: String(a.name).slice(0, 40), address_line1: a.address, ...(a.address2 ? { address_line2: a.address2 } : {}),
  address_city: a.city, address_state: a.state, address_zip: a.zip, address_country: 'US',
});

export const mailable = (p) => !!(p?.address && p.city && p.state && /^\d{5}/.test(String(p.zip || '')));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (d) => (d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

// A one-to-two page letter-size statement. The top-left of page 1 is left clear for the
// mailing address window (the mail service prints the address there).
export function statementHtml({ practice, account, entries, previousBalance, balance, pendingInsurance = 0, pendingWriteOff = 0, portalUrl, statementDate }) {
  const due = Math.max(0, balance - pendingInsurance - pendingWriteOff);
  const rows = entries.map((e) => `<tr><td>${esc(date(e.entry_date))}</td><td>${esc(e.patient_first_name || '')}</td><td>${esc(e.description || e.type)}</td><td class="n">${e.amount > 0 ? money(e.amount) : ''}</td><td class="n">${e.amount < 0 ? money(-e.amount) : ''}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: 8.5in 11in; margin: 0 }
    body { font-family: Helvetica, Arial, sans-serif; font-size: 10pt; color: #111; margin: 0 }
    .page { padding: 0.5in 0.6in }
    .top { height: 3.2in; position: relative }
    .practice { position: absolute; right: 0; top: 0; text-align: right }
    .practice h1 { font-size: 15pt; margin: 0 0 4px }
    .due { position: absolute; right: 0; top: 1.35in; border: 2px solid #0f766e; border-radius: 8px; padding: 10px 14px; width: 2.9in }
    .due b { font-size: 18pt; color: #0f766e }
    table { width: 100%; border-collapse: collapse; margin-top: 10px }
    th, td { text-align: left; padding: 5px 4px; border-bottom: 1px solid #ddd }
    th { font-size: 8.5pt; text-transform: uppercase; color: #555 }
    .n { text-align: right; white-space: nowrap }
    .sum td { font-weight: bold; border-bottom: none }
    .pay { margin-top: 18px; padding: 10px 12px; background: #f3f7f6; border-radius: 6px }
  </style></head><body><div class="page">
    <div class="top">
      <div class="practice"><h1>${esc(practice.name)}</h1>${esc(practice.address)}<br>${esc(practice.city)}, ${esc(practice.state)} ${esc(practice.zip)}<br>${esc(practice.phone || '')}</div>
      <div class="due">Statement date: ${esc(date(statementDate))}<br>Account: ${esc(account.first_name)} ${esc(account.last_name)} (#${account.id})<br>
        <span>Amount due now</span><br><b>${money(due)}</b>${pendingInsurance > 0 ? `<br><small>${money(pendingInsurance)} is still pending with insurance</small>` : ''}${pendingWriteOff > 0 ? `<br><small>${money(pendingWriteOff)} in-network discount to be applied</small>` : ''}</div>
    </div>
    <table><thead><tr><th>Date</th><th>Patient</th><th>Description</th><th class="n">Charges</th><th class="n">Payments &amp; credits</th></tr></thead>
      <tbody><tr><td colspan="3">Previous balance</td><td class="n">${money(previousBalance)}</td><td></td></tr>${rows}
      <tr class="sum"><td colspan="3">Account balance</td><td class="n" colspan="2">${money(balance)}</td></tr></tbody></table>
    <div class="pay"><b>Ways to pay:</b> ${portalUrl ? `online at ${esc(portalUrl)} · ` : ''}by phone at ${esc(practice.phone || 'the office')} · or at your next visit.
      Questions about your bill? Call us — we're happy to help or set up a payment plan.</div>
  </div></body></html>`;
}
