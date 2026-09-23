// What a patient's share would cost monthly: the office's own payment plans (at its rate, often 0%) and
// the outside lenders it offers. Amounts in cents.
export function financingOptions(practice, amount) {
  let f = null;
  try { f = practice?.financing ? JSON.parse(practice.financing) : null; } catch { f = null; }
  if (!f || amount <= 0 || amount < (f.min_amount || 0)) return null;
  const rate = (f.in_house_apr || 0) / 100 / 12;
  const monthly = (n) => (rate ? Math.ceil((amount * rate) / (1 - (1 + rate) ** -n)) : Math.ceil(amount / n));
  const inHouse = (f.in_house_months || []).map((months) => ({ months, monthly: monthly(months), total: monthly(months) * months, apr: f.in_house_apr || 0 }));
  if (!inHouse.length && !(f.links || []).length) return null;
  return { amount, in_house: inHouse, links: f.links || [] };
}
