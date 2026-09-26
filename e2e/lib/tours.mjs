/* global window, document */
// Drives a guided walkthrough (client/src/components/tours) the way a person would: for each step it waits until the
// overlay has found what to light up, then does exactly what the step expects — a real click on the lit-up control,
// a real key press, real typing — and waits for the overlay to notice and move on. Used by the replay check
// (e2e/workflows/tours-replay.test.mjs) and the overlay test.

// "Ctrl+k" (as the robot recorded it) → Playwright's "Control+k"; a capital letter is Shift+letter.
export function pwCombo(combo) {
  const parts = String(combo).split('+');
  let key = parts.pop() || '+';
  const mods = parts.map((m) => ({ Ctrl: 'Control', Meta: 'Control' }[m] || m));
  if (key === 'Space') key = ' ';
  if (/^[A-Z]$/.test(key) && !mods.includes('Shift')) mods.push('Shift');
  return [...mods, key].join('+');
}

export const tourState = (page) => page.evaluate(() => window.__dmTour?.state() || null);

// Waits (in the page) until the walkthrough is in one of these states; returns its state ({ gone: true } once it ends).
//   'started'  past the intro   'settled'  a step ready to do, or can't find its target, or done   'moved'  not at `at` any more
async function waitForState(page, kind, at, timeout) {
  const h = await page.waitForFunction(([k, a]) => {
    const s = window.__dmTour?.state() || null;
    if (!s) return { gone: true };
    if (k === 'started') return s.phase !== 'intro' && s.phase !== 'preparing' ? s : false;
    if (k === 'settled') return s.phase === 'done' || (s.phase === 'step' && (s.status === 'ready' || s.status === 'missing')) ? s : false;
    return s.phase === 'done' || `${s.step}.${s.sub}` !== a ? s : false;
  }, [kind, at], { timeout, polling: 100 });
  return h.jsonValue();
}

// Starts tour `id` on the training patient (as if picked in Help → Show me and started on Tess).
export async function startTour(page, id, { timeout = 20_000 } = {}) {
  await page.waitForFunction(() => !!window.__dmTour, null, { timeout });
  await page.evaluate((x) => window.__dmTour.start(x), id);
  await page.locator('.tour-callout[data-tour-phase="intro"] button.primary').waitFor({ timeout });
  await page.locator('.tour-callout[data-tour-phase="intro"] button.primary').click();
  await waitForState(page, 'started', null, timeout);
}

// Does one expectation for real.
export async function perform(page, e) {
  const el = e.t ? await page.evaluateHandle((t) => window.__dmTour.find(t), e.t) : null;
  const target = el && (await el.evaluate((x) => !!x)) ? el : null;
  if (e.k === 'click') {
    if (!target) throw new Error(`nothing to click for ${JSON.stringify(e.t)}`);
    // Where it is now (a schedule still scrolling to the time of day moves it): clicked only once the point is on it.
    let spot = null;
    for (let i = 0; i < 20 && !spot; i++) {
      spot = await target.evaluate((x) => {
        x.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const b = x.getBoundingClientRect();
        const cx = b.left + b.width / 2; const cy = b.top + b.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        return hit && (hit === x || x.contains(hit)) ? { cx, cy } : null;
      });
      if (!spot) await page.waitForTimeout(150);
    }
    if (!spot) throw new Error(`something covers the lit-up ${JSON.stringify(e.t)} (the walkthrough’s box?)`);
    await page.mouse.click(spot.cx, spot.cy);
  } else if (e.k === 'key') {
    if (target) await target.evaluate((x) => { if (x !== document.activeElement && !x.contains(document.activeElement) && x.focus) x.focus(); });
    await page.keyboard.press(pwCombo(e.key));
  } else if (e.k === 'type') {
    if (target) {
      await target.evaluate((x) => {
        if (x !== document.activeElement) x.focus();
        if (typeof x.select === 'function' && x.value) x.select(); // typing replaces what was there, as a person selecting it would
      });
    }
    await page.keyboard.type(e.text || 'Practice');
  } else if (e.k === 'select') {
    if (!target) throw new Error(`no list to choose from for ${JSON.stringify(e.t)}`);
    // Already showing the choice (or the only one there is): the overlay moves on by itself.
    const done = await target.evaluate((x, v) => {
      const real = [...x.options].filter((o) => o.value && !o.disabled);
      return !!x.value && (real.length === 1 || (!v.any && (x.value === v.value || x.selectedOptions[0]?.textContent.trim() === v.text)));
    }, e);
    if (done) return;
    await target.evaluate((x, v) => {
      const opt = [...x.options].find((o) => v.value != null && o.value === v.value) || [...x.options].find((o) => v.text != null && o.textContent.trim() === v.text)
        || [...x.options].find((o) => o.value && !o.disabled && o.value !== x.value && !/^(new|\+)/i.test(o.value));
      x.focus();
      return opt?.value;
    }, e).then((v) => target.selectOption(v ?? e.value));
  }
}

// Plays a started tour to the end. Throws with the step that went wrong: a target the overlay can't find (the UI
// changed under the tour), or a step it didn't notice being done.
export async function playTour(page, { stepTimeout = 15_000, onStep = null } = {}) {
  let last = null;
  for (let guard = 0; guard < 200; guard++) {
    const s = await waitForState(page, 'settled', null, stepTimeout);
    // Gone: it ended (a last step that leaves the app ends it), or it was closed; the caller tells which.
    if (s.gone) return { gone: true, last };
    if (s.phase === 'done') return s;
    last = s;
    if (s.status === 'missing') throw new Error(`step ${s.step + 1} of ${s.steps} (“${s.text}”): the overlay can’t find ${JSON.stringify(s.expect?.t)}`);
    if (onStep) await onStep(s);
    const at = `${s.step}.${s.sub}`;
    if (!s.expect) {
      await page.locator('.tour-callout button', { hasText: 'Next' }).click();
    } else {
      await perform(page, s.expect);
    }
    try {
      await waitForState(page, 'moved', at, stepTimeout);
    } catch {
      const now = await tourState(page);
      throw new Error(`step ${s.step + 1} of ${s.steps} (“${s.text}”): did ${JSON.stringify({ ...s.expect, t: s.expect?.t?.css })} but the walkthrough didn’t move on (${JSON.stringify(now && { step: now.step, sub: now.sub, status: now.status })})`);
    }
  }
  throw new Error('the walkthrough never ended');
}
