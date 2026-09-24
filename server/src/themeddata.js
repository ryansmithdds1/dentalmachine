// Content for the themed demo practice (themeddemo.js): Middle-earth and Marvel characters, made-up insurance
// carriers and employers, and the words that fill notes, texts and reviews. Everything here is fictional —
// characters only, no real people, no real companies or carriers. Emails use the reserved .example domain and
// phone numbers the 555 exchange, so nothing can ever reach a real person.

export const THEMED_ADMIN_EMAIL = 'admin@middle-earth.dental';

export const PRACTICE = {
  name: 'Fellowship Dental Partners', address: '1 Last Homely House Road', city: 'Rivendell', state: 'CO', zip: '80424',
  phone: '(970) 555-0110', email: 'office@middle-earth.dental', npi: '1740263859', tax_id: '84-3019275', timezone: 'America/Denver',
  slug: 'fellowship-dental',
};

// Two offices. `area` is the phone area code used for patients who live near each one.
export const OFFICES = [
  { key: 'riv', name: 'Rivendell Family Dental', address: '1 Last Homely House Road', city: 'Rivendell', state: 'CO', zip: '80424', phone: '(970) 555-0110', area: '970', mail: 'shire.example' },
  { key: 'stk', name: 'Stark Tower Smiles', address: '10 Stark Tower Plaza, Floor 42', city: 'New York', state: 'NY', zip: '10036', phone: '(212) 555-0142', area: '212', mail: 'avengers.example' },
];

// Staff. Every one can sign in with the demo password; `login` marks the ones listed for the owner.
export const STAFF = [
  { key: 'hill', email: THEMED_ADMIN_EMAIL, name: 'Maria Hill', role: 'admin', login: true, title: 'Office manager', rate: 4200 },
  { key: 'strange', email: 'strange@middle-earth.dental', name: 'Dr. Stephen Strange', role: 'dentist', login: true, title: 'Dentist (owner)' },
  { key: 'banner', email: 'banner@middle-earth.dental', name: 'Dr. Bruce Banner', role: 'dentist', title: 'Associate dentist' },
  { key: 'galadriel', email: 'galadriel@middle-earth.dental', name: 'Galadriel of Lorien, RDH', role: 'hygienist', login: true, title: 'Hygienist', rate: 5200 },
  { key: 'arwen', email: 'arwen@middle-earth.dental', name: 'Arwen Evenstar, RDH', role: 'hygienist', title: 'Hygienist', rate: 5000 },
  { key: 'jane', email: 'jane.foster@middle-earth.dental', name: 'Jane Foster, RDH', role: 'hygienist', title: 'Hygienist', rate: 5000 },
  { key: 'wanda', email: 'wanda@middle-earth.dental', name: 'Wanda Maximoff, RDH', role: 'hygienist', title: 'Hygienist', rate: 4900 },
  { key: 'sam', email: 'samwise@middle-earth.dental', name: 'Samwise Gamgee', role: 'assistant', title: 'Dental assistant', rate: 2600 },
  { key: 'pepper', email: 'pepper@middle-earth.dental', name: 'Pepper Potts', role: 'front_desk', login: true, title: 'Front desk', rate: 2800 },
  { key: 'bilbo', email: 'bilbo@middle-earth.dental', name: 'Bilbo Baggins', role: 'billing', login: true, title: 'Billing', rate: 3100 },
];

// Providers and where they work: [office key, column kind] per weekday (1 = Monday … 5 = Friday).
export const PROVIDERS = [
  { key: 'strange', user: 'strange', name: 'Dr. Stephen Strange, DDS', type: 'dentist', npi: '1316942278', license: 'NY-066613', dea: 'BS6661337', color: '#7c3aed',
    days: { 1: 'stk', 2: 'stk', 3: 'stk', 4: 'stk', 5: 'riv' } },
  { key: 'banner', user: 'banner', name: 'Dr. Bruce Banner, DDS', type: 'dentist', npi: '1629073985', license: 'CO-44871', dea: 'BB4487126', color: '#16a34a',
    days: { 1: 'riv', 2: 'riv', 3: 'riv', 4: 'riv', 5: 'stk' } },
  { key: 'galadriel', user: 'galadriel', name: 'Galadriel of Lorien, RDH', type: 'hygienist', npi: '1932104756', color: '#0ea5e9', days: { 1: 'riv', 2: 'riv', 3: 'riv', 4: 'riv', 5: 'riv' } },
  { key: 'arwen', user: 'arwen', name: 'Arwen Evenstar, RDH', type: 'hygienist', npi: '1447285310', color: '#e11d48', days: { 1: 'riv', 2: 'riv', 4: 'riv' } },
  { key: 'jane', user: 'jane', name: 'Jane Foster, RDH', type: 'hygienist', npi: '1558396427', color: '#f59e0b', days: { 1: 'stk', 2: 'stk', 3: 'stk', 4: 'stk', 5: 'stk' } },
  { key: 'wanda', user: 'wanda', name: 'Wanda Maximoff, RDH', type: 'hygienist', npi: '1669407538', color: '#dc2626', days: { 2: 'stk', 4: 'stk' } },
];

// Operatories per office: a column kind ('dr' or 'hyg') and, for hygiene, whose chair it is.
export const OPERATORIES = [
  { office: 'riv', name: 'Rivendell Op 1', kind: 'dr' }, { office: 'riv', name: 'Rivendell Op 2', kind: 'dr' },
  { office: 'riv', name: 'Rivendell Hygiene 1', kind: 'hyg', hyg: 'galadriel' }, { office: 'riv', name: 'Rivendell Hygiene 2', kind: 'hyg', hyg: 'arwen' },
  { office: 'stk', name: 'Stark Op 1', kind: 'dr' }, { office: 'stk', name: 'Stark Op 2', kind: 'dr' },
  { office: 'stk', name: 'Stark Hygiene 1', kind: 'hyg', hyg: 'jane' }, { office: 'stk', name: 'Stark Hygiene 2', kind: 'hyg', hyg: 'wanda' },
];

