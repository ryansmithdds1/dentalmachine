// The benchmark lines in the monthly email (BM4). Read from the last answer the nightly benchmark send kept
// (bm_settings.last_results), so building an email never waits on the network. Nothing when the practice hasn't
// joined. Numbers and the practice's own provider names only — no patients.
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
export async function benchmarkDigestBlocks(db, { practiceId, providerId = null, appUrl = '' }) {
  let s;
  try {
    s = await db.get("SELECT status, last_results, last_results_month FROM bm_settings WHERE practice_id = ? AND status = 'joined'", practiceId);
  } catch (err) {
    if (/bm_settings/.test(String(err?.message))) return []; // table not on this database yet
    throw err;
  }
  if (!s?.last_results) return [];
  let r;
  try { r = JSON.parse(s.last_results); } catch { return []; }
  const cards = (r.cards || []).filter((c) => (providerId ? c.provider_id === providerId : true) && c.compared > 0);
  if (!cards.length) return [];
  const monthName = new Date(`${r.month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const items = cards.slice(0, 12).map((c) => {
    const opp = c.opportunities[0];
    return `${c.name}: ${c.summary}${c.headline ? ` ${c.headline}` : ''}${opp ? ` Biggest opportunity: ${opp.label.toLowerCase()} (${ordinal(opp.standing)} percentile).` : ''}`;
  });
  return [
    { type: 'heading', text: `How you compare with practices like yours (${monthName})` },
    { type: 'list', title: r.sample ? 'Benchmarks (sandbox: made-up peer practices)' : 'Benchmarks', items, more: cards.length > 12 ? `…and ${cards.length - 12} more in Dental Machine.` : null },
    { type: 'button', text: 'See benchmarks', url: `${String(appUrl || '').replace(/\/$/, '')}/metrics?tab=benchmarks` },
  ];
}
