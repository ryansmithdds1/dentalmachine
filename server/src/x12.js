// ANSI ASC X12 5010 builders/parsers for dental EDI:
//   837D claims (005010X224A2), 270/271 eligibility (005010X279A1), 835 remittance (005010X221A1).
// Segment terminator "~", element separator "*", component separator ":".

const clean = (v, max = 60) => String(v ?? '').toUpperCase().replace(/[~*:^]/g, ' ').replace(/[^\x20-\x7E]/g, '').trim().slice(0, max);
const pad = (v, n) => clean(v, n).padEnd(n, ' ');
const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '');
const money = (cents) => (cents / 100).toFixed(2).replace(/\.00$/, '');
const d8 = (date) => String(date || '').slice(0, 10).replace(/-/g, '');

function splitName(full) {
  const parts = clean(full).split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { last: parts[0] || '', first: '' };
  return { last: parts.at(-1), first: parts.slice(0, -1).join(' ') };
}

const PAT_REL = { spouse: '01', child: '19', other: 'G8' };
const GENDER = (g) => ({ female: 'F', male: 'M' })[String(g || '').toLowerCase()] || 'U';

function envelope({ functionalId, version, senderId, receiverId, control, now, body }) {
  const date = now.toISOString();
  const yymmdd = date.slice(2, 10).replace(/-/g, '');
  const ccyymmdd = date.slice(0, 10).replace(/-/g, '');
  const hhmm = date.slice(11, 16).replace(':', '');
  const ctl = String(control).padStart(9, '0');
  const segs = [
    `ISA*00*${' '.repeat(10)}*00*${' '.repeat(10)}*ZZ*${pad(senderId, 15)}*ZZ*${pad(receiverId, 15)}*${yymmdd}*${hhmm}*^*00501*${ctl}*0*P*:`,
    `GS*${functionalId}*${clean(senderId, 15)}*${clean(receiverId, 15)}*${ccyymmdd}*${hhmm}*${control}*X*${version}`,
    ...body,
    `GE*1*${control}`,
    `IEA*1*${ctl}`,
  ];
  return `${segs.join('~\n')}~\n`;
}

function transaction(type, version, segments, stControl = '0001') {
  const all = [`ST*${type}*${stControl}*${version}`, ...segments];
  all.push(`SE*${all.length + 1}*${stControl}`);
  return all;
}

// ---- 837D ----
// claims: [{ claim, patient, policy, carrier, items: [{code, fee, tooth, surfaces, completed_at, provider_name, provider_npi}] }]
export function build837D({ practice, claims, senderId, receiverId, control = 1, now = new Date(), taxonomy = '1223G0001X' }) {
  const segs = [
    `BHT*0019*00*${control}*${d8(now.toISOString())}*${now.toISOString().slice(11, 16).replace(':', '')}*CH`,
    `NM1*41*2*${clean(practice.name)}*****46*${clean(senderId, 80)}`,
    `PER*IC*${clean(practice.name, 60)}*TE*${digitsOnly(practice.phone) || '0000000000'}`,
    `NM1*40*2*${clean(receiverId)}*****46*${clean(receiverId, 80)}`,
  ];
  let hl = 0;
  const billingHl = ++hl;
  segs.push(
    `HL*${billingHl}**20*1`,
    `PRV*BI*PXC*${taxonomy}`,
    `NM1*85*2*${clean(practice.name)}*****XX*${digitsOnly(practice.npi)}`,
    `N3*${clean(practice.address, 55)}`,
    `N4*${clean(practice.city, 30)}*${clean(practice.state, 2)}*${digitsOnly(practice.zip)}`,
    `REF*EI*${digitsOnly(practice.tax_id)}`,
  );
  for (const { claim, patient, policy, carrier, items } of claims) {
    const isSelf = policy.relationship === 'self';
    const subHl = ++hl;
    const sub = splitName(policy.subscriber_name);
    segs.push(
      `HL*${subHl}*${billingHl}*22*${isSelf ? 0 : 1}`,
      `SBR*${policy.priority === 'secondary' ? 'S' : 'P'}*${isSelf ? '18' : ''}*${clean(policy.group_number, 50)}******CI`,
      `NM1*IL*1*${sub.last}*${sub.first}****MI*${clean(policy.subscriber_id, 80)}`,
    );
    if (isSelf) {
      segs.push(`N3*${clean(patient.address, 55) || 'UNKNOWN'}`, `N4*${clean(patient.city, 30) || 'UNKNOWN'}*${clean(patient.state, 2) || 'XX'}*${digitsOnly(patient.zip) || '00000'}`);
      if (patient.dob) segs.push(`DMG*D8*${d8(patient.dob)}*${GENDER(patient.gender)}`);
    } else if (policy.subscriber_dob) {
      segs.push(`DMG*D8*${d8(policy.subscriber_dob)}*U`);
    }
    segs.push(`NM1*PR*2*${clean(carrier.name)}*****PI*${clean(carrier.payer_id || 'UNKNOWN', 80)}`);
    if (!isSelf) {
      segs.push(
        `HL*${++hl}*${subHl}*23*0`,
        `PAT*${PAT_REL[policy.relationship] || 'G8'}`,
        `NM1*QC*1*${clean(patient.last_name)}*${clean(patient.first_name)}`,
        `N3*${clean(patient.address, 55) || 'UNKNOWN'}`,
        `N4*${clean(patient.city, 30) || 'UNKNOWN'}*${clean(patient.state, 2) || 'XX'}*${digitsOnly(patient.zip) || '00000'}`,
        `DMG*D8*${d8(patient.dob)}*${GENDER(patient.gender)}`,
      );
    }
    segs.push(`CLM*${clean(claim.control_number, 20)}*${money(claim.total_fee)}***11:B:1*Y*A*Y*Y`);
    const rendering = items.find((i) => i.provider_npi);
    if (rendering) {
      const rn = splitName(rendering.provider_name.replace(/,.*$/, '').replace(/^DR\.?\s*/i, ''));
      segs.push(`NM1*82*1*${rn.last}*${rn.first}****XX*${digitsOnly(rendering.provider_npi)}`, `PRV*PE*PXC*${taxonomy}`);
    }
    items.forEach((item, i) => {
      segs.push(`LX*${i + 1}`, `SV3*AD:${clean(item.code, 5)}*${money(item.fee)}****1`);
      if (item.tooth) segs.push(`TOO*JP*${clean(item.tooth, 2)}${item.surfaces ? `*${item.surfaces.split('').join(':')}` : ''}`);
      if (item.completed_at) segs.push(`DTP*472*D8*${d8(item.completed_at)}`);
    });
  }
  return envelope({ functionalId: 'HC', version: '005010X224A2', senderId, receiverId, control, now, body: transaction('837', '005010X224A2', segs) });
}