// Made-up carriers. ppo: contracted fees as a % of office fees (null = out of network, pays on office fees).
// payDay: weekday the carrier pays (0 = Sunday). electronic: ERAs and EFT; otherwise paper checks and EOBs.
export const CARRIERS = [
  { key: 'gondor', name: 'Gondor Mutual Dental PPO', payer_id: 'GMD01', ppo: 80, payDay: 2, electronic: 1, phone: '(800) 555-0171' },
  { key: 'asgard', name: 'Asgard Health Dental', payer_id: 'ASG22', ppo: 86, payDay: 4, electronic: 1, phone: '(800) 555-0172' },
  { key: 'shield', name: 'Shield Benefits Group', payer_id: 'SHLD7', ppo: null, payDay: 3, electronic: 1, phone: '(800) 555-0173' },
  { key: 'shire', name: 'Shire Cooperative Dental', payer_id: 'SHR04', ppo: 74, payDay: 5, electronic: 0, phone: '(800) 555-0174' },
  { key: 'wakanda', name: 'Wakanda Dental Alliance', payer_id: 'WAK99', ppo: 90, payDay: 1, electronic: 1, phone: '(800) 555-0175' },
  { key: 'rohan', name: 'Rohan Riders Mutual', payer_id: 'ROH12', ppo: null, payDay: 5, electronic: 0, phone: '(800) 555-0176' },
];

// Employer group plans (all fictional employers). [key, carrier, name, group, max, deductible, prev%, basic%, major%, waitMajor, weight, office]
export const PLANS = [
  ['gondor_civil', 'gondor', 'Gondor Civil Service', 'GCS-3019', 150000, 5000, 100, 80, 50, 0, 6, 'riv'],
  ['minas_guard', 'gondor', 'Minas Tirith Guard Union', 'MTG-0417', 200000, 5000, 100, 80, 50, 0, 3, 'riv'],
  ['erebor_mining', 'gondor', 'Erebor Mining Company', 'EMC-2941', 150000, 7500, 100, 70, 50, 12, 3, 'riv'],
  ['stark_ind', 'asgard', 'Stark Industries', 'SI-0001', 250000, 2500, 100, 90, 60, 0, 6, 'stk'],
  ['asgard_royal', 'asgard', 'Asgardian Royal Household', 'ARH-9000', 300000, 0, 100, 90, 60, 0, 2, 'stk'],
  ['pym_tech', 'asgard', 'Pym Technologies', 'PYM-6612', 200000, 5000, 100, 80, 50, 0, 2, 'stk'],
  ['shield_agents', 'shield', 'S.H.I.E.L.D. Agents', 'SHD-0616', 200000, 5000, 100, 80, 50, 0, 5, 'stk'],
  ['daily_bugle', 'shield', 'The Daily Bugle', 'DB-1962', 100000, 5000, 100, 80, 50, 12, 3, 'stk'],
  ['rivendell_scholars', 'shield', 'Rivendell Scholars Guild', 'RSG-3441', 150000, 5000, 100, 80, 50, 0, 2, 'riv'],
  ['shire_post', 'shire', 'Shire Post Office', 'SPO-1420', 100000, 5000, 100, 80, 50, 12, 5, 'riv'],
  ['green_dragon', 'shire', 'Green Dragon Inn Staff', 'GDI-0022', 125000, 5000, 100, 80, 50, 6, 3, 'riv'],
  ['wakanda_design', 'wakanda', 'Wakanda Design Group', 'WDG-0080', 300000, 2500, 100, 90, 70, 0, 4, 'stk'],
  ['rohan_guild', 'rohan', 'Rohan Horse Lords Guild', 'RHL-3019', 150000, 5000, 100, 80, 50, 0, 3, 'riv'],
];

export const MEMBERSHIP_PLANS = [
  { key: 'fellowship', name: 'Fellowship Membership', description: 'Two cleanings, exams and yearly x-rays, plus 15% off everything else.', price: 34900, interval: 'year', discount_pct: 15,
    included: [{ label: 'Cleaning', codes: ['D1110'], per_year: 2 }, { label: 'Exam', codes: ['D0120', 'D0150'], per_year: 2 }, { label: 'Bitewings', codes: ['D0274', 'D0272'], per_year: 1 }], min_age: 18 },
  { key: 'fellowship_monthly', name: 'Fellowship Membership (monthly)', description: 'The Fellowship plan, paid monthly.', price: 3200, interval: 'month', discount_pct: 15,
    included: [{ label: 'Cleaning', codes: ['D1110'], per_year: 2 }, { label: 'Exam', codes: ['D0120', 'D0150'], per_year: 2 }, { label: 'Bitewings', codes: ['D0274', 'D0272'], per_year: 1 }], min_age: 18 },
  { key: 'young_avengers', name: 'Young Avengers Membership', description: 'For kids 17 and under: cleanings, exams, fluoride and x-rays, plus 10% off.', price: 2500, interval: 'month', discount_pct: 10,
    included: [{ label: 'Child cleaning', codes: ['D1120'], per_year: 2 }, { label: 'Exam', codes: ['D0120', 'D0150'], per_year: 2 }, { label: 'Fluoride', codes: ['D1206'], per_year: 2 }, { label: 'Bitewings', codes: ['D0272', 'D0274'], per_year: 1 }], max_age: 17 },
  { key: 'perio_guardians', name: 'Perio Guardians', description: 'Four periodontal maintenance visits a year, plus 15% off.', price: 4500, interval: 'month', discount_pct: 15,
    included: [{ label: 'Perio maintenance', codes: ['D4910'], per_year: 4 }, { label: 'Exam', codes: ['D0120'], per_year: 2 }], min_age: 18 },
];

