// Where the practice's money goes, in the buckets dental practices are usually measured by. Each bank line
// and each QuickBooks expense account falls into one. Ranges are the share of collections a healthy general
// practice typically spends (industry surveys; a guide, not a rule).
export const CATEGORIES = {
  staff: { label: 'Team wages & benefits', overhead: true, typical: [24, 28] },
  doctor: { label: 'Doctor pay (associates, owner salary)', overhead: false, typical: [25, 35] },
  supplies: { label: 'Dental supplies', overhead: true, typical: [5, 6] },
  lab: { label: 'Lab fees', overhead: true, typical: [8, 10] },
  facility: { label: 'Rent, utilities & upkeep', overhead: true, typical: [5, 7] },
  marketing: { label: 'Marketing', overhead: true, typical: [3, 5] },
  equipment: { label: 'Equipment & repairs', overhead: true, typical: [1, 3] },
  admin: { label: 'Office, software & professional fees', overhead: true, typical: [4, 6] },
  fees: { label: 'Card & bank fees', overhead: true, typical: [1, 2] },
  financing: { label: 'Loans & interest', overhead: false, typical: null },
  taxes: { label: 'Taxes', overhead: false, typical: null },
  other: { label: 'Other expenses', overhead: true, typical: null },
  // Not expenses: money moving between the owner's or practice's own accounts, and money coming in.
  owner: { label: 'Owner draws & distributions', overhead: false, expense: false },
  transfer: { label: 'Transfers & card payments', overhead: false, expense: false },
  income: { label: 'Income', overhead: false, expense: false },
};
export const isExpense = (c) => c in CATEGORIES && CATEGORIES[c].expense !== false;
export const TYPICAL_OVERHEAD = [59, 62];

// Name → category, first match wins. Written for bank descriptions ("HENRY SCHEIN INC 800-…") and for
// QuickBooks account names ("Payroll Expenses:Wages").
const RULES = [
  ['owner', /owner'?s? (draw|distribution|equity)|shareholder distribution|\bdraw\b|distribution/i],
  ['transfer', /transfer|xfer|credit card payment|card payment|payment - thank you|autopay payment|amex epayment|chase card|online payment to|zelle to self/i],
  ['doctor', /officer|associate (dentist|doctor)|doctor (pay|comp|salar)|dds comp|owner salar|guaranteed payment/i],
  ['fees', /merchant|processing fee|card fee|stripe fee|square fee|bank (service )?(charge|fee)|service charge|wire fee|nsf|overdraft|fee - /i],
  ['staff', /payroll|gusto|adp\b|paychex|wages|salar|bonus|401 ?k|retirement|health ins|dental benefits|benefit|employee|hygien|workers comp|uniform|payroll tax|futa|suta|fica/i],
  ['lab', /\blab\b|laborator|glidewell|dental arts|nobel|straumann|clear ?correct|invisalign|align technology|burbank dental/i],
  ['supplies', /henry schein|patterson|benco|darby|dental city|net32|safco|supplies - dental|dental suppl|clinical suppl|medical suppl|ultradent|dentsply|3m oral|septodont|scheinmail/i],
  ['facility', /rent|lease (payment|- office)|landlord|propert|utilit|electric|power & light|energy|water|sewer|gas co|janitor|cleaning serv|trash|waste|pest|repairs? & maint|maintenance|building|hvac|security system|alarm/i],
  ['marketing', /advertis|marketing|google ads|google \*ads|facebook|meta ads|yelp|seo|website|promotion|mailer|signage|referral gift|swag/i],
  ['equipment', /equipment|depreciation|amortization|a-dec|planmeca|carestream|dexis|sirona|handpiece|repair - equip|biolase|itero/i],
  ['financing', /interest|loan|note payable|sba|bank of america practice|practice loan|equipment financ/i],
  ['taxes', /\birs\b|tax payment|franchise tax|comptroller|dept of revenue|property tax|state tax/i],
  ['admin', /software|dentrix|eaglesoft|open dental|weave|nexhealth|lighthouse|solutionreach|microsoft|google workspace|gsuite|zoom|adobe|dropbox|office suppl|staples|office depot|amazon|telephone|phone|internet|comcast|at&t|verizon|spectrum|postage|usps|fedex|ups|accounting|bookkeep|cpa|legal|attorney|consult|dues|subscription|license|continuing ed|\bce\b|seminar|insurance|malpractice|liability|travel|meals|parking|uber|lyft|airline|hotel|professional fees|clearinghouse|dental ?xchange|vyne|onederful/i],
];

// Plaid's own category for a line, when the name alone doesn't say.
const PLAID_PFC = {
  INCOME: 'income', TRANSFER_IN: 'transfer', TRANSFER_OUT: 'transfer', LOAN_PAYMENTS: 'financing', BANK_FEES: 'fees',
  RENT_AND_UTILITIES: 'facility', HOME_IMPROVEMENT: 'facility', MEDICAL: 'supplies', GENERAL_SERVICES: 'admin',
  GOVERNMENT_AND_NON_PROFIT: 'taxes', TRAVEL: 'admin', FOOD_AND_DRINK: 'admin', GENERAL_MERCHANDISE: 'other', ENTERTAINMENT: 'other',
};

export function categorize(text, { amount = -1, providerCategory, accountType } = {}) {
  // QuickBooks account types say a lot on their own.
  if (accountType && /income/i.test(accountType)) return 'income';
  if (accountType && /cost of goods/i.test(accountType) && /lab/i.test(text)) return 'lab';
  if (accountType && /cost of goods/i.test(accountType)) return 'supplies';
  // Money in is income unless it's the practice's own money moving between accounts.
  // Card payouts and insurance EFTs often say "transfer" but are the practice's income.
  if (amount > 0 && /stripe|square|payout|bankcard|merch(ant)? (dep|settle)|hcclaimpmt|claim ?pmt|carecredit|sunbit|cherry|deposit/i.test(text || '')) return 'income';
  if (amount > 0) return RULES.slice(0, 2).find(([, re]) => re.test(text || ''))?.[0] || 'income';
  for (const [cat, re] of RULES) if (re.test(text || '')) return cat;
  // Plaid's detailed categories start with the primary one ("RENT_AND_UTILITIES_RENT").
  const pc = String(providerCategory || '').toUpperCase();
  const primary = Object.keys(PLAID_PFC).find((k) => pc === k || pc.startsWith(`${k}_`));
  return primary ? PLAID_PFC[primary] : 'other';
}

// The practice's own rules ("GUSTO" → staff), checked before the built-in ones.
export function applyRules(rules, text) {
  const t = String(text || '').toLowerCase();
  const hit = rules.find((r) => t.includes(String(r.pattern).toLowerCase()));
  return hit ? hit.category : null;
}
