// Loads a demo practice with realistic sample data. Usage: npm run seed
import { SANDBOX_PHARMACIES } from './erx.js';
import { openDb } from './db.js';
import { hashPassword } from './auth.js';
import { insert, localNow, addMonths, mapSeq } from './util.js';
import { seedPracticeDefaults } from './defaults.js';
import { completeProcedure, estimateCoverage } from './services.js';

const DEMO_EMAIL = 'admin@demo.dentalmachine.app';
const DEMO_PASSWORD = 'demo-password-123';

const db = await openDb();
if (await db.get('SELECT id FROM users WHERE lower(email) = lower(?)', DEMO_EMAIL)) {
  console.log(`Demo practice already exists. Log in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  process.exit(0);
}

// Deterministic pseudo-random so demo data is stable between runs.
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pickOne = (arr) => arr[Math.floor(rand() * arr.length)];

const FIRST = ['Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Elijah', 'Sophia', 'James', 'Isabella', 'Lucas', 'Mia', 'Mason', 'Amelia', 'Ethan', 'Harper', 'Logan', 'Evelyn', 'Aiden', 'Abigail', 'Carter', 'Ella', 'Jayden', 'Scarlett', 'Leo', 'Grace', 'Mateo', 'Chloe', 'Wyatt', 'Nora', 'Owen'];
const LAST = ['Johnson', 'Martinez', 'Nguyen', 'Patel', 'Garcia', 'Kim', 'Brown', 'Davis', 'Lopez', 'Wilson', 'Anderson', 'Thomas', 'Clark', 'Lewis', 'Walker', 'Hall', 'Young', 'King', 'Wright', 'Scott'];
const ALERTS = [null, null, null, null, 'Hypertension', 'Diabetes Type 2', 'Pre-med required (joint replacement)', 'Pregnant', 'Blood thinners (warfarin)'];
const ALLERGIES = [null, null, null, 'Penicillin', 'Latex', 'Codeine', 'Sulfa'];
const REFERRALS = ['Google search', 'Google search', 'Friend or family', 'Friend or family', 'Insurance directory', 'Instagram', 'Drove by', null];
const OFFICE_ALERTS = [null, null, null, null, null, null, 'Prefers text, not calls', 'Anxious — offer nitrous & headphones', 'Always runs 10 min late — book first slot', 'Spanish-speaking parent; bring Maria to translate', 'Collect balance before seating'];

const today = localNow('America/Chicago').slice(0, 10);
const dayOffset = (n) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

await db.tx(async () => {
  const practiceId = await insert(db, 'practices', {
    name: 'Bright Smiles Family Dentistry', address: '1200 Main Street, Suite 200', city: 'Austin', state: 'TX', zip: '78701',
    phone: '(512) 555-0142', email: 'office@brightsmiles.example', npi: '1987654321', tax_id: '74-1234567', timezone: 'America/Chicago',
    slug: 'bright-smiles', online_booking: 1, reminder_hours: 48,
  });
  await seedPracticeDefaults(db, practiceId);

  const user = async (email, name, role) => await insert(db, 'users', { practice_id: practiceId, email, name, role, password_hash: hashPassword(DEMO_PASSWORD) });
  const adminId = await user(DEMO_EMAIL, 'Morgan Reyes', 'admin');
  const drUser = await user('dr.chen@demo.dentalmachine.app', 'Dr. Alex Chen', 'dentist');
  const hygUser = await user('sam@demo.dentalmachine.app', 'Sam Okafor, RDH', 'hygienist');
  await user('frontdesk@demo.dentalmachine.app', 'Jordan Lee', 'front_desk');
  await user('billing@demo.dentalmachine.app', 'Casey Park', 'billing');

  const drChen = await insert(db, 'providers', { practice_id: practiceId, user_id: drUser, name: 'Dr. Alex Chen, DDS', type: 'dentist', npi: '1234567893', license_number: 'TX-28841', dea_number: 'BC1234563', color: '#2563eb' });
  const drRivera = await insert(db, 'providers', {
    practice_id: practiceId, name: 'Dr. Priya Rivera, DMD', type: 'dentist', npi: '1234567901', color: '#7c3aed',
    working_hours: JSON.stringify({ 0: [], 1: [['08:00', '17:00']], 2: [['08:00', '17:00']], 3: [['08:00', '17:00']], 4: [['08:00', '17:00']], 5: [], 6: [] }), // Mon–Thu
  });
  const hyg = await insert(db, 'providers', { practice_id: practiceId, user_id: hygUser, name: 'Sam Okafor, RDH', type: 'hygienist', npi: '1234567919', color: '#059669' });
  const ops = (await db.all('SELECT id FROM operatories WHERE practice_id = ? ORDER BY id', practiceId)).map((o) => o.id);

  const carriers = await mapSeq([
    ['Delta Dental', '94276'], ['MetLife Dental', '65978'], ['Cigna Dental', '62308'], ['Aetna Dental', '60054'], ['Guardian', '64246'],
  ], async ([name, payer_id]) => await insert(db, 'insurance_carriers', { practice_id: practiceId, name, payer_id, phone: '(800) 555-0100' }));

  // In-network PPO fee schedules: Delta and Cigna pay contracted fees (office fee minus a write-off).
  for (const [name, pct, carrierIdx] of [['Delta Dental PPO', 82, [0]], ['Cigna DPPO', 76, [2]]]) {
    const fsId = await insert(db, 'fee_schedules', { practice_id: practiceId, name });
    for (const c of await db.all('SELECT code, fee FROM procedure_codes WHERE practice_id = ? AND active = 1', practiceId)) {
      await db.run('INSERT INTO fee_schedule_items (fee_schedule_id, code, fee) VALUES (?, ?, ?)', fsId, c.code, Math.round((c.fee * pct) / 100 / 100) * 100);
    }
    for (const i of carrierIdx) await db.run('UPDATE insurance_carriers SET fee_schedule_id = ? WHERE id = ?', fsId, carriers[i]);
  }

  const code = async c => await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', practiceId, c);
  const addProc = async (patientId, c, extra = {}) => {
    const pc = await code(c);
    return await insert(db, 'procedures', {
      practice_id: practiceId, patient_id: patientId, code_id: pc.id, code: pc.code, description: pc.description, category: pc.category, fee: pc.fee, ...extra,
    });
  };
  const adminUser = { id: adminId };

  const patients = [];
  for (let i = 0; i < 40; i++) {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    const year = 1950 + Math.floor(rand() * 60);
    const id = await insert(db, 'patients', {
      practice_id: practiceId, first_name: first, last_name: last,
      dob: `${year}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`,
      gender: rand() > 0.5 ? 'female' : 'male', phone: `(512) 555-${String(1000 + i * 37).slice(-4)}`,
      email: `${first}.${last}${i}@example.com`.toLowerCase(), address: `${100 + i * 13} Oak Ave`, city: 'Austin', state: 'TX', zip: '78704',
      medical_alerts: pickOne(ALERTS), allergies: pickOne(ALLERGIES), primary_provider_id: rand() > 0.5 ? drChen : drRivera,
      referral_source: pickOne(REFERRALS), office_alert: pickOne(OFFICE_ALERTS),
      preferred_pharmacy: rand() < 0.6 ? JSON.stringify(pickOne(SANDBOX_PHARMACIES.slice(0, 4))) : null,
      medical_reviewed_at: rand() > 0.35 ? `${dayOffset(-Math.floor(rand() * 500))} 09:00:00` : null,
      created_at: `${dayOffset(-Math.floor(rand() * 400))} 10:00:00`,
    });
    patients.push(id);

    if (rand() < 0.75) {
      await insert(db, 'patient_insurance', {
        practice_id: practiceId, patient_id: id, carrier_id: pickOne(carriers), subscriber_name: `${first} ${last}`,
        subscriber_id: `W${String(100000000 + i * 7919).slice(0, 9)}`, group_number: `G${1000 + (i % 9)}`,
        annual_max: pickOne([100000, 150000, 200000]), deductible: 5000, pct_preventive: 100, pct_basic: 80, pct_major: 50,
      });
    }

    // History: a past hygiene visit with completed work, charged on that date.
    const pastOffset = -Math.floor(3 + rand() * 75);
    const pastDay = dayOffset(pastOffset);
    const eobDay = dayOffset(Math.min(0, pastOffset + 10 + Math.floor(rand() * 10)));
    const pastAppt = await insert(db, 'appointments', {
      practice_id: practiceId, patient_id: id, provider_id: hyg, operatory_id: ops[2],
      start_time: `${pastDay} 09:00`, end_time: `${pastDay} 10:00`, status: 'completed', reason: 'Recall exam & cleaning',
    });
    for (const c of ['D0120', 'D1110', 'D0274']) {
      const pid = await addProc(id, c, { provider_id: c === 'D0120' ? drChen : hyg, appointment_id: pastAppt });
      await completeProcedure(db, adminUser, await db.get('SELECT * FROM procedures WHERE id = ?', pid));
    }
    await db.run('UPDATE ledger_entries SET entry_date = ? WHERE patient_id = ? AND entry_date = ?', pastDay, id, today);
    await db.run('UPDATE procedures SET completed_at = ? WHERE appointment_id = ?', `${pastDay} 10:00:00`, pastAppt);
    await db.run('UPDATE recalls SET due_date = ? WHERE patient_id = ?', addMonths(pastDay, 6), id);

    // Charting findings and a treatment plan for some patients.
    if (rand() < 0.5) {
      const tooth = String(pickOne([3, 14, 19, 30, 2, 15, 18, 31]));
      await insert(db, 'tooth_conditions', { practice_id: practiceId, patient_id: id, tooth, surfaces: 'MO', condition: 'caries', recorded_by: drUser });
      const accepted = rand() > 0.4;
      const planDay = dayOffset(-Math.floor(rand() * 150));
      const planId = await insert(db, 'treatment_plans', {
        practice_id: practiceId, patient_id: id, name: 'Restorative', status: accepted ? 'accepted' : 'proposed', accepted_at: accepted ? `${planDay} 15:20:00` : null, created_at: `${planDay} 15:00:00`,
        ...(accepted && rand() > 0.4 ? { signature_name: `${first} ${last}`, signed_at: `${planDay} 15:20:00`, presented_at: `${planDay} 15:05:00` } : {}),
      });
      await addProc(id, 'D2392', { tooth, surfaces: 'MO', provider_id: drChen, treatment_plan_id: planId, priority: 1 });
      if (rand() < 0.4) await addProc(id, 'D2740', { tooth: String(pickOne([3, 14, 19, 30])), provider_id: drChen, treatment_plan_id: planId, priority: 2 });
    }
    if (rand() < 0.2) await insert(db, 'tooth_conditions', { practice_id: practiceId, patient_id: id, tooth: pickOne(['1', '16', '17', '32']), condition: 'missing', recorded_by: drUser });
    if (rand() < 0.3) await insert(db, 'tooth_conditions', { practice_id: practiceId, patient_id: id, tooth: pickOne(['3', '14', '19', '30']), condition: 'crown', recorded_by: drUser });

    await insert(db, 'clinical_notes', {
      practice_id: practiceId, patient_id: id, appointment_id: pastAppt, provider_id: hyg, author_id: hygUser,
      body: 'Periodic exam, adult prophy and 4BWX. Light calculus lower anteriors. OHI reviewed. No complaints.',
      signed: 1, signed_at: `${pastDay} 10:05:00`, created_at: `${pastDay} 10:00:00`,
    });

    // Insurance claim + payments on the historical visit.
    const policy = await db.get('SELECT pi.*, c.name AS carrier_name FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id WHERE pi.patient_id = ?', id);
    const done = await db.all("SELECT * FROM procedures WHERE patient_id = ? AND status = 'completed'", id);
    if (policy) {
      const est = await estimateCoverage(db, policy, done);
      const draft = pastOffset > -14; // recent visits: claims waiting to be sent
      const paid = !draft && rand() < 0.7;
      const claimId = await insert(db, 'claims', {
        practice_id: practiceId, patient_id: id, patient_insurance_id: policy.id, status: draft ? 'draft' : paid ? 'paid' : 'submitted',
        total_fee: est.total_fee, estimated_amount: est.total_insurance, write_off_estimate: est.total_write_off || 0, submitted_at: draft ? null : `${pastDay} 17:00:00`,
        paid_amount: paid ? est.total_insurance : 0, paid_at: paid ? `${eobDay} 12:00:00` : null,
      });
      await mapSeq(
        est.items,
        async it => await insert(db, 'claim_items', { claim_id: claimId, procedure_id: it.procedure_id, fee: it.fee, estimated_amount: it.insurance })
      );
      if (paid) {
        await insert(db, 'ledger_entries', {
          practice_id: practiceId, patient_id: id, type: 'insurance_payment', amount: -est.total_insurance,
          description: `Insurance payment - ${policy.carrier_name} (claim #${claimId})`, method: 'check', claim_id: claimId,
          entry_date: eobDay, created_by: adminId,
        });
      }
      if (est.total_patient > 0 && rand() < 0.6) {
        await insert(db, 'ledger_entries', {
          practice_id: practiceId, patient_id: id, type: 'payment', amount: -est.total_patient,
          description: 'Patient payment (credit card)', method: 'credit_card', entry_date: pastDay, created_by: adminId,
        });
      }
    } else if (rand() < 0.5) {
      const total = done.reduce((s, p) => s + p.fee, 0);
      await insert(db, 'ledger_entries', {
        practice_id: practiceId, patient_id: id, type: 'payment', amount: -total,
        description: 'Patient payment (cash)', method: 'cash', entry_date: pastDay, created_by: adminId,
      });
    }
  }

  // Upcoming schedule: today and the next several weekdays, built from appointment types.
  await db.run('UPDATE practices SET daily_goal = ?, hygiene_goal = ?, review_url = ?, review_requests = 1 WHERE id = ?', 600000, 180000, 'https://g.page/r/bright-smiles-austin/review', practiceId);
  const typeId = async name => await db.get('SELECT * FROM appointment_types WHERE practice_id = ? AND name = ?', practiceId, name);
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const plan = [
    ['Recall exam & cleaning', hyg, 2, []], ['Filling', drChen, 0, [['D2392', '19', 'MO'], ['D2391', '30', 'O']]], ['Crown prep', drRivera, 1, [['D2740', '3'], ['D2950', '3']]],
    ['Emergency / limited exam', drChen, 0, []], ['New patient exam & cleaning', hyg, 2, []], ['Root canal', drRivera, 1, [['D3330', '14']]],
    ['Perio maintenance', hyg, 2, []], ['Crown seat', drChen, 0, []], ['Extraction', drRivera, 1, [['D7140', '32']]], ['Recall exam & cleaning', hyg, 2, []],
  ];
  let pi = 0;
  for (let d = 0; d < 12; d++) {
    const day = dayOffset(d);
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    await insert(db, 'blockouts', { practice_id: practiceId, start_time: `${day} 12:00`, end_time: `${day} 13:00`, reason: 'Lunch', created_by: adminId });
    const cursor = { [drChen]: 8 * 60, [drRivera]: 8 * 60, [hyg]: 8 * 60 };
    for (let k = 0; k < 14; k++) {
      const [name, prov, opIdx, procs] = plan[(k + d) % plan.length];
      if (prov === drRivera && dow === 5) continue; // Dr. Rivera doesn't work Fridays
      const type = await typeId(name);
      let start = cursor[prov];
      if (start < 13 * 60 && start + type.duration > 12 * 60) start = 13 * 60; // skip lunch
      if (start + type.duration > 17 * 60) continue;
      cursor[prov] = start + type.duration + (rand() < 0.25 ? 30 : 0);
      const patientId = patients[pi++ % 30]; // the last 10 patients stay off the schedule (follow-up lists)
      const apptId = await insert(db, 'appointments', {
        practice_id: practiceId, patient_id: patientId, provider_id: prov, operatory_id: ops[opIdx], appointment_type_id: type.id, reason: type.name,
        start_time: `${day} ${hhmm(start)}`, end_time: `${day} ${hhmm(start + type.duration)}`, asap: d > 3 && rand() < 0.08 ? 1 : 0,
        status: d === 0 ? pickOne(['confirmed', 'checked_in', 'scheduled', 'confirmed']) : pickOne(['scheduled', 'confirmed']),
      });
      const codes = [...JSON.parse(type.procedure_codes || '[]').map((c) => [c]), ...procs];
      for (const [c, tooth, surfaces] of codes) await addProc(patientId, c, { appointment_id: apptId, provider_id: prov, tooth: tooth ?? null, surfaces: surfaces ?? null });
      if (name === 'Crown prep') {
        await insert(db, 'lab_cases', {
          practice_id: practiceId, patient_id: patientId, provider_id: prov, lab_name: pickOne(['Glidewell', 'Burbank Dental Lab', 'Dental Arts Lab']),
          description: 'Zirconia crown #3', tooth: '3', shade: 'A2', status: 'sent', sent_date: day, due_date: dayOffset(d + 10), cost: 12900,
        });
      }
    }
  }

  // A perio patient on 3-month maintenance, booked as a recurring series.
  {
    const pid = patients[5];
    const seriesId = await insert(db, 'appointment_series', { practice_id: practiceId, patient_id: pid, every: 3, unit: 'month', count: 4, created_by: adminId });
    const perio = await typeId('Perio maintenance');
    for (let q = 0; q < 4; q++) {
      const d = new Date(`${dayOffset(15)}T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + 3 * q);
      let day = d.toISOString().slice(0, 10);
      const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) day = dayOffset(Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400_000) + (dow === 6 ? 2 : 1));
      await insert(db, 'appointments', {
        practice_id: practiceId, patient_id: pid, provider_id: hyg, operatory_id: ops[2], appointment_type_id: perio.id, reason: perio.name, series_id: seriesId,
        start_time: `${day} 16:00`, end_time: `${day} ${hhmm(16 * 60 + perio.duration)}`, status: 'scheduled',
      });
    }
  }

  // Patients who fell off the schedule: overdue recall, broken appointments, diagnosed-but-unscheduled treatment.
  for (let j = 30; j < 40; j++) {
    const pid = patients[j];
    await db.run("UPDATE recalls SET due_date = ?, status = 'due' WHERE patient_id = ?", dayOffset(j % 3 === 0 ? 12 : -(j - 25) * 9), pid);
    if (j % 2 === 0) {
      const when = dayOffset(-(j - 28) * 3);
      await insert(db, 'appointments', {
        practice_id: practiceId, patient_id: pid, provider_id: j % 4 === 0 ? drChen : hyg, operatory_id: ops[j % 4 === 0 ? 0 : 2],
        start_time: `${when} 14:00`, end_time: `${when} 15:00`, status: j % 4 === 0 ? 'no_show' : 'cancelled', reason: j % 4 === 0 ? 'Crown prep' : 'Recall exam & cleaning',
      });
    }
    if (!(await db.get("SELECT 1 FROM procedures WHERE patient_id = ? AND status = 'planned'", pid))) {
      const planDay = dayOffset(-(j - 20) * 4);
      const tp = await insert(db, 'treatment_plans', { practice_id: practiceId, patient_id: pid, name: 'Restorative', status: j % 3 ? 'accepted' : 'proposed', accepted_at: j % 3 ? `${planDay} 15:00:00` : null, created_at: `${planDay} 14:00:00` });
      await addProc(pid, pickOne(['D2740', 'D2392', 'D3330']), { tooth: pickOne(['3', '14', '19', '30']), provider_id: drChen, treatment_plan_id: tp, priority: 1 });
    }
  }
  await insert(db, 'followups', { practice_id: practiceId, patient_id: patients[31], kind: 'recall', outcome: 'left_voicemail', note: 'Left VM on cell', created_by: adminId, created_at: `${dayOffset(-2)} 16:00:00` });
  await insert(db, 'followups', { practice_id: practiceId, patient_id: patients[34], kind: 'unscheduled', outcome: 'spoke_will_call', note: 'Checking work schedule, will call back', created_by: adminId, created_at: `${dayOffset(-1)} 11:00:00` });

  // A few households share a guarantor.
  for (let f = 0; f < 5; f++) {
    const [head, ...members] = patients.slice(f * 3, f * 3 + 3);
    for (const m of members) await db.run('UPDATE patients SET guarantor_id = ?, last_name = (SELECT last_name FROM patients WHERE id = ?) WHERE id = ?', head, head, m);
  }
  await insert(db, 'payment_plans', {
    practice_id: practiceId, patient_id: patients[0], total: 240000, down_payment: 40000, installment_amount: 50000, installments: 4,
    frequency: 'monthly', start_date: dayOffset(-45), notes: 'Crown + buildup', created_by: adminId,
  });
  await insert(db, 'tasks', { practice_id: practiceId, title: 'Call Delta Dental about denied claim', priority: 'high', due_date: dayOffset(1), created_by: adminId });
  await insert(db, 'tasks', { practice_id: practiceId, patient_id: patients[4], title: 'Send pre-authorization for crown #3', due_date: dayOffset(3), created_by: adminId });
  // Online booking requests waiting for the front desk.
  const requests = [
    ['Harper', 'Quinn', '1994-06-12', '(512) 555-0188', 'harper.q@example.com', 'New patient exam & cleaning', 60, 2, '15:00', 'Moving from Dallas, last cleaning ~1 year ago.'],
    ['Diego', 'Ramirez', '1981-11-03', '(512) 555-0177', null, 'Tooth pain / emergency', 30, 1, '16:00', 'Lower left molar sensitive to cold.'],
  ];
  for (const [first_name, last_name, dob, phone, email, reason, duration, offset, time, notes] of requests) {
    let day = dayOffset(offset);
    while ([0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) day = dayOffset(++offset);
    await insert(db, 'booking_requests', {
      practice_id: practiceId, first_name, last_name, dob, phone, email, reason, duration, provider_id: drRivera,
      requested_start: `${day} ${time}`, notes, ip: '203.0.113.7',
    });
  }

  // Message history so the communication log isn't empty.
  for (const pid of patients.slice(0, 6)) {
    const p = await db.get('SELECT * FROM patients WHERE id = ?', pid);
    await insert(db, 'messages', {
      practice_id: practiceId, patient_id: pid, channel: 'sms', kind: 'reminder', to_address: p.phone, status: 'sent', provider_id: 'log',
      body: `Hi ${p.first_name}, this is Bright Smiles Family Dentistry reminding you of your appointment. Please confirm: (demo link)`,
      sent_at: `${dayOffset(-2)} 09:00:00`, created_at: `${dayOffset(-2)} 09:00:00`,
    });
  }
  // Two-way text threads.
  for (const [idx, body] of [[1, 'Can I come in 15 minutes later tomorrow?'], [2, 'C'], [7, 'Do you take Aetna?']]) {
    const p = await db.get('SELECT * FROM patients WHERE id = ?', patients[idx]);
    await insert(db, 'messages', {
      practice_id: practiceId, patient_id: p.id, channel: 'sms', kind: 'reply', direction: 'inbound', to_address: '+15125550142', from_address: p.phone,
      body, status: 'sent', sent_at: `${dayOffset(0)} 08:1${idx}:00`, created_at: `${dayOffset(0)} 08:1${idx}:00`,
    });
  }
});

console.log(`Demo practice created. Log in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
await db.close();