// Named households. Each: office, street, then members [first, last, dob, gender, relationship, extra].
// The first member is the guarantor. extra: { preferred, alert, medical, perio, member, plan, noIns, inactive }.
export const HOUSEHOLDS = [
  ['riv', 'Bag End, Bagshot Row', [['Frodo', 'Baggins', '1994-09-22', 'male', null, { plan: 'shire_post', alert: 'Old shoulder wound aches in cold weather — keep a blanket handy' }]]],
  ['riv', 'Bag End, Bagshot Row', [['Bilbo', 'Baggins', '1946-09-22', 'male', null, { plan: 'shire_post', alert: 'Eleventy-something and proud of it. Loves a long appointment chat.', medical: ['High blood pressure'] }]]],
  ['riv', '3 Bagshot Row', [['Samwise', 'Gamgee', '1992-04-06', 'male', null, { plan: 'green_dragon', preferred: 'Sam' }], ['Rosie', 'Gamgee', '1993-03-01', 'female', 'spouse'],
    ['Elanor', 'Gamgee', '2017-03-25', 'female', 'child'], ['Frodo', 'Gamgee', '2019-06-12', 'male', 'child', { preferred: 'Frodo-lad' }], ['Rose', 'Gamgee', '2021-02-14', 'female', 'child'], ['Merry', 'Gamgee', '2023-05-02', 'male', 'child']]],
  ['riv', '4 Bagshot Row', [['Hamfast', 'Gamgee', '1948-10-15', 'male', null, { preferred: 'Gaffer', noIns: true, member: 'fellowship', medical: ['Diabetes'] }]]],
  ['riv', 'Great Smials, Tuckborough', [['Paladin', 'Took', '1962-02-10', 'male', null, { plan: 'rohan_guild' }], ['Eglantine', 'Took', '1964-07-19', 'female', 'spouse'],
    ['Peregrin', 'Took', '2005-11-03', 'male', 'child', { preferred: 'Pippin', alert: 'Will ask for second breakfast. And elevenses.' }]]],
  ['riv', 'Brandy Hall, Buckland', [['Saradoc', 'Brandybuck', '1960-05-12', 'male', null, { plan: 'shire_post' }], ['Esmeralda', 'Brandybuck', '1962-09-01', 'female', 'spouse'],
    ['Meriadoc', 'Brandybuck', '2003-08-14', 'male', 'child', { preferred: 'Merry' }]]],
  ['riv', 'Sackville, Hardbottle', [['Lobelia', 'Sackville-Baggins', '1951-06-02', 'female', null, { plan: 'shire_post', alert: 'Keep an eye on the silver spoons in the break room' }], ['Otho', 'Sackville-Baggins', '1949-12-01', 'male', 'spouse']]],
  ['riv', 'The Prancing Pony, Bree', [['Barliman', 'Butterbur', '1963-04-18', 'male', null, { plan: 'green_dragon', alert: 'Forgets messages — send a text and an email' }]]],
  ['riv', 'Citadel Row, Minas Tirith', [['Aragorn', 'Telcontar', '1978-03-01', 'male', null, { plan: 'gondor_civil', preferred: 'Strider' }], ['Arwen', 'Telcontar', '1976-06-21', 'female', 'spouse'],
    ['Eldarion', 'Telcontar', '2019-12-10', 'male', 'child']]],
  ['riv', 'The Citadel, Minas Tirith', [['Denethor', 'Hurin', '1952-01-20', 'male', null, { plan: 'minas_guard', alert: 'Prefers not to discuss the palantir', medical: ['Heart disease'] }]]],
  ['riv', 'White Tower Lane, Minas Tirith', [['Boromir', 'Hurin', '1983-02-05', 'male', null, { plan: 'minas_guard', alert: 'One does not simply skip flossing — remind him' }]]],
  ['riv', 'Emyn Arnen, Ithilien', [['Faramir', 'Hurin', '1986-04-10', 'male', null, { plan: 'gondor_civil' }], ['Eowyn', 'Hurin', '1988-05-11', 'female', 'spouse'], ['Elboron', 'Hurin', '2021-07-04', 'male', 'child']]],
  ['riv', 'Meduseld, Edoras', [['Theoden', 'Eorling', '1954-03-02', 'male', null, { plan: 'rohan_guild', medical: ['Osteoporosis'], perio: true }]]],
  ['riv', 'Aldburg Hall, Eastfold', [['Eomer', 'Eomundson', '1984-11-22', 'male', null, { plan: 'rohan_guild' }]]],
  ['riv', 'Last Homely House', [['Elrond', 'Peredhel', '1960-12-01', 'male', null, { plan: 'rivendell_scholars' }], ['Elladan', 'Peredhel', '2002-02-28', 'male', 'child'], ['Elrohir', 'Peredhel', '2002-02-28', 'male', 'child', { alert: 'Twin of Elladan — double-check which one is in the chair' }]]],
  ['riv', 'Woodland Realm Road', [['Thranduil', 'Greenleaf', '1958-10-10', 'male', null, { noIns: true, member: 'fellowship', alert: 'Very particular about the shade on his veneers' }], ['Legolas', 'Greenleaf', '2004-05-05', 'male', 'child']]],
  ['riv', 'Caras Galadhon Way', [['Celeborn', 'Lorien', '1950-08-08', 'male', null, { plan: 'rivendell_scholars', perio: true }], ['Galadriel', 'Lorien', '1952-01-01', 'female', 'spouse']]],
  ['riv', 'Blue Mountains Road', [['Thorin', 'Oakenshield', '1962-01-08', 'male', null, { plan: 'erebor_mining', alert: 'Grinds his teeth — ask about his night guard', medical: ['Sleep apnea'] }]]],
  ['riv', 'Front Gate, Erebor', [['Dis', 'Durin', '1968-02-17', 'female', null, { plan: 'erebor_mining' }], ['Fili', 'Durin', '2001-03-04', 'male', 'child'], ['Kili', 'Durin', '2003-06-18', 'male', 'child', { alert: 'Always books right after his brother' }]]],
  ['riv', 'Iron Hills Lane', [['Gloin', 'Groinson', '1955-09-12', 'male', null, { plan: 'erebor_mining', perio: true }], ['Gimli', 'Gloinson', '2006-04-30', 'male', 'child', { alert: 'Nobody tosses a dwarf — gentle with the chair recline' }]]],
  ['riv', 'Lonely Mountain Hall', [['Balin', 'Fundinson', '1948-06-19', 'male', null, { plan: 'erebor_mining', perio: true, medical: ['High blood pressure'] }]]],
  ['riv', 'Lonely Mountain Hall', [['Dwalin', 'Fundinson', '1952-07-07', 'male', null, { plan: 'erebor_mining' }]]],
  ['riv', 'Bywater Road', [['Bombur', 'Broadbelt', '1965-11-11', 'male', null, { noIns: true, medical: ['Diabetes', 'Sleep apnea'], alert: 'Needs the wide chair' }]]],
  ['riv', 'Bywater Road', [['Bofur', 'Broadbelt', '1967-03-21', 'male', null, { plan: 'erebor_mining' }]]],
  ['riv', 'Wizard Tower Lane', [['Gandalf', 'Greyhame', '1942-01-01', 'male', null, { noIns: true, member: 'fellowship', alert: 'Is never late — arrives precisely when he means to. Book the first slot.', medical: ['Tobacco use'] }]]],
  ['riv', 'Rhosgobel Cottage', [['Radagast', 'Brown', '1948-04-22', 'male', null, { noIns: true, alert: 'Please ask him to leave the hedgehog in the car' }]]],
  ['riv', 'Orthanc Road', [['Saruman', 'Curunir', '1940-02-02', 'male', null, { plan: 'rohan_guild', inactive: true, alert: 'Left the practice — records requested by another office' }]]],
  ['stk', 'Stark Tower Penthouse', [['Tony', 'Stark', '1970-05-29', 'male', null, { plan: 'stark_ind', alert: 'Will offer to redesign the x-ray sensor. Politely decline.' }], ['Pepper', 'Potts', '1974-09-18', 'female', 'spouse', { preferred: 'Pepper' }],
    ['Morgan', 'Stark', '2018-03-15', 'female', 'child', { alert: 'Loves the prize box — cheeseburger stickers only' }]]],
  ['stk', 'Asgard Embassy Row', [['Odin', 'Borson', '1938-06-06', 'male', null, { plan: 'asgard_royal', medical: ['Heart disease', 'Anticoagulant therapy'], alert: 'Blood thinner — check INR before extractions' }], ['Frigga', 'Borson', '1942-03-20', 'female', 'spouse']]],
  ['stk', 'New Asgard, Tonsberg Lane', [['Thor', 'Odinson', '1982-07-14', 'male', null, { plan: 'asgard_royal', alert: 'Leave the hammer at the front desk, please' }]]],
  ['stk', 'New Asgard, Tonsberg Lane', [['Loki', 'Laufeyson', '1984-12-17', 'male', null, { plan: 'asgard_royal', alert: 'May not be who he says he is — check photo ID at every visit' }]]],
  ['stk', 'Barton Farm Road', [['Clint', 'Barton', '1974-01-07', 'male', null, { plan: 'shield_agents', alert: 'Hard of hearing — face him when speaking' }], ['Laura', 'Barton', '1976-04-19', 'female', 'spouse'],
    ['Cooper', 'Barton', '2010-08-30', 'male', 'child'], ['Lila', 'Barton', '2013-05-11', 'female', 'child'], ['Nathaniel', 'Barton', '2016-01-22', 'male', 'child', { preferred: 'Nate' }]]],
  ['stk', '20 Ingram Street, Queens', [['May', 'Parker', '1966-10-04', 'female', null, { plan: 'daily_bugle' }], ['Peter', 'Parker', '2009-08-10', 'male', 'dependent', { alert: 'Often late — "something came up". Text 30 min before.' }]]],
  ['stk', 'San Francisco Bay Street', [['Scott', 'Lang', '1978-04-06', 'male', null, { plan: 'pym_tech' }], ['Cassie', 'Lang', '2011-11-02', 'female', 'child']]],
  ['stk', 'Pym Lab Lane', [['Hank', 'Pym', '1948-01-04', 'male', null, { plan: 'pym_tech', perio: true }], ['Janet', 'van Dyne', '1950-03-15', 'female', 'spouse'], ['Hope', 'van Dyne', '1985-09-20', 'female', 'child']]],
  ['stk', 'Golden City Way', [['Ramonda', 'Udaku', '1962-06-01', 'female', null, { plan: 'wakanda_design' }], ['Shuri', 'Udaku', '2008-08-08', 'female', 'child', { alert: 'Will ask to see the software. Show her the x-ray viewer.' }]]],
  ['stk', 'Golden City Way', [["T'Challa", 'Udaku', '1979-11-29', 'male', null, { plan: 'wakanda_design' }]]],
  ['stk', 'Golden City Way', [['Okoye', 'Milaje', '1982-02-02', 'female', null, { plan: 'wakanda_design' }]]],
  ['stk', 'Jersey City Avenue', [['Yusuf', 'Khan', '1972-01-15', 'male', null, { plan: 'daily_bugle' }], ['Muneeba', 'Khan', '1974-07-07', 'female', 'spouse'], ['Kamala', 'Khan', '2010-09-01', 'female', 'child']]],
  ['stk', 'Brooklyn Heights Place', [['Jefferson', 'Morales', '1976-03-03', 'male', null, { plan: 'shield_agents' }], ['Rio', 'Morales', '1978-10-12', 'female', 'spouse'], ['Miles', 'Morales', '2012-08-03', 'male', 'child']]],
  ['stk', 'Brooklyn Walk-up', [['Steve', 'Rogers', '1982-07-04', 'male', null, { plan: 'shield_agents', alert: 'Always on time. Early, actually.' }]]],
  ['stk', 'Brooklyn Walk-up', [['Bucky', 'Barnes', '1981-03-10', 'male', null, { plan: 'shield_agents', alert: 'Prosthetic left arm — use the right arm for blood pressure' }]]],
  ['stk', 'Undisclosed Location', [['Natasha', 'Romanoff', '1984-11-22', 'female', null, { plan: 'shield_agents', alert: 'Prefers the chair facing the door' }]]],
  ['stk', 'Undisclosed Location', [['Yelena', 'Belova', '1995-06-10', 'female', null, { noIns: true, member: 'fellowship_monthly' }]]],
  ['stk', 'Harlem Avenue', [['Sam', 'Wilson', '1978-09-23', 'male', null, { plan: 'shield_agents' }]]],
  ['stk', 'Philadelphia Road', [['James', 'Rhodes', '1968-10-06', 'male', null, { plan: 'stark_ind', preferred: 'Rhodey' }]]],
  ['stk', 'Stark Tower Staff Quarters', [['Happy', 'Hogan', '1971-11-16', 'male', null, { plan: 'stark_ind', alert: 'Will ask about the parking validation' }]]],
  ['stk', '177A Sanctum Street', [['Wong', 'Kamar-Taj', '1975-03-08', 'male', null, { noIns: true, member: 'fellowship' }]]],
  ['stk', 'Triskelion Drive', [['Nick', 'Fury', '1962-12-21', 'male', null, { plan: 'shield_agents', alert: 'Eye patch — no concerns for treatment. Do not ask about it.' }]]],
  ['stk', 'Triskelion Drive', [['Phil', 'Coulson', '1970-07-08', 'male', null, { plan: 'shield_agents', alert: 'Collects vintage trading cards — great small-talk topic' }]]],
  ['stk', 'Hells Kitchen Avenue', [['Matt', 'Murdock', '1983-12-13', 'male', null, { plan: 'daily_bugle', alert: 'Blind — read forms aloud; offer an arm to the chair' }]]],
  ['stk', 'Hells Kitchen Avenue', [['Foggy', 'Nelson', '1983-05-22', 'male', null, { plan: 'daily_bugle' }]]],
  ['stk', 'Hells Kitchen Avenue', [['Karen', 'Page', '1988-08-18', 'female', null, { plan: 'daily_bugle' }]]],
  ['stk', 'Alias Investigations', [['Jessica', 'Jones', '1986-02-14', 'female', null, { noIns: true, alert: 'Collect balance before seating', medical: ['Tobacco use'] }]]],
  ['stk', 'Harlem Avenue', [['Luke', 'Cage', '1980-07-17', 'male', null, { plan: 'shield_agents', alert: 'Unbreakable skin — topical anesthetic only, apparently' }]]],
  ['stk', 'Rand Tower', [['Danny', 'Rand', '1990-01-19', 'male', null, { plan: 'stark_ind' }]]],
  ['stk', 'Bed-Stuy Row', [['Kate', 'Bishop', '1999-04-11', 'female', null, { plan: 'daily_bugle' }]]],
  ['stk', 'Knowhere Station', [['Peter', 'Quill', '1980-06-24', 'male', null, { noIns: true, alert: 'Please do not change the office playlist' }]]],
  ['stk', 'Sokovia Street', [['Pietro', 'Maximoff', '1990-03-12', 'male', null, { plan: 'stark_ind', alert: 'Talks fast. Very fast.' }]]],
  ['stk', 'Midtown High Row', [['Harley', 'Keener', '2004-05-05', 'male', null, { plan: 'stark_ind' }]]],
  ['stk', 'Midtown Queens Place', [['Theresa', 'Leeds', '1975-02-02', 'female', null, { plan: 'daily_bugle' }], ['Ned', 'Leeds', '2009-06-06', 'male', 'child', { alert: 'Ask him about his LEGO build' }]]],
  ['stk', 'Midtown Queens Place', [['Michelle', 'Jones', '2009-11-11', 'female', null, { plan: 'daily_bugle', preferred: 'MJ' }]]],
  ['stk', 'Sakaar Heights', [['Korg', 'Kronan', '1970-01-01', 'male', null, { noIns: true, alert: 'Made of rocks. Diamond burs only. Very polite.' }]]],
  ['stk', 'Xavier School Road', [['Carol', 'Danvers', '1968-10-24', 'female', null, { plan: 'shield_agents', alert: 'Travels a lot — book recall far ahead' }]]],
];

