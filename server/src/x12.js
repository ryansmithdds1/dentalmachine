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
const REL_2320 = { spouse: '01', child: '19', other: 'G8' };
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
const ORAL_CAVITY = { U: '01', L: '02', UR: '10', UL: '20', LL: '30', LR: '40' };

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
  for (const { claim, patient, policy, carrier, items, primary: other, attachments = [] } of claims) {
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
    // CLM05-3 is the claim frequency: 1 original, 7 replacement (corrected), 8 void.
    // CLM19 = PB marks a predetermination of benefits (pre-authorization) rather than a claim for payment.
    const freq = ['7', '8'].includes(String(claim.frequency_code)) ? claim.frequency_code : '1';
    segs.push(`CLM*${clean(claim.control_number, 20)}*${money(claim.total_fee)}***11:B:${freq}*Y*A*Y*Y${claim.predetermination ? `${'*'.repeat(10)}PB` : ''}`);
    // Attachments (x-rays, perio charts, narratives) sent separately, matched by their control numbers.
    for (const a of attachments) if (a.control_number) segs.push(`PWK*${a.report_type}*${a.transmission}***AC*${clean(a.control_number, 50)}`);
    if (claim.preauth_number) segs.push(`REF*G1*${clean(claim.preauth_number, 50)}`);
    if (freq !== '1' && claim.original_reference) segs.push(`REF*F8*${clean(claim.original_reference, 50)}`);
    if (claim.remarks) segs.push(`NTE*ADD*${clean(claim.remarks, 80)}`);
    const rendering = items.find((i) => i.provider_npi);
    if (rendering) {
      const rn = splitName(rendering.provider_name.replace(/,.*$/, '').replace(/^DR\.?\s*/i, ''));
      segs.push(`NM1*82*1*${rn.last}*${rn.first}****XX*${digitsOnly(rendering.provider_npi)}`, `PRV*PE*PXC*${taxonomy}`);
    }
    // Coordination of benefits: a secondary claim reports the primary payer and what it paid (loops 2320/2330).
    if (other) {
      const osub = splitName(other.policy.subscriber_name);
      segs.push(
        `SBR*P*${other.policy.relationship === 'self' ? '18' : REL_2320[other.policy.relationship] || 'G8'}*${clean(other.policy.group_number, 50)}******CI`,
        `AMT*D*${money(other.paid)}`,
        'OI***Y***Y',
        `NM1*IL*1*${osub.last}*${osub.first}****MI*${clean(other.policy.subscriber_id, 80)}`,
        `NM1*PR*2*${clean(other.carrier.name)}*****PI*${clean(other.carrier.payer_id || 'UNKNOWN', 80)}`,
      );
      if (other.paid_date) segs.push(`DTP*573*D8*${d8(other.paid_date)}`);
    }
    items.forEach((item, i) => {
      // SV304: the oral cavity area for quadrant and arch procedures.
      segs.push(`LX*${i + 1}`, `SV3*AD:${clean(item.code, 5)}*${money(item.fee)}**${ORAL_CAVITY[item.area] || ''}**1`);
      if (item.tooth) segs.push(`TOO*JP*${clean(item.tooth, 2)}${item.surfaces ? `*${item.surfaces.split('').join(':')}` : ''}`);
      if (item.completed_at) segs.push(`DTP*472*D8*${d8(item.completed_at)}`);
      // Line adjudication by the primary payer (loop 2430).
      const adj = other?.lines?.find((l) => l.procedure_id === item.procedure_id);
      if (adj) {
        segs.push(`SVD*${clean(other.carrier.payer_id || 'UNKNOWN', 80)}*${money(adj.paid_amount)}*AD:${clean(item.code, 5)}**1`);
        const groups = {};
        for (const a of adj.adjustments || []) (groups[a.group] ||= []).push(a);
        if (!adj.adjustments?.length && adj.adjusted_amount) groups.CO = [{ reason: '45', amount: adj.adjusted_amount }];
        for (const [g, list] of Object.entries(groups)) segs.push(`CAS*${g}*${list.slice(0, 6).map((a) => `${a.reason}*${money(a.amount)}`).join('**')}`);
        if (other.paid_date) segs.push(`DTP*573*D8*${d8(other.paid_date)}`);
      }
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
  const out = {
    active: null, plan_name: null, plan_begin: null, deductible: null, deductible_remaining: null, annual_max: null, max_remaining: null, coinsurance: {},
    family_deductible: null, family_deductible_remaining: null, ortho_max: null, ortho_remaining: null,
    // Out-of-network figures (EB12 = N), for patients who see the practice as out of network.
    out_of_network: { deductible: null, deductible_remaining: null, annual_max: null, max_remaining: null, coinsurance: {} },
    frequencies: [], history: [], messages: [], errors: [],
  };
  // Frequency limits and service history belong to the EB they follow: its procedure codes (EB13, "AD:D1110")
  // and HSD ("2 per service year", "1 per 36 months") or DTP*304 (last done).
  let procs = [];
  const d8 = (v) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  for (const s of segs) {
    if (s.id === 'AAA') out.errors.push({ code: s.e[3], followup: s.e[4] });
    if (s.id === 'MSG') out.messages.push(s.e[1]);
    if (s.id === 'HSD' && procs.length && Number(s.e[2]) > 0) {
      const [qty, unit, n] = [Number(s.e[2]), s.e[5], Number(s.e[6]) || 1];
      const months = unit === '21' ? n * 12 : unit === '34' ? n : null;
      if (months || ['22', '23'].includes(unit)) out.frequencies.push({ codes: procs, count: qty, ...(months ? { months } : { per: 'benefit_year' }) });
    }
    if (s.id === 'DTP' && s.e[1] === '304' && procs.length && /^\d{8}$/.test(s.e[3] || '')) out.history.push({ codes: procs, date: d8(s.e[3]) });
    if (s.id === 'DTP' && (s.e[1] === '346' || s.e[1] === '356') && !out.plan_begin) out.plan_begin = `${s.e[3].slice(0, 4)}-${s.e[3].slice(4, 6)}-${s.e[3].slice(6, 8)}`;
    if (s.id !== 'EB') continue;
    procs = String(s.e[13] || '').split(/[:^>]/).filter((c) => /^D\d{4}$/.test(c));
    const [info, level, services, , planName, period, amount, percent] = s.e.slice(1); // EB01..EB08
    const inNetwork = s.e[12];
    const serviceList = String(services || '').split(/[\^:]/);
    if (inNetwork === 'N') {
      // Kept separately; the main figures are in-network.
      const oon = out.out_of_network;
      if (info === 'C' && amount && (!level || level === 'IND')) oon[period === '29' ? 'deductible_remaining' : 'deductible'] ??= cents(amount);
      if (info === 'F' && amount && (!level || level === 'IND') && !serviceList.includes('38')) {
        if (period === '29') oon.max_remaining ??= cents(amount);
        else if (!period || period === '23' || period === '25') oon.annual_max ??= cents(amount);
      }
      if (info === 'A' && percent !== undefined && percent !== '') {
        const share = Number(percent);
        for (const code of serviceList) { const tier = SERVICE_TIER[code]; if (tier && oon.coinsurance[tier] === undefined) oon.coinsurance[tier] = Math.round((1 - (share > 1 ? share / 100 : share)) * 100); }
      }
      continue;
    }
    // Orthodontics: a lifetime maximum (period 32) and what's left of it (33).
    if (info === 'F' && amount && serviceList.includes('38')) {
      if (period === '33' || period === '29') out.ortho_remaining ??= cents(amount);
      else out.ortho_max ??= cents(amount);
      continue;
    }
    if (info === 'C' && amount && level === 'FAM') {
      if (period === '29') out.family_deductible_remaining ??= cents(amount);
      else out.family_deductible ??= cents(amount);
      continue;
    }
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

// Splits a file into its ST…SE transaction sets (one file can carry several checks or batches).
export function transactions(segs, type) {
  const out = [];
  let cur = null;
  for (const s of segs) {
    if (s.id === 'ST') cur = s.e[1] === type ? [s] : null;
    else if (cur) {
      cur.push(s);
      if (s.id === 'SE') {
        out.push(cur);
        cur = null;
      }
    }
  }
  return out;
}

// Every remittance (check/EFT) in an 835 file.
export function parse835All(text) {
  const txs = transactions(parseX12(text), '835');
  if (!txs.length) throw new Error('Not an 835 remittance file');
  return txs.map(parse835Segments);
}
export const parse835 = (text) => parse835All(text)[0];

function parse835Segments(segs) {
  const era = { payer_name: null, check_number: null, payment_date: null, total_paid: 0, claims: [], provider_adjustments: [] };
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
      case 'PLB':
        // Provider-level adjustments (interest, recoupments, withholds): pairs of reason:reference and amount.
        for (let i = 3; i < s.e.length; i += 2) {
          if (!s.e[i]) continue;
          const [reason, reference] = s.e[i].split(/[:>]/);
          era.provider_adjustments.push({ reason, reference: reference || null, amount: cents(s.e[i + 1]) });
        }
        break;
      default:
    }
  }
  for (const c of era.claims) {
    const all = [...c.adjustments, ...c.services.flatMap((sv) => sv.adjustments)];
    c.contractual = all.filter((a) => a.group === 'CO').reduce((s, a) => s + a.amount, 0);
    c.other_adjustments = all.filter((a) => a.group === 'OA' || a.group === 'PI').reduce((s, a) => s + a.amount, 0);
    // Patient-responsibility reason 1 is the deductible the payer applied.
    c.deductible = all.filter((a) => a.group === 'PR' && a.reason === '1').reduce((s, a) => s + a.amount, 0);
    c.reason_codes = [...new Set(all.map((a) => `${a.group}-${a.reason}`))];
    for (const sv of c.services) {
      sv.patient_resp = sv.adjustments.filter((a) => a.group === 'PR').reduce((s, a) => s + a.amount, 0);
      sv.write_off = Math.max(0, sv.billed - sv.paid - sv.patient_resp);
    }
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

// ---- 276 claim status request (005010X212) ----
// bundle: { claim, patient, policy, carrier, items } as for the 837D.
export function build276({ practice, bundle, senderId, receiverId, control = 1, now = new Date(), trace }) {
  const { claim, patient, policy, carrier, items } = bundle;
  const isSelf = policy.relationship === 'self';
  const sub = splitName(policy.subscriber_name);
  const dates = items.map((i) => d8(i.completed_at)).filter(Boolean).sort();
  const segs = [
    `BHT*0010*13*${clean(trace, 50)}*${d8(now.toISOString())}*${now.toISOString().slice(11, 16).replace(':', '')}`,
    'HL*1**20*1', `NM1*PR*2*${clean(carrier.name)}*****PI*${clean(carrier.payer_id || 'UNKNOWN', 80)}`,
    'HL*2*1*21*1', `NM1*41*2*${clean(practice.name)}*****46*${clean(senderId, 80)}`,
    'HL*3*2*19*1', `NM1*1P*2*${clean(practice.name)}*****XX*${digitsOnly(practice.npi)}`,
    `HL*4*3*22*${isSelf ? 0 : 1}`,
  ];
  if (isSelf && patient.dob) segs.push(`DMG*D8*${d8(patient.dob)}*${GENDER(patient.gender)}`);
  segs.push(`NM1*IL*1*${sub.last}*${sub.first}****MI*${clean(policy.subscriber_id, 80)}`);
  const claimSegs = [
    `TRN*1*${clean(claim.control_number, 50)}`,
    ...(claim.payer_claim_number ? [`REF*1K*${clean(claim.payer_claim_number, 50)}`] : []),
    `AMT*T3*${money(claim.total_fee)}`,
    ...(dates.length ? [`DTP*472*RD8*${dates[0]}-${dates.at(-1)}`] : []),
  ];
  if (isSelf) segs.push(...claimSegs);
  else {
    segs.push('HL*5*4*23', `DMG*D8*${d8(patient.dob)}*${GENDER(patient.gender)}`, `NM1*QC*1*${clean(patient.last_name)}*${clean(patient.first_name)}`, ...claimSegs);
  }
  return envelope({ functionalId: 'HR', version: '005010X212', senderId, receiverId, control, now, body: transaction('276', '005010X212', segs) });
}

// ---- 999 implementation acknowledgment ----
// A 999 can acknowledge several functional groups (batches); `groups` lists each one.
export function parse999(text) {
  const txs = transactions(parseX12(text), '999');
  if (!txs.length) throw new Error('Not a 999 acknowledgment');
  const groups = txs.map(parse999Segments);
  return { ...groups[0], groups };
}

function parse999Segments(segs) {
  const out = { group_control: null, functional_id: null, transactions: [], status: null, errors: [] };
  for (const s of segs) {
    if (s.id === 'AK1') {
      out.functional_id = s.e[1];
      out.group_control = s.e[2];
    }
    if (s.id === 'AK2') out.transactions.push({ control: s.e[2], status: null });
    if (s.id === 'IK3') out.errors.push(`Segment ${s.e[1]} at position ${s.e[2]}: ${IK3[s.e[4]] || `error ${s.e[4]}`}`);
    if (s.id === 'IK4') out.errors.push(`Element ${s.c(1)[0]}: ${IK4[s.e[3]] || `error ${s.e[3]}`}${s.e[4] ? ` ("${s.e[4]}")` : ''}`);
    if (s.id === 'IK5' && out.transactions.length) out.transactions.at(-1).status = s.e[1];
    if (s.id === 'AK9') out.status = { A: 'accepted', E: 'accepted_with_errors', P: 'partially_accepted', R: 'rejected', M: 'rejected', W: 'rejected', X: 'rejected' }[s.e[1]] || 'unknown';
  }
  return out;
}
const IK3 = { 1: 'unrecognized segment', 2: 'unexpected segment', 3: 'required segment missing', 5: 'segment exceeds maximum use', 8: 'segment has data element errors' };
const IK4 = { 1: 'required element missing', 2: 'conditional element missing', 3: 'too many elements', 4: 'value too short', 5: 'value too long', 6: 'invalid character', 7: 'invalid code value', 8: 'invalid date', 9: 'invalid time' };

// ---- 277 / 277CA claim status (005010X212 / 005010X214) ----
// Claim status category codes (STC01-1), in plain language.
export const CLAIM_STATUS_CATEGORY = {
  A0: ['accepted', 'Forwarded to the payer'], A1: ['accepted', 'Received by the clearinghouse'], A2: ['accepted', 'Accepted into the payer\'s system'],
  A3: ['rejected', 'Returned as unprocessable — fix and resend'], A4: ['rejected', 'Not found by the payer'], A5: ['accepted', 'Split by the payer'],
  A6: ['rejected', 'Rejected for missing information'], A7: ['rejected', 'Rejected for invalid information'], A8: ['rejected', 'Rejected for relational field errors'],
  P0: ['pending', 'Pending: adjudication not finished'], P1: ['pending', 'In process'], P2: ['pending', 'Pending: payer review'], P3: ['pending', 'Pending: waiting on information requested from the provider'],
  P4: ['pending', 'Pending: waiting on the patient'], P5: ['pending', 'Pending: payer administrative hold'],
  F0: ['finalized', 'Finalized'], F1: ['finalized', 'Finalized — paid'], F2: ['finalized', 'Finalized — denied'], F3: ['finalized', 'Finalized — revised'],
  F3F: ['finalized', 'Finalized — forwarded'], F3N: ['finalized', 'Finalized — not forwarded'], F4: ['finalized', 'Finalized — adjudication complete, no payment forthcoming'],
  R0: ['request', 'More information requested'], R1: ['request', 'Requests for more information'], R3: ['request', 'Claim/line: requested information not received'], R4: ['request', 'Documentation requested'],
  E0: ['error', 'Response not possible — error on the request'], E1: ['error', 'Response not possible — system status'], E2: ['error', 'Information holder not responding'], E3: ['error', 'Correction required'], E4: ['error', 'Trading partner agreement missing'],
  D0: ['error', 'Data search unsuccessful'],
};
export function parse277(text) {
  const segs = parseX12(text);
  const st = segs.find((s) => s.id === 'ST' && s.e[1] === '277');
  if (!st) throw new Error('Not a 277 claim status file');
  const kind = /X214/.test(st.e[3] || '') ? '277CA' : '277';
  const claims = [];
  let current = null;
  for (const s of segs) {
    if (s.id === 'TRN' && s.e[1] === '2') {
      current = { control_number: s.e[2], statuses: [], payer_claim_number: null };
      claims.push(current);
    }
    if (!current) continue;
    if (s.id === 'REF' && s.e[1] === '1K') current.payer_claim_number = s.e[2];
    if (s.id === 'STC') {
      const [category, code, entity] = s.c(1);
      const [group, text] = CLAIM_STATUS_CATEGORY[category] || ['other', `Status ${category}`];
      current.statuses.push({
        category, code, entity, group, text, date: s.e[2] ? `${s.e[2].slice(0, 4)}-${s.e[2].slice(4, 6)}-${s.e[2].slice(6, 8)}` : null,
        billed: s.e[4] ? cents(s.e[4]) : null, paid: s.e[5] ? cents(s.e[5]) : null, check_number: s.e[9] || null,
      });
    }
  }
  for (const c of claims) {
    const top = c.statuses[0] || null;
    Object.assign(c, { group: top?.group || 'other', category: top?.category || null, text: top?.text || 'No status', paid: top?.paid ?? null });
  }
  return { kind, claims };
}

// TA1 interchange acknowledgment: the clearinghouse accepted or refused the whole file.
export function parseTA1(text) {
  const ta1 = parseX12(text).find((s) => s.id === 'TA1');
  if (!ta1) throw new Error('Not a TA1 acknowledgment');
  const status = { A: 'accepted', E: 'accepted_with_errors', R: 'rejected' }[ta1.e[4]] || 'unknown';
  return { interchange_control: ta1.e[1], status, note_code: ta1.e[5] || null, errors: status === 'rejected' ? [`Interchange rejected (TA1 note ${ta1.e[5] || '?'})`] : [] };
}

// Which X12 transaction a file carries (for routing downloads from the clearinghouse).
export function x12Type(text) {
  try {
    const segs = parseX12(text);
    const st = segs.find((s) => s.id === 'ST');
    if (!st) return segs.some((s) => s.id === 'TA1') ? 'TA1' : null;
    if (st.e[1] === '277' && /X214/.test(st.e[3] || '')) return '277CA';
    return st.e[1];
  } catch {
    return null;
  }
}

// ---- Sandbox payer responses (demo/training only; never sent to a real payer) ----
const sandboxEnvelope = (functionalId, version, type, segs, control, now = new Date()) =>
  envelope({ functionalId, version, senderId: 'SANDBOXCH', receiverId: 'DENTALMACHINE', control, now, body: transaction(type, version, segs) });

export function sandbox999({ groupControl, functionalId = 'HC', accepted = true, control = 1 }) {
  return sandboxEnvelope('FA', '005010X231A1', '999', [
    `AK1*${functionalId}*${groupControl}*005010X224A2`, 'AK2*837*0001*005010X224A2', `IK5*${accepted ? 'A' : 'R'}`, `AK9*${accepted ? 'A' : 'R'}*1*1*${accepted ? 1 : 0}`,
  ], control);
}
export function sandbox277({ claims, ca = true, control = 1, now = new Date() }) {
  const segs = ['BHT*0085*08*SANDBOX*' + d8(now.toISOString()) + '*' + now.toISOString().slice(11, 16).replace(':', '') + '*TH', 'HL*1**20*1', 'NM1*PR*2*SANDBOX PAYER*****PI*00000'];
  let hl = 1;
  for (const c of claims) {
    segs.push(`HL*${++hl}*1*PT`, `NM1*QC*1*${clean(c.last_name)}*${clean(c.first_name)}`, `TRN*2*${clean(c.control_number, 50)}`,
      `STC*${c.category}:${c.code || '20'}:PR*${d8(now.toISOString())}**${money(c.billed || 0)}*${money(c.paid || 0)}`,
      `REF*1K*${clean(c.payer_claim_number, 50)}`);
  }
  return sandboxEnvelope(ca ? 'HN' : 'HN', ca ? '005010X214' : '005010X212', '277', segs, control, now);
}
export function sandbox835({ payee, claims, eft, date, control = 1 }) {
  const total = claims.reduce((s, c) => s + c.paid, 0);
  const segs = [
    `BPR*I*${money(total)}*C*ACH*CCP*01*999999999*DA*123456*1512345678**01*999999999*DA*654321*${d8(date)}`,
    `TRN*1*${eft}*1512345678`, `DTM*405*${d8(date)}`,
    'N1*PR*SANDBOX DENTAL PAYER', 'N3*1 PAYER WAY', 'N4*CHICAGO*IL*60601',
    `N1*PE*${clean(payee.name)}*XX*${digitsOnly(payee.npi)}`,
  ];
  for (const c of claims) {
    segs.push(`CLP*${clean(c.control_number, 38)}*${c.paid ? 1 : 4}*${money(c.billed)}*${money(c.paid)}*${money(c.patient)}*12*${clean(c.payer_claim_number, 50)}`);
    if (c.write_off) segs.push(`CAS*CO*45*${money(c.write_off)}`);
    if (!c.paid) segs.push(`CAS*CO*${c.denial_code || 204}*${money(c.billed - c.write_off)}`);
    else if (c.patient) segs.push(`CAS*PR*2*${money(c.patient)}`);
  }
  return sandboxEnvelope('HP', '005010X221A1', '835', segs, control);
}
