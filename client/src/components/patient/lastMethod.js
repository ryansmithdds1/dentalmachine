import { useRemembered, loadPrefs, getPref } from '../../prefs.js';

// The payment method this person used last (per user, on the server), so the usual one is already picked.
export function useLastMethod(methods) {
  const [last, remember] = useRemembered('payment.method', 'credit_card');
  return [methods.includes(last) ? last : 'credit_card', remember];
}

// The method to post with. Remembered defaults load a moment after the form opens; someone quick enough to
// press Enter before then gets the remembered method (what the form is about to show), never a stale default.
// A method picked by hand always wins.
export async function methodToPost(methods, form, pickedByHand) {
  if (pickedByHand) return form.method;
  await loadPrefs();
  const last = getPref('payment.method', form.method);
  return methods.includes(last) ? last : form.method;
}