// Generic names to reach scale. Rivendell's households lean Middle-earth, Stark Tower's lean Marvel.
export const ME_FIRST_M = ['Adalgrim', 'Andwise', 'Anson', 'Bandobras', 'Berilac', 'Bingo', 'Bodo', 'Bungo', 'Cotman', 'Dinodas', 'Doderic', 'Drogo', 'Dudo', 'Erling', 'Everard', 'Falco', 'Fastred', 'Ferdibrand',
  'Filibert', 'Fosco', 'Gorbadoc', 'Griffo', 'Halfred', 'Hamson', 'Hobson', 'Holfast', 'Hugo', 'Ilberic', 'Isembard', 'Largo', 'Longo', 'Marmadoc', 'Milo', 'Moro', 'Mungo', 'Odo', 'Olo', 'Posco', 'Ponto',
  'Reginard', 'Robin', 'Rudigar', 'Sadoc', 'Sancho', 'Seredic', 'Tobold', 'Wilibald', 'Wilcome', 'Anborn', 'Baranor', 'Beregond', 'Bergil', 'Damrod', 'Derufin', 'Duilin', 'Elfhelm', 'Erkenbrand', 'Forlong',
  'Gamling', 'Grimbold', 'Halbarad', 'Hama', 'Hirgon', 'Hirluin', 'Ingold', 'Iorlas', 'Mablung', 'Targon', 'Deorwine', 'Dunhere', 'Ceorl', 'Eothain', 'Gleowine', 'Haldir', 'Rumil', 'Orophin', 'Lindir', 'Erestor'];