// ---- 270 ----
export function build270({ practice, patient, policy, carrier, senderId, receiverId, control = 1, now = new Date(), trace }) {
  const sub = splitName(policy.subscriber_name);
  const isSelf = policy.relationship === 'self';
  const segs = [
    `BHT*0022*13*${clean(trace, 30)}*${d8(now.toISOString())}*${now.toISOString().slice(11, 16).replace(':', '')}`,
    'HL*1**20*1',
    `NM1*PR*2*${clean(carrier.name)}*****PI*${clean(carrier.payer_id || 'UNKNOWN', 80)}`,
    'HL*2*1*21*1',
    `NM1*1P*2*${clean(practice.name)}*****XX*${digitsOnly(practice.npi)}`,
    `HL*3*2*22*${isSelf ? 0 : 1}`,
    `TRN*1*${clean(trace, 30)}*9${digitsOnly(practice.tax_id).padEnd(9, '0').slice(0, 9)}`,
    `NM1*IL*1*${sub.last}*${sub.first}****MI*${clean(policy.subscriber_id, 80)}`,
  ];
  if (isSelf && patient.dob) segs.push(`DMG*D8*${d8(patient.dob)}`);
  segs.push(`DTP*291*D8*${d8(now.toISOString())}`);
  if (!isSelf) {
    segs.push('HL*4*3*23*0', `NM1*03*1*${clean(patient.last_name)}*${clean(patient.first_name)}`);
    if (patient.dob) segs.push(`DMG*D8*${d8(patient.dob)}`);
    segs.push(`DTP*291*D8*${d8(now.toISOString())}`);
  }
  segs.push('EQ*35');
  return envelope({ functionalId: 'HS', version: '005010X279A1', senderId, receiverId, control, now, body: transaction('270', '005010X279A1', segs) });
}

// ---- Parsing ----
export function parseX12(text) {
  const raw = String(text || '').replace(/^﻿/, '').trimStart();
  if (!raw.startsWith('ISA')) throw new Error('Not an X12 file (missing ISA header)');
  const elementSep = raw[3];
  const segmentSep = raw[105];
  const componentSep = raw[104];
  return raw.split(segmentSep).map((s) => s.replace(/[\r\n]/g, '').trim()).filter(Boolean).map((s) => {
    const els = s.split(elementSep);
    return { id: els[0], e: els, c: (i) => (els[i] || '').split(componentSep) };
  });
}

const SERVICE_TIER = { 23: 'preventive', 41: 'preventive', 25: 'basic', 26: 'basic', 24: 'basic', 40: 'basic', 36: 'major', 39: 'major', 27: 'major', 38: 'ortho', 35: 'dental' };
const cents = (v) => Math.round(Number(v || 0) * 100);

