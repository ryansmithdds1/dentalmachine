// Shared set-up for the nightly role journeys: a fresh seeded server, one signed-in person, a Playwright trace
// of the whole journey, and a screenshot of the screen a step failed on. E2E_SHOTS=dir keeps both
// (CI uploads that folder when a journey fails).
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { watch, settle, screenProblems, quiet } from '../lib/watch.mjs';

export { quiet };
export const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

// setup(j): anything to prepare once the app is up (runs at the end of the journey's own before hook).
export function journey(name, email, setup) {
  const j = { failed: false };
  before(async () => {
    j.app = await startApp();
    j.browser = await launch();
    j.s = await signIn(j.browser, j.app.base, { email });
    j.page = j.s.page;
    j.base = j.app.base;
    j.w = watch(j.page, { base: j.app.base });
    await j.s.ctx.tracing.start({ screenshots: true, snapshots: true });
    j.today = (await j.s.get('/dashboard')).today; // the practice's date, whatever this machine's clock says
    if (setup) await setup(j);
  });
  after(async () => {
    const dir = process.env.E2E_SHOTS;
    if (dir && j.failed) {
      mkdirSync(dir, { recursive: true });
      await j.s?.ctx.tracing.stop({ path: join(dir, `journey-${name}-trace.zip`) }).catch(() => {});
    } else await j.s?.ctx.tracing.stop().catch(() => {});
    await j.browser?.close();
    await j.app?.stop();
  });

  // One step of the journey: on failure, a screenshot and what the page said.
  j.step = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      j.failed = true;
      const dir = process.env.E2E_SHOTS;
      if (dir) {
        mkdirSync(dir, { recursive: true });
        await j.page.screenshot({ path: join(dir, `journey-${name}-${label.replace(/\W+/g, '-')}.png`), fullPage: true }).catch(() => {});
      }
      err.message = `${label}: ${err.message}${j.w.pageErrors.length ? `\nPage errors: ${j.w.pageErrors.join('; ')}` : ''}`;
      throw err;
    }
  };
  // Opens a screen; pop-ups (office alerts) are closed unless the screen opens one on purpose (keep).
  j.goto = async (path, selector, { keep = false } = {}) => {
    await j.page.goto(`${j.base}${path}`);
    if (selector) await j.page.waitForSelector(selector);
    if (!keep) await quiet(j.page);
  };
  // Nothing on screen looks broken and nothing failed along the way.
  j.healthy = async (where) => {
    await settle(j.page, j.w, { timeout: 10_000 });
    const problems = (await screenProblems(j.page)).filter((p) => !p.startsWith('page scrolls sideways'));
    const failed = j.w.responses.filter((r) => r.status >= 500).map((r) => `${r.status} ${r.method} ${r.path}`);
    assert.deepEqual([...problems, ...failed, ...j.w.pageErrors, ...j.s.errors], [], `${where}: the screen is healthy`);
  };
  j.until = async (check, what, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      const v = await check();
      if (v) return v;
      await j.page.waitForTimeout(250);
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  return j;
}