export const ME_FIRST_F = ['Adamanta', 'Amaranth', 'Angelica', 'Asphodel', 'Belba', 'Belladonna', 'Berylla', 'Camellia', 'Celandine', 'Daisy', 'Diamond', 'Donnamira', 'Dora', 'Elanor', 'Estella', 'Gilly',
  'Goldilocks', 'Hanna', 'Hilda', 'Lily', 'Linda', 'Malva', 'Marigold', 'Melilot', 'Menegilda', 'Mentha', 'Mimosa', 'Mirabella', 'Myrtle', 'Pansy', 'Pearl', 'Peony', 'Pervinca', 'Pimpernel', 'Primrose',
  'Primula', 'Prisca', 'Rosamunda', 'Ruby', 'Salvia', 'Tanta', 'Morwen', 'Finduilas', 'Ioreth', 'Lothiriel', 'Theodwyn', 'Elfhild', 'Firiel', 'Gilraen', 'Idril', 'Nimloth', 'Nienor', 'Nellas', 'Mithrellas'];
export const ME_LAST = ['Proudfoot', 'Bolger', 'Chubb', 'Boffin', 'Bracegirdle', 'Burrows', 'Goodbody', 'Grubb', 'Hornblower', 'Sandyman', 'Underhill', 'Whitfoot', 'Cotton', 'Twofoot', 'Brockhouse', 'Greenhand',
  'Tunnelly', 'Longhole', 'Hayward', 'Roper', 'Smallburrow', 'Banks', 'Goldworthy', 'Gardner', 'Goodchild', 'Heathertoes', 'Ferny', 'Goatleaf', 'Appledore', 'Thistlewool', 'Mugwort', 'Puddifoot', 'Rumble',
  'Noakes', 'Button', 'Brownlock', 'Oldbuck', 'Fairbairn', 'Harfoot', 'Stoor', 'Greenhill', 'Deephallow', 'Westfold', 'Eastfold', 'Dunharrow', 'Lossarnach', 'Pelargir', 'Anorien', 'Lebennin', 'Belfalas',
  'Morthond', 'Ringlo', 'Stonehelm', 'Ironfoot', 'Broadbeam', 'Stonefoot', 'Blacklock', 'Longbeard', 'Firebeard', 'Stiffbeard', 'Silverbrook', 'Willowbank', 'Mossgrove', 'Riverdown', 'Oakhollow'];