export function parse271(text) {
  const segs = parseX12(text);
  if (!segs.some((s) => s.id === 'ST' && s.e[1] === '271')) throw new Error('Not a 271 eligibility response');
  const out = { active: null, plan_name: null, plan_begin: null, deductible: null, deductible_remaining: null, annual_max: null, max_remaining: null, coinsurance: {}, messages: [], errors: [] };
  for (const s of segs) {
    if (s.id === 'AAA') out.errors.push({ code: s.e[3], followup: s.e[4] });
    if (s.id === 'MSG') out.messages.push(s.e[1]);
    if (s.id === 'DTP' && (s.e[1] === '346' || s.e[1] === '356') && !out.plan_begin) out.plan_begin = `${s.e[3].slice(0, 4)}-${s.e[3].slice(4, 6)}-${s.e[3].slice(6, 8)}`;
    if (s.id !== 'EB') continue;
    const [info, level, services, , planName, period, amount, percent] = s.e.slice(1); // EB01..EB08
    const inNetwork = s.e[12];
    if (inNetwork === 'N') continue; // prefer in-network figures
    if (info === '1') {
      out.active = true;
      if (planName) out.plan_name = planName;
    }
    if (info === '6') out.active = false;
    if (info === 'C' && amount && (!level || level === 'IND')) {
      if (period === '29') out.deductible_remaining = cents(amount);
      else out.deductible = cents(amount);
    }
    if (info === 'F' && amount && (!level || level === 'IND')) {
      if (period === '29') out.max_remaining = cents(amount);
      else if (!period || period === '23' || period === '25') out.annual_max = cents(amount);
    }
    if (info === 'A' && percent !== undefined && percent !== '') {
      const patientShare = Number(percent);
      const insurer = Math.round((1 - (patientShare > 1 ? patientShare / 100 : patientShare)) * 100);
      for (const code of (services || '').split(/[\^:]/)) {
        const tier = SERVICE_TIER[code];
        if (tier && out.coinsurance[tier] === undefined) out.coinsurance[tier] = insurer;
      }
    }
  }
  return out;
}

export function parse835(text) {
  const segs = parseX12(text);
  if (!segs.some((s) => s.id === 'ST' && s.e[1] === '835')) throw new Error('Not an 835 remittance file');
  const era = { payer_name: null, check_number: null, payment_date: null, total_paid: 0, claims: [] };
  let claim = null;
  let inPayer = false;
  for (const s of segs) {
    switch (s.id) {
      case 'BPR':
        era.total_paid = cents(s.e[2]);
        if (s.e[16]) era.payment_date = `${s.e[16].slice(0, 4)}-${s.e[16].slice(4, 6)}-${s.e[16].slice(6, 8)}`;
        break;
      case 'TRN':
        era.check_number = s.e[2];
        break;
      case 'N1':
        inPayer = s.e[1] === 'PR';
        if (inPayer) era.payer_name = s.e[2];
        break;
      case 'CLP':
        claim = {
          control_number: s.e[1], status_code: s.e[2], billed: cents(s.e[3]), paid: cents(s.e[4]), patient_responsibility: cents(s.e[5]),
          payer_claim_number: s.e[7] || null, adjustments: [], services: [],
        };
        era.claims.push(claim);
        break;
      case 'CAS':
        if (!claim) break;
        // Groups of (reason, amount, quantity) triplets after the group code.
        for (let i = 2; i < s.e.length; i += 3) {
          if (s.e[i]) (claim.services.at(-1)?.adjustments ?? claim.adjustments).push({ group: s.e[1], reason: s.e[i], amount: cents(s.e[i + 1]) });
        }
        break;
      case 'SVC':
        if (claim) claim.services.push({ code: s.c(1)[1] || s.e[1], billed: cents(s.e[2]), paid: cents(s.e[3]), adjustments: [] });
        break;
      default:
    }
  }
  for (const c of era.claims) {
    const all = [...c.adjustments, ...c.services.flatMap((sv) => sv.adjustments)];
    c.contractual = all.filter((a) => a.group === 'CO').reduce((s, a) => s + a.amount, 0);
    c.other_adjustments = all.filter((a) => a.group === 'OA' || a.group === 'PI').reduce((s, a) => s + a.amount, 0);
    c.reason_codes = [...new Set(all.map((a) => `${a.group}-${a.reason}`))];
    c.status = { 1: 'processed_primary', 2: 'processed_secondary', 3: 'processed_tertiary', 4: 'denied', 22: 'reversal', 23: 'not_our_claim' }[c.status_code] || 'other';
  }
  return era;
}

// Plain-language meanings for the most common CARC reason codes shown on ERAs.
export const CARC = {
  1: 'Deductible', 2: 'Coinsurance', 3: 'Copay', 4: 'Procedure code inconsistent with modifier', 18: 'Duplicate claim',
  27: 'Coverage terminated', 29: 'Filing limit expired', 45: 'Charge exceeds fee schedule/maximum allowable', 96: 'Non-covered charge',
  97: 'Included in another service', 119: 'Benefit maximum reached', 187: 'Consumer spending account payment', 204: 'Not covered under current benefit plan',
};
