// Ledger lines that aren't dentistry. Product sales (charge + sales tax, retail_sale_id) and gift certificates (the
// "sold" / "redeemed" adjustments, gift_certificate_id) are real money on the ledger — balances, statements and
// collections include them — but they are not dental production and not write-offs or discounts. Every total of
// production or adjustments leaves them out with this condition; the day sheet and month close show them on their own
// lines ("Retail sales", gift certificates sold / used) so collections still reconcile to deposits.
// `a` is the ledger_entries alias with its dot ('l.'), or '' for none. Reversing entries carry the same links.
export const NOT_RETAIL = (a = '') => `${a}retail_sale_id IS NULL AND ${a}gift_certificate_id IS NULL`;
export const isRetail = (e) => !!(e.retail_sale_id || e.gift_certificate_id);

export const SOLD = 'Gift certificate sold';
export const REDEEMED = 'Gift certificate redeemed';
// The day's (or period's) non-dental lines, from ledger rows: product sales (with their tax), gift certificates sold and
// used. Reversals carry the same links, so voided sales net out.
export function retailTotals(entries) {
  const sum = (fn) => entries.filter(fn).reduce((s, e) => s + e.amount, 0);
  return {
    retail_sales: sum((e) => !!e.retail_sale_id),
    retail_sales_tax: sum((e) => !!e.retail_sale_id && e.type === 'adjustment'),
    gift_certificates_sold: sum((e) => !!e.gift_certificate_id && e.adjustment_type === SOLD),
    gift_certificates_used: -sum((e) => !!e.gift_certificate_id && e.adjustment_type === REDEEMED),
  };
}