export const MV_FIRST_M = ['Jasper', 'Erik', 'Leo', 'Lance', 'Alphonso', 'Grant', 'Antoine', 'Flash', 'Harry', 'Otto', 'Curt', 'Max', 'Hobie', 'Aaron', 'Eddie', 'Ben', 'Reed', 'Johnny', 'Victor', 'Warren',
  'Hank', 'Kurt', 'Remy', 'Logan', 'Bobby', 'Piotr', 'Jamie', 'Sam', 'Everett', 'Marc', 'Steven', 'Jake', 'Kaz', 'Arthur', 'Norman', 'Adrian', 'Quentin', 'Mac', 'Brock', 'Dane', 'Amadeus', 'Bruno', 'Teddy',
  'Billy', 'Tommy', 'Eli', 'Nico', 'Chase', 'Gert', 'Karolina', 'Victor', 'Dario', 'Malik', 'Omar', 'Rafael', 'Tariq', 'Xavier', 'Mateo', 'Kai', 'Javier'];
export const MV_FIRST_F = ['Darcy', 'Jemma', 'Daisy', 'Melinda', 'Bobbi', 'Elena', 'Gwen', 'Felicia', 'Betty', 'Mary Jane', 'Liz', 'Gloria', 'Sue', 'Jean', 'Ororo', 'Kitty', 'Rogue', 'Jubilee', 'Emma',
  'Betsy', 'Rahne', 'Dani', 'Illyana', 'Monica', 'Maria', 'Christine', 'Sharon', 'Valerie', 'Trish', 'Misty', 'Colleen', 'Jen', 'Riri', 'Doreen', 'Nadia', 'Aisha', 'Amara', 'Anya', 'Beatriz', 'Camila',
  'Esme', 'Farah', 'Hana', 'Ines', 'Iris', 'Kira', 'Lena', 'Maya', 'Noor', 'Priya', 'Quinn', 'Rosa', 'Sofia', 'Tess', 'Uma', 'Wren', 'Yara', 'Zoe'];
export const MV_LAST = ['Sitwell', 'Selvig', 'Simmons', 'Fitz', 'Mackenzie', 'Morse', 'Hunter', 'Koenig', 'Triplett', 'Leeds', 'Thompson', 'Osborn', 'Octavius', 'Connors', 'Dillon', 'Brock', 'Jameson', 'Urich',
  'Robertson', 'Watson', 'Stacy', 'Hardy', 'Toomes', 'Nelson', 'Page', 'Castle', 'Rand', 'Wing', 'Knight', 'Hogarth', 'Walker', 'Summers', 'Grey', 'Munroe', 'Drake', 'Worthington', 'McCoy', 'Rasputin',
  'Pryde', 'Wagner', 'LeBeau', 'Braddock', 'Guthrie', 'Madrox', 'Blaire', 'Richards', 'Storm', 'Grimm', 'Brandt', 'Beck', 'Van Lunt', 'Spector', 'Lockley', 'Grant', 'Cho', 'Cross', 'Hammer', 'Ross',
  'Talbot', 'Carter', 'Sousa', 'Thompson', 'Dugan', 'Jarvis', 'Rambeau', 'Hayward', 'Kaplan', 'Altman', 'Bishop', 'Lang', 'Minoru', 'Yorkes', 'Dean', 'Stein', 'Wilder', 'Alvarez', 'Reyes', 'Santini'];

export const ME_STREETS = ['Bagshot Row', 'Hobbiton Hill Road', 'Bywater Lane', 'Buckland Way', 'Greenway', 'Stock Road', 'Brandywine Bridge Road', 'Tuckborough Lane', 'Michel Delving Street', 'Waymeet Road',
  'Frogmorton Row', 'Longbottom Lane', 'Staddle Street', 'Combe Road', 'Archet Way', 'Westmarch Road', 'Edoras Hill Road', 'Helms Deep Drive', 'Westfold Road', 'Osgiliath Crossing', 'Pelennor Way', 'Dol Amroth Road'];
export const MV_STREETS = ['Bleecker Street', 'Ingram Street', 'Baxter Way', 'Avengers Drive', 'Xavier Road', 'Stark Plaza', 'Wakanda Way', 'Asgard Lane', 'Midtown Avenue', 'Hells Kitchen Avenue', 'Harlem Avenue',
  'Queens Boulevard', 'Brooklyn Place', 'Alias Street', 'Sanctum Place', 'Latveria Court', 'Genosha Road', 'Sokovia Street', 'Madripoor Lane', 'Attilan Avenue'];
export const ME_TOWNS = [['Rivendell', 'CO', '80424'], ['Bree', 'CO', '80435'], ['Hobbiton', 'CO', '80443'], ['Edoras', 'CO', '80461']];
export const MV_TOWNS = [['New York', 'NY', '10036'], ['Queens', 'NY', '11375'], ['Brooklyn', 'NY', '11201'], ['Jersey City', 'NJ', '07302']];

export const ALLERGIES = [null, null, null, null, null, null, 'Penicillin', 'Latex', 'Codeine', 'Sulfa', 'Ibuprofen', 'Mithril (contact dermatitis)', 'Shellfish'];
export const MEDICATIONS = [null, null, null, null, 'Lisinopril 10 mg daily', 'Metformin 500 mg twice daily', 'Atorvastatin 20 mg daily', 'Levothyroxine 50 mcg daily', 'Albuterol inhaler as needed',
  'Sertraline 50 mg daily', 'Warfarin 5 mg daily', 'Amlodipine 5 mg daily', 'Alendronate 70 mg weekly'];
