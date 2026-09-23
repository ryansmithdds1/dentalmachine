// Loads a demo practice with realistic sample data. Usage: npm run seed
import { openDb } from './db.js';
import { hashPassword } from './auth.js';
import { insert, localNow, addMonths } from './util.js';
import { seedPracticeDefaults } from './defaults.js';
import { completeProcedure, estimateCoverage } from './services.js';

const DEMO_EMAIL = 'admin@demo.dentalmachine.app';
const DEMO_PASSWORD = 'demo-password-123';

const db = openDb();
if (db.get('SELECT id FROM users WHERE email = ?', DEMO_EMAIL)) {
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

const today = localNow('America/Chicago').slice(0, 10);
const dayOffset = (n) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

db.tx(() => {
  const practiceId = insert(db, 'practices', {
    name: 'Bright Smiles Family Dentistry', address: '1200 Main Street, Suite 200', city: 'Austin', state: 'TX', zip: '78701',
    phone: '(512) 555-0142', email: 'office@brightsmiles.example', npi: '1987654321', tax_id: '74-1234567', timezone: 'America/Chicago',
  });
  seedPracticeDefaults(db, practiceId);

  const user = (email, name, role) => insert(db, 'users', { practice_id: practiceId, email, name, role, password_hash: hashPassword(DEMO_PASSWORD) });
  const adminId = user(DEMO_EMAIL, 'Morgan Reyes', 'admin');
  const drUser = user('dr.chen@demo.dentalmachine.app', 'Dr. Alex Chen', 'dentist');
  const hygUser = user('sam@demo.dentalmachine.app', 'Sam Okafor, RDH', 'hygienist');
  user('frontdesk@demo.dentalmachine.app', 'Jordan Lee', 'front_desk');
  user('billing@demo.dentalmachine.app', 'Casey Park', 'billing');

  const drChen = insert(db, 'providers', { practice_id: practiceId, user_id: drUser, name: 'Dr. Alex Chen, DDS', type: 'dentist', npi: '1234567893', color: '#2563eb' });
  const drRivera = insert(db, 'providers', { practice_id: practiceId, name: 'Dr. Priya Rivera, DMD', type: 'dentist', npi: '1234567901', color: '#7c3aed' });
  const hyg = insert(db, 'providers', { practice_id: practiceId, user_id: hygUser, name: 'Sam Okafor, RDH', type: 'hygienist', color: '#059669' });
  const ops = db.all('SELECT id FROM operatories WHERE practice_id = ? ORDER BY id', practiceId).map((o) => o.id);

  const carriers = [
    ['Delta Dental', '94276'], ['MetLife Dental', '65978'], ['Cigna Dental', '62308'], ['Aetna Dental', '60054'], ['Guardian', '64246'],
  ].map(([name, payer_id]) => insert(db, 'insurance_carriers', { practice_id: practiceId, name, payer_id, phone: '(800) 555-0100' }));

  const code = (c) => db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', practiceId, c);
  const addProc = (patientId, c, extra = {}) => {
    const pc = code(c);
    return insert(db, 'procedures', {
      practice_id: practiceId, patient_id: patientId, code_id: pc.id, code: pc.code, description: pc.description, category: pc.category, fee: pc.fee, ...extra,
    });
  };
  const adminUser = { id: adminId };

  const patients = [];
  for (let i = 0; i < 40; i++) {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    const year = 1950 + Math.floor(rand() * 60);
    const id = insert(db, 'patients', {
      practice_id: practiceId, first_name: first, last_name: last,
      dob: `${year}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`,
      gender: rand() > 0.5 ? 'female' : 'male', phone: `(512) 555-${String(1000 + i * 37).slice(-4)}`,
      email: `${first}.${last}${i}@example.com`.toLowerCase(), address: `${100 + i * 13} Oak Ave`, city: 'Austin', state: 'TX', zip: '78704',
      medical_alerts: pickOne(ALERTS), allergies: pickOne(ALLERGIES), primary_provider_id: rand() > 0.5 ? drChen : drRivera,
      created_at: `${dayOffset(-Math.floor(rand() * 400))} 10:00:00`,
    });
    patients.push(id);

    if (rand() < 0.75) {
      insert(db, 'patient_insurance', {
        practice_id: practiceId, patient_id: id, carrier_id: pickOne(carriers), subscriber_name: `${first} ${last}`,
        subscriber_id: `W${String(100000000 + i * 7919).slice(0, 9)}`, group_number: `G${1000 + (i % 9)}`,
        annual_max: pickOne([100000, 150000, 200000]), deductible: 5000, pct_preventive: 100, pct_basic: 80, pct_major: 50,
      });
    }

    // History: a past hygiene visit with completed work, charged on that date.
    const pastOffset = -Math.floor(3 + rand() * 75);
    const pastDay = dayOffset(pastOffset);
    const eobDay = dayOffset(Math.min(0, pastOffset + 10 + Math.floor(rand() * 10)));
    const pastAppt = insert(db, 'appointments', {
      practice_id: practiceId, patient_id: id, provider_id: hyg, operatory_id: ops[2],
      start_time: `${pastDay} 09:00`, end_time: `${pastDay} 10:00`, status: 'completed', reason: 'Recall exam & cleaning',
    });
    for (const c of ['D0120', 'D1110', 'D0274']) {
      const pid = addProc(id, c, { provider_id: c === 'D0120' ? drChen : hyg, appointment_id: pastAppt });
      completeProcedure(db, adminUser, db.get('SELECT * FROM procedures WHERE id = ?', pid));
    }
    db.run('UPDATE ledger_entries SET entry_date = ? WHERE patient_id = ? AND entry_date = ?', pastDay, id, today);
    db.run('UPDATE procedures SET completed_at = ? WHERE appointment_id = ?', `${pastDay} 10:00:00`, pastAppt);
    db.run('UPDATE recalls SET due_date = ? WHERE patient_id = ?', addMonths(pastDay, 6), id);

    // Charting findings and a treatment plan for some patients.
    if (rand() < 0.5) {
      const tooth = String(pickOne([3, 14, 19, 30, 2, 15, 18, 31]));
      insert(db, 'tooth_conditions', { practice_id: practiceId, patient_id: id, tooth, surfaces: 'MO', condition: 'caries', recorded_by: drUser });
      const planId = insert(db, 'treatment_plans', { practice_id: practiceId, patient_id: id, name: 'Restorative', status: rand() > 0.4 ? 'accepted' : 'proposed' });
      addProc(id, 'D2392', { tooth, surfaces: 'MO', provider_id: drChen, treatment_plan_id: planId, priority: 1 });
      if (rand() < 0.4) addProc(id, 'D2740', { tooth: String(pickOne([3, 14, 19, 30])), provider_id: drChen, treatment_plan_id: planId, priority: 2 });
    }
    if (rand() < 0.2) insert(db, 'tooth_conditions', { practice_id: practiceId, patient_id: id, tooth: pickOne(['1', '16', '17', '32']), condition: 'missing', recorded_by: drUser });
    if (rand() < 0.3) insert(db, 'tooth_conditions', { practice_id: practiceId, patient_id: id, tooth: pickOne(['3', '14', '19', '30']), condition: 'crown', recorded_by: drUser });

    insert(db, 'clinical_notes', {
      practice_id: practiceId, patient_id: id, appointment_id: pastAppt, provider_id: hyg, author_id: hygUser,
      body: 'Periodic exam, adult prophy and 4BWX. Light calculus lower anteriors. OHI reviewed. No complaints.',
      signed: 1, signed_at: `${pastDay} 10:05:00`, created_at: `${pastDay} 10:00:00`,
    });

    // Insurance claim + payments on the historical visit.
    const policy = db.get('SELECT pi.*, c.name AS carrier_name FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id WHERE pi.patient_id = ?', id);
    const done = db.all("SELECT * FROM procedures WHERE patient_id = ? AND status = 'completed'", id);
    if (policy) {
      const est = estimateCoverage(db, policy, done);
      const paid = rand() < 0.7;
      const claimId = insert(db, 'claims', {
        practice_id: practiceId, patient_id: id, patient_insurance_id: policy.id, status: paid ? 'paid' : 'submitted',
        total_fee: est.total_fee, estimated_amount: est.total_insurance, submitted_at: `${pastDay} 17:00:00`,
        paid_amount: paid ? est.total_insurance : 0, paid_at: paid ? `${eobDay} 12:00:00` : null,
      });
      est.items.forEach((it) => insert(db, 'claim_items', { claim_id: claimId, procedure_id: it.procedure_id, fee: it.fee, estimated_amount: it.insurance }));
      if (paid) {
        insert(db, 'ledger_entries', {
          practice_id: practiceId, patient_id: id, type: 'insurance_payment', amount: -est.total_insurance,
          description: `Insurance payment - ${policy.carrier_name} (claim #${claimId})`, method: 'check', claim_id: claimId,
          entry_date: eobDay, created_by: adminId,
        });
      }
      if (est.total_patient > 0 && rand() < 0.6) {
        insert(db, 'ledger_entries', {
          practice_id: practiceId, patient_id: id, type: 'payment', amount: -est.total_patient,
          description: 'Patient payment (credit card)', method: 'credit_card', entry_date: pastDay, created_by: adminId,
        });
      }
    } else if (rand() < 0.5) {
      const total = done.reduce((s, p) => s + p.fee, 0);
      insert(db, 'ledger_entries', {
        practice_id: practiceId, patient_id: id, type: 'payment', amount: -total,
        description: 'Patient payment (cash)', method: 'cash', entry_date: pastDay, created_by: adminId,
      });
    }
  }

  // Upcoming schedule: today and the next several weekdays.
  const reasons = [['Recall exam & cleaning', hyg, 2, 60], ['Composite filling', drChen, 0, 60], ['Crown prep', drRivera, 1, 90], ['Limited exam - toothache', drChen, 0, 30], ['New patient exam', drRivera, 1, 60]];
  let pi = 0;
  for (let d = 0; d < 8; d++) {
    const day = dayOffset(d);
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const cursor = { [drChen]: 8 * 60, [drRivera]: 8 * 60, [hyg]: 8 * 60 };
    for (let k = 0; k < 9; k++) {
      const [reason, prov, opIdx, dur] = reasons[k % reasons.length];
      const start = cursor[prov];
      if (start + dur > 17 * 60) continue;
      cursor[prov] += dur + (rand() < 0.3 ? 30 : 0);
      const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      insert(db, 'appointments', {
        practice_id: practiceId, patient_id: patients[pi++ % patients.length], provider_id: prov, operatory_id: ops[opIdx],
        start_time: `${day} ${hhmm(start)}`, end_time: `${day} ${hhmm(start + dur)}`,
        status: d === 0 ? pickOne(['confirmed', 'checked_in', 'scheduled']) : pickOne(['scheduled', 'confirmed']), reason,
      });
    }
  }
});

console.log(`Demo practice created. Log in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
