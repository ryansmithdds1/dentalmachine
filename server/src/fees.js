// Office fee schedules decide what a procedure is charged at (PPO schedules only set what insurance allows).
// The patient's schedule wins (e.g. "Cash / uninsured"), then the provider's (an associate or specialist with
// their own fees), then the office's (multi-location), then the standard fee on the procedure code.
export async function officeFee(db, practiceId, code, { patientId = null, providerId = null, locationId = null } = {}) {
  const pick = async (table, id) => (id ? (await db.get(`SELECT fee_schedule_id FROM ${table} WHERE id = ? AND practice_id = ?`, id, practiceId))?.fee_schedule_id : null);
  for (const scheduleId of [await pick('patients', patientId), await pick('providers', providerId), await pick('locations', locationId)]) {
    if (!scheduleId) continue;
    const item = await db.get('SELECT fee FROM fee_schedule_items WHERE fee_schedule_id = ? AND code = ?', scheduleId, code.code);
    if (item) return item.fee;
  }
  return code.fee;
}

// Every fee change is kept, so old estimates and "what did we charge in 2023" can be answered.
export async function recordFeeChange(db, { practiceId, scheduleId = null, code, oldFee, newFee, userId = null }) {
  if (oldFee === newFee) return;
  await db.run(
    'INSERT INTO fee_history (practice_id, fee_schedule_id, code, old_fee, new_fee, changed_by) VALUES (?, ?, ?, ?, ?, ?)',
    practiceId, scheduleId, code, oldFee ?? null, newFee ?? null, userId,
  );
}