export const CONDITIONS_BY_MED = {
  'Lisinopril 10 mg daily': ['High blood pressure'], 'Metformin 500 mg twice daily': ['Diabetes'], 'Levothyroxine 50 mcg daily': ['Thyroid disorder'], 'Albuterol inhaler as needed': ['Asthma'],
  'Warfarin 5 mg daily': ['Anticoagulant therapy'], 'Amlodipine 5 mg daily': ['High blood pressure'], 'Alendronate 70 mg weekly': ['Bisphosphonates', 'Osteoporosis'],
};
export const OFFICE_ALERTS = [null, null, null, null, null, null, null, null, 'Prefers text, not calls', 'Anxious — offer nitrous and headphones', 'Runs late — book the first slot',
  'Collect balance before seating', 'Prefers morning appointments', 'Brings a service dog', 'Needs a parent present (minor)', 'Prefers Dr. Strange', 'Prefers Dr. Banner — calm voice appreciated'];

// Where new patients hear about us: [referral_source text, marketing source key, weight].
export const REFERRAL_SOURCES = [
  ['Google search', 'google_ads', 5], ['Google Business Profile', 'gbp', 5], ['Friend or family', 'patient_ref', 7], ['Insurance directory', 'directory', 3], ['Instagram', 'instagram', 2],
  ['Facebook', 'facebook', 2], ['Shire Gazette mailer', 'mailer', 2], ['Stark Expo smile booth', 'event', 1], ['Walked by the office', 'walkin', 1], ['Dr. referral', 'doctor_ref', 1],
];
export const MARKETING_SOURCES = [
  { key: 'google_ads', channel: 'google_ads', name: 'Google Ads — search', monthly: 120000 },
  { key: 'gbp', channel: 'google_business', name: 'Google Business Profile', monthly: 0 },
  { key: 'patient_ref', channel: 'referral_patient', name: 'Patient referrals', monthly: 0 },
  { key: 'directory', channel: 'insurance_directory', name: 'Insurance directories', monthly: 0 },
  { key: 'instagram', channel: 'instagram', name: 'Instagram', monthly: 35000 },
  { key: 'facebook', channel: 'facebook', name: 'Facebook ads', monthly: 45000 },
  { key: 'mailer', channel: 'mailer', name: 'Shire Gazette mailer', monthly: 60000 },
  { key: 'event', channel: 'event', name: 'Community events', monthly: 25000 },
  { key: 'walkin', channel: 'walk_in', name: 'Walk-ins', monthly: 0 },
  { key: 'doctor_ref', channel: 'referral_doctor', name: 'Doctor referrals', monthly: 0 },
];
export const MARKETING_CAMPAIGNS = [
  { source: 'mailer', name: 'Second Breakfast Special — free whitening for new patients', promo: 'SECONDBREAKFAST', utm: null },
  { source: 'event', name: 'Stark Expo smile booth', promo: 'STARKEXPO', utm: null },
  { source: 'google_ads', name: 'New Year, New Smile', promo: null, utm: 'new-year-new-smile' },
  { source: 'event', name: 'Hobbiton Harvest Fair', promo: 'HARVESTFAIR', utm: null },
  { source: 'instagram', name: 'Avengers Assemble — family checkups', promo: null, utm: 'avengers-assemble' },
];

export const REFERRAL_CONTACTS = [
  { key: 'elrond_endo', name: 'Dr. Erestor Lindon, DDS', practice_name: 'Lindon Endodontics', specialty: 'Endodontics', phone: '(970) 555-0181' },
  { key: 'pym_endo', name: 'Dr. Bill Foster, DDS', practice_name: 'Quantum Root Canal Specialists', specialty: 'Endodontics', phone: '(212) 555-0182' },
  { key: 'cho_perio', name: 'Dr. Helen Cho, DMD', practice_name: 'Cho Regenerative Periodontics', specialty: 'Periodontics', phone: '(212) 555-0183' },
  { key: 'palmer_os', name: 'Dr. Christine Palmer, DDS', practice_name: 'Metro-General Oral Surgery', specialty: 'Oral surgery', phone: '(212) 555-0184' },
  { key: 'isildur_os', name: 'Dr. Ioreth Houses, DDS', practice_name: 'Houses of Healing Oral Surgery', specialty: 'Oral surgery', phone: '(970) 555-0185' },
  { key: 'erebor_ortho', name: 'Dr. Nori Stonehelm, DMD', practice_name: 'Erebor Orthodontics', specialty: 'Orthodontics', phone: '(970) 555-0186' },
  { key: 'mcCoy_md', name: 'Dr. Hank McCoy, MD', practice_name: 'Xavier Medical Group', specialty: 'Physician', phone: '(212) 555-0187' },
  { key: 'bree_gp', name: 'Dr. Butterbur Heathertoes, DDS', practice_name: 'Bree General Dentistry', specialty: 'General dentistry', phone: '(970) 555-0188' },
];

export const LABS = ['Moria Mithril Dental Lab', 'Erebor Ceramics', 'Wakanda Vibranium Lab', 'Stark Industries Prosthetics'];

export const DENIALS = [
  'Frequency limitation — prophylaxis covered twice per benefit year',
  'Missing tooth clause — tooth missing before coverage began',
  'Patient not eligible on the date of service',
  'Pre-authorization required for this procedure',
  'Radiographs required — please resubmit with the x-ray attached',
  'Duplicate claim — already processed',
  'Waiting period for major services not yet met',
];

