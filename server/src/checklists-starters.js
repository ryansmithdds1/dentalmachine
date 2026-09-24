// Starter checklists the owner can add with one click (RCL1). They are a starting point, not a legal standard:
// each is marked "adapt to your office and state rules" on screen, and every line can be edited after adding.
// Numbers follow common US guidance (CDC dental infection control, OSHA bloodborne pathogens, manufacturers'
// instructions) — the office's own equipment instructions and state board rules win.
//
// position: the position the checklist belongs to (made if the practice doesn't have it; role = who is in it
// by default). Items: see checklist_items in db.js for the fields.
export const STARTERS = [
  {
    key: 'sterilization', name: 'Sterilization', position: 'Sterilization', role: 'assistant',
    description: 'Daily autoclave log and the weekly spore test (biological monitoring).',
    items: [
      {
        title: 'Autoclave: record the cycle temperature', cadence: 'daily', due_time: '10:00', result_type: 'number', min_value: '250', max_value: '275', unit: '°F',
        critical: 1, instructions: 'Read the peak temperature from the first cycle of the day (printout or display). Most sterilizers run 250 °F (gravity) or 270–273 °F (pre-vacuum): use your sterilizer’s own range.',
      },
      { title: 'Chemical indicator on every pack changed color', cadence: 'daily', due_time: '17:00', result_type: 'pass_fail', instructions: 'Check the internal/external indicators on today’s loads. Any pack that didn’t change is reprocessed.' },
      {
        title: 'Weekly spore test (biological indicator)', cadence: 'weekly', weekday: 1, due_time: '12:00', result_type: 'pass_fail', require_photo: 1, critical: 1,
        instructions: 'Run the BI in a normal load, incubate test and control (or mail it to the monitoring service). Record pass or fail and photograph the vials or the lab report. A failed test: take the sterilizer out of service and tell the office manager now.',
      },
    ],
  },
  {
    key: 'front-desk', name: 'Front desk: open and close', position: 'Front desk', role: 'front_desk',
    description: 'Opening and closing the front desk every day.',
    items: [
      { title: 'Open: lights, alarm off, computers and phones on', cadence: 'daily', due_time: '07:45' },
      { title: 'Open: check voicemail and overnight messages', cadence: 'daily', due_time: '08:15' },
      { title: 'Open: huddle sheet printed and today’s schedule checked', cadence: 'daily', due_time: '08:15' },
      { title: 'Confirm tomorrow’s unconfirmed patients', cadence: 'daily', due_time: '14:00' },
      { title: 'Close: balance the cash drawer (over/short in dollars)', cadence: 'daily', due_time: '17:30', result_type: 'number', min_value: '-5', max_value: '5', unit: '$' },
      { title: 'Close: end-of-day run and deposit ready', cadence: 'daily', due_time: '17:30' },
      { title: 'Close: computers locked, alarm set, doors locked', cadence: 'daily', due_time: '18:00' },
    ],
  },
  {
    key: 'hygiene-room', name: 'Hygiene room setup', position: 'Hygiene', role: 'hygienist',
    description: 'Room setup at the start and end of each day.',
    items: [
      { title: 'Flush waterlines and air/water syringe (2 minutes) before the first patient', cadence: 'daily', due_time: '08:00' },
      { title: 'Barriers stocked; surfaces disinfected', cadence: 'daily', due_time: '08:00' },
      { title: 'Instruments and handpieces sterile and bagged for today', cadence: 'daily', due_time: '08:00' },
      { title: 'End of day: flush lines, clean and disinfect the room', cadence: 'daily', due_time: '17:30' },
      { title: 'Clean the suction trap', cadence: 'weekly', weekday: 5, due_time: '17:30' },
    ],
  },
  {
    key: 'emergency', name: 'Monthly emergency equipment check', position: 'Office manager', role: 'admin',
    description: 'AED, emergency kit and oxygen, checked every month.',
    items: [
      { title: 'AED: ready light on, pads and battery in date', cadence: 'monthly', month_day: 1, due_time: '12:00', result_type: 'pass_fail', critical: 1, instructions: 'Check the status indicator, the pad and battery expiry dates, and that adult and child pads are there.' },
      { title: 'Emergency kit: every drug present, sealed and in date', cadence: 'monthly', month_day: 1, due_time: '12:00', result_type: 'pass_fail', require_photo: 1, critical: 1, instructions: 'Go through the kit against its list. Photograph the expiry dates of anything expiring within 60 days and reorder it.' },
      { title: 'Oxygen tank pressure', cadence: 'monthly', month_day: 1, due_time: '12:00', result_type: 'number', min_value: '1000', unit: 'psi', critical: 1, instructions: 'A full E-cylinder reads about 2000 psi. Refill at your office’s threshold (1000 psi here). Check the mask, tubing and regulator too.' },
    ],
  },
  {
    key: 'annual-training', name: 'Annual training', position: 'Office manager', role: 'admin',
    description: 'Yearly OSHA and HIPAA training, with the certificates.',
    items: [
      { title: 'OSHA bloodborne pathogens training for all staff', cadence: 'annually', month: 1, month_day: 31, due_time: '17:00', require_file: 1, instructions: 'Upload the sign-in sheet or the certificates.' },
      { title: 'HIPAA privacy and security training for all staff', cadence: 'annually', month: 1, month_day: 31, due_time: '17:00', require_file: 1, instructions: 'Upload the sign-in sheet or the certificates.' },
      { title: 'Review the exposure control plan and hazard communication (SDS) binder', cadence: 'annually', month: 1, month_day: 31, due_time: '17:00', require_note: 1 },
    ],
  },
  {
    key: 'waterlines', name: 'Waterline testing', position: 'Sterilization', role: 'assistant',
    description: 'Dental unit waterline treatment and testing.',
    items: [
      { title: 'Shock-treat dental unit waterlines', cadence: 'monthly', month_day: 1, due_time: '17:00', instructions: 'Follow the product’s instructions for your units.' },
      {
        title: 'Waterline test result (CFU/mL)', cadence: 'quarterly', month: 1, month_day: 15, due_time: '17:00', result_type: 'number', max_value: '500', unit: 'CFU/mL', require_file: 1,
        instructions: 'CDC guidance: 500 CFU/mL or less of heterotrophic bacteria. Upload the lab report. Over the limit: shock the lines and retest.',
      },
    ],
  },
];
export const STARTER_BY_KEY = Object.fromEntries(STARTERS.map((s) => [s.key, s]));

// The positions a practice starts with (made once, the first time checklists are opened).
export const DEFAULT_POSITIONS = [
  { name: 'Front desk', role: 'front_desk' },
  { name: 'Hygiene', role: 'hygienist' },
  { name: 'Assisting', role: 'assistant' },
  { name: 'Sterilization', role: 'assistant' },
  { name: 'Doctors', role: 'dentist' },
  { name: 'Office manager', role: 'admin' },
];
