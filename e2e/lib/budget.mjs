/* global document, sessionStorage */
// Counts what a person has to do in a workflow, so a test fails when a change makes it slower.
//
// An action is a click, a key press (Enter, Tab, arrows, shortcuts) or typing into one field — typing a whole
// name is one action, like the audit counts it. Only real input events count, so drive the page the way a
// person would: page.click / locator.click, page.keyboard.press and page.keyboard.type. (page.fill skips the
// keyboard and would count as nothing, so never use it inside a measured step.)
import assert from 'node:assert/strict';

const COUNTER = () => {
  const KEY = 'dm_e2e_actions';
  const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY)) || { clicks: 0, keys: 0, fields: 0, log: [] }; } catch { return { clicks: 0, keys: 0, fields: 0, log: [] }; } };
  const save = (c) => { try { sessionStorage.setItem(KEY, JSON.stringify(c)); } catch { /* ignore */ } };
  let lastField = null;
  const fieldOf = (el) => el?.closest?.('input, textarea, [contenteditable]');
  document.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted) return;
    const c = read(); c.clicks++; c.log.push(`click ${(e.target.closest('button, a, [role]')?.textContent || e.target.tagName).trim().slice(0, 30)}`); save(c);
    lastField = null;
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    const c = read();
    const field = fieldOf(e.target);
    const typing = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && field;
    if (typing) {
      if (field !== lastField) { c.fields++; c.log.push('type'); }
      lastField = field;
    } else {
      c.keys++;
      c.log.push(`key ${[e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.altKey && 'Alt', e.key].filter(Boolean).join('+')}`);
      lastField = null;
    }
    save(c);
  }, true);
};

export async function trackActions(page) {
  await page.addInitScript(COUNTER);
  await page.evaluate(COUNTER);
}

// Runs `steps` and returns what they took: { actions, clicks, keys, fields, ms, log }.
export async function measure(page, steps) {
  await page.evaluate(() => sessionStorage.removeItem('dm_e2e_actions'));
  const t0 = Date.now();
  await steps();
  const ms = Date.now() - t0;
  const c = await page.evaluate(() => JSON.parse(sessionStorage.getItem('dm_e2e_actions') || '{"clicks":0,"keys":0,"fields":0,"log":[]}'));
  return { ...c, actions: c.clicks + c.keys + c.fields, ms };
}

// Fails the test if a workflow went over its budget (from docs/workflows/specs/).
export function withinBudget(name, result, { actions, ms = 5000 }) {
  const detail = `${name}: ${result.actions} actions (${result.clicks} clicks, ${result.keys} keys, ${result.fields} fields) in ${result.ms} ms — ${result.log.join(', ')}`;
  assert.ok(result.actions <= actions, `${detail}; budget ${actions} actions`);
  assert.ok(result.ms <= ms, `${detail}; budget ${ms} ms`);
  return detail;
}

// Chooses Ctrl or ⌘ the way the app does (the test browser is never a Mac, but be explicit).
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