// Short, plausible, professional notes, with a light touch of the theme now and then.
export const HYGIENE_NOTES = [
  'Periodic exam and adult prophy. Light calculus on lower anteriors. OHI reviewed; pt flosses "most days". No complaints.',
  'Recall visit. Generalized mild plaque, gingiva pink and firm. BWX taken, no new decay. Pt reports no sensitivity.',
  'Prophy completed. Moderate stain from tea — polished. Discussed whitening options. Next recall in 6 months.',
  'Exam and cleaning. Pt reports sensitivity to cold on the upper right; recommended a sensitivity toothpaste and will monitor.',
  'Routine recall. Tissue healthy. Pt says the long journey went well and still found time to floss. Good home care.',
  'Prophy and exam. Localized bleeding UL molars; reinforced flossing technique. No radiographic changes.',
  'Recall. Pt reports clenching during stressful weeks; discussed a night guard. Wear facets noted on canines.',
  'Cleaning and exam. Excellent home care — keep up the good work. Fluoride varnish offered and declined.',
];
export const CHILD_NOTES = [
  'Child prophy and exam. Fluoride varnish applied. Good cooperation; picked a sticker from the prize box.',
  'Recall. Brushing chart reviewed with parent. Sealants intact. No caries detected.',
  'Child prophy. Mild plaque on lower molars; showed brushing on a model. Pt was very brave.',
  'Exam and cleaning. Mixed dentition progressing normally. Parent asked about orthodontics — will re-evaluate next visit.',
];
export const PERIO_NOTES = [
  'Periodontal maintenance. Probing depths stable, 4 mm pockets UL molars with BOP. Reinforced interdental brushes.',
  'Perio maintenance. Localized 5 mm pockets LR, BOP. Discussed 3-month interval; pt agrees.',
  'Perio maintenance with full-mouth probing. Improvement since last visit; bleeding down noticeably.',
];
export const NP_NOTES = [
  'New patient comprehensive exam, FMX and prophy. Medical history reviewed. Treatment needs discussed and plan presented.',
  'Comprehensive exam for new pt. Moderate calculus, several areas of recurrent decay noted. Plan reviewed; pt will call to schedule.',
  'New patient. Came recommended by a friend from the Shire. Comprehensive exam and x-rays; healthy overall, one watch area.',
];
export const RESTORATIVE_NOTES = [
  'Local anesthesia: 1 carpule 2% lido 1:100k. Isolation with rubber dam. Caries removed, composite placed and cured. Occlusion checked. Pt tolerated well.',
  'Composite restoration completed. Shade A2. Contacts and occlusion verified. Post-op instructions given.',
  'Restoration placed without complications. Pt comfortable throughout; asked if the drill could be quieter "like an Iron Man repulsor".',
];
export const CROWN_NOTES = [
  'Crown prep, core buildup. Final impression taken, temporary cemented with TempBond. Shade A2 selected. Case sent to the lab.',
  'Crown preparation completed. Digital scan sent to the lab. Temporary in place; reviewed care of the temporary.',
];
export const SEAT_NOTES = ['Crown seated. Margins and contacts verified, occlusion adjusted. Cemented with RMGI. Pt happy with the shade.', 'Crown delivered and cemented. Floss passes contacts. Pt pleased.'];
export const ENDO_NOTES = ['Root canal therapy completed. Canals located, cleaned and shaped, obturated. Temporary placed; crown recommended.', 'Endo completed without complications. Post-op instructions and ibuprofen regimen reviewed.'];
export const EXT_NOTES = ['Extraction completed. Hemostasis achieved with gauze. Post-op instructions given verbally and in writing.', 'Surgical extraction with sectioning. Sutures placed. Pt tolerated well; follow-up in one week.'];
export const EMERGENCY_NOTES = [
  'Limited exam for pain. PA taken; deep caries with symptomatic pulpitis. Discussed root canal vs extraction.',
  'Emergency visit: fractured cusp after biting on something hard ("a lembas crumb, allegedly"). Smoothed and planned for a crown.',
  'Limited exam: food impaction and localized gingivitis. Irrigated, OHI given. No further treatment needed today.',
];
export const IMPLANT_NOTES = ['Implant placed with good primary stability. Healing abutment placed. Post-op reviewed.', 'Implant abutment and crown delivered. Occlusion checked, screw access sealed.'];

export const REVIEW_TEXTS = [
  [5, 'Best dental office in all of Middle-earth. Galadriel is gentle and Pepper had me checked in before I could say "second breakfast".'],
  [5, 'Dr. Strange explained everything clearly and even showed me my x-rays. No waiting at all.'],
  [5, 'Wonderful with my kids. They talk about the prize box more than the cleaning!'],
  [5, 'I was nervous about my root canal but Dr. Banner kept me completely calm. Highly recommend.'],
  [4, 'Great care and friendly staff. Parking near Stark Tower is tricky, so give yourself extra time.'],
  [5, 'Quick, painless, and they sent reminders by text so I actually remembered my appointment.'],
  [5, 'The billing team (thanks Bilbo!) sorted out my insurance in one call.'],
  [4, 'Very thorough cleaning. A bit of a wait on a busy Monday but worth it.'],
  [3, 'Care was good but I had to call twice about my statement.'],
  [5, 'Found a small cavity early and fixed it the same week. Couldn\'t ask for more.'],
  [5, 'Everyone here is kind. They remembered my name and my favorite music.'],
  [2, 'My appointment was moved at the last minute. The staff apologized, but it was a hassle.'],
  [5, 'Arwen is the best hygienist I have ever had. Truly an elf among hygienists.'],
];
export const REVIEW_REPLIES = ['Thank you so much — we loved seeing you! See you at your next visit.', 'Thanks for the kind words! We will pass them on to the team.',
  'We are sorry about the trouble and would love to make it right — please give our office manager a call.'];

export const INBOUND_TEXTS = ['C', 'Yes, see you then!', 'Can I come in 15 minutes later?', 'Do you take Asgard Health Dental?', 'Running a few minutes late, sorry!', 'Is there anything sooner this week?',
  'Confirmed', 'Can I move my appointment to next week?', 'Thanks for the reminder!', 'My tooth has been bothering me since yesterday, can someone call me?'];

export const TASKS = [
  ['Call Shire Cooperative Dental about a denied claim', 'high', 'bilbo'], ['Order more gloves (size M) for Stark Tower', 'normal', 'hill'], ['Send pre-authorization for a crown', 'normal', 'bilbo'],
  ['Follow up on lab case from Erebor Ceramics', 'normal', 'sam'], ['Confirm tomorrow\'s new patients', 'high', 'pepper'], ['Update Gondor Mutual fee schedule', 'low', 'bilbo'],
  ['Call patient about unscheduled treatment', 'normal', 'pepper'], ['Review aging report over 90 days', 'normal', 'bilbo'], ['Restock the prize box (cheeseburger stickers)', 'low', 'pepper'],
  ['Schedule staff CPR recertification', 'normal', 'hill'], ['Check sterilizer spore test results', 'high', 'sam'], ['Post December holiday hours', 'low', 'hill'],
];
