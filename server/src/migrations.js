// Versioned data migrations. The schema itself is additive (tables, COLUMNS and INDEXES in db.js, applied on
// every start); changes to existing *data* go here instead, as numbered steps that run once, in order, each in
// a transaction, and are recorded in schema_migrations (id, name, when). Every step says how to undo it —
// `down` — or why it needs no undo. Never edit a step that has shipped; add a new one.
export const MIGRATIONS = [
  {
    id: 1,
    name: 'Office (location) on procedures, claims, notes, messages, calls, documents and prescriptions',
    // Fills only empty values, from the visit, then the charge, then the patient's home office.
    async up(db) {
      const fromVisit = (t) => db.run(`UPDATE ${t} SET location_id = (SELECT a.location_id FROM appointments a WHERE a.id = ${t}.appointment_id) WHERE location_id IS NULL AND appointment_id IS NOT NULL`);
      const fromPatient = (t) => db.run(`UPDATE ${t} SET location_id = (SELECT p.location_id FROM patients p WHERE p.id = ${t}.patient_id) WHERE location_id IS NULL AND patient_id IS NOT NULL`);
      await fromVisit('procedures');
      await db.run(`UPDATE procedures SET location_id = (SELECT l.location_id FROM ledger_entries l WHERE l.procedure_id = procedures.id AND l.type = 'charge' AND l.location_id IS NOT NULL ORDER BY l.id LIMIT 1)
        WHERE location_id IS NULL`);
      await fromPatient('procedures');
      await db.run(`UPDATE claims SET location_id = (SELECT pr.location_id FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = claims.id AND pr.location_id IS NOT NULL ORDER BY ci.id LIMIT 1)
        WHERE location_id IS NULL`);
      for (const t of ['clinical_notes', 'messages']) await fromVisit(t);
      for (const t of ['claims', 'clinical_notes', 'messages', 'calls', 'documents', 'prescriptions']) await fromPatient(t);
    },
    // Nothing to undo that matters: it only filled blanks, and the columns stay (additive schema).
    down: null,
  },
];

export async function runMigrations(db, list = MIGRATIONS) {
  const done = new Set((await db.all('SELECT id FROM schema_migrations')).map((r) => Number(r.id)));
  for (const m of [...list].sort((a, b) => a.id - b.id)) {
    if (done.has(m.id)) continue;
    await db.tx(async () => {
      // One server migrates at a time (Postgres); the loser finds it done and skips.
      if (db.dialect === 'postgres') await db.run('SELECT pg_advisory_xact_lock(424243)');
      if (await db.get('SELECT id FROM schema_migrations WHERE id = ?', m.id)) return;
      await m.up(db);
      await db.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, new Date().toISOString());
    });
  }
}

// Undo the most recent step (for a rollback of a release). Steps without a `down` refuse.
export async function rollbackLast(db, list = MIGRATIONS) {
  const last = await db.get('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1');
  if (!last) return null;
  const m = list.find((x) => x.id === Number(last.id));
  if (!m?.down) throw new Error(`Migration ${last.id} has no undo step`);
  await db.tx(async () => {
    await m.down(db);
    await db.run('DELETE FROM schema_migrations WHERE id = ?', m.id);
  });
  return m.id;
}
