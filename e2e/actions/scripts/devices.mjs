// Actions that need a device or an outside service, measured with simulated ones (batch 3): the x-ray sensor behind
// the imaging bridge, an intraoral camera (Chromium's fake camera), dictation (a recogniser that hears the dentist)
// and connecting the imaging bridge (the robot plays the operatory PC). What the device does isn't counted.
/* global document, localStorage */
import { newPatient, MOD } from '../lib/fixtures.mjs';
import { readFileSync } from 'node:fs';
import { fakeBridge, TALKING_SPEECH } from '../lib/devices.mjs';
import { readZip } from '../../../server/src/zip.js';

export default {
  A030: { // x-rays with the sensor
    role: 'hygienist',
    async setup(t) {
      const p = await newPatient(t, 'Sensa');
      const bridge = await fakeBridge(t, { name: 'Op 3 (robot sensor)' });
      // This computer is Op 3 (chosen once per computer, remembered).
      await t.ctx.addInitScript((id) => { try { localStorage.setItem('dm_workstation', String(id)); } catch { /* storage */ } }, bridge.agent.id);
      t.after(async () => { await bridge.stop(); await t.as('admin').del(`/imaging/agents/${bridge.agent.id}`).catch(() => {}); });
      return { p, bridge };
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=documents`, 'select[aria-label="Series to capture"]');
      await t.step('Images: pick "4 bitewings" as the series', async () => {
        const sel = t.page.locator('select[aria-label="Series to capture"]');
        await t.click(sel);
        await sel.selectOption('bw4');
      });
      await t.step('Click "Capture from Schick 33": the studio opens; each exposure of the sensor lands in the next spot by itself', async () => {
        await t.click('button:has-text("Capture from")');
        await t.see('.studio');
        await t.page.waitForFunction(() => /Mount complete|All spots filled|Capture finished/.test(document.querySelector('.studio')?.textContent || ''), null, { timeout: 30_000 });
      });
      t.note('Measured with a simulated sensor on a simulated imaging bridge (e2e/actions/lib/devices.mjs): the robot exposes all four spots; only the person’s clicks count.');
    },
  },

  A050: { // intraoral photos
    role: 'hygienist',
    async setup(t) {
      await t.ctx.grantPermissions(['camera']);
      return { p: await newPatient(t, 'Camilla') };
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=documents`, 'button:has-text("Intraoral camera")');
      await t.step('Images: click "Intraoral camera": the camera is live in the studio', async () => {
        await t.click('button:has-text("Intraoral camera")');
        await t.see('.iocam-hint');
      });
      // The camera's own key handler takes the press before the robot's counter sees it, so each one is counted here.
      const press = async () => { await t.key(' '); t.extraKeys = (t.extraKeys || 0) + 1; };
      await t.step('Press the camera’s button (Space) for the first photo: filed on the chart', async () => {
        await press();
        await t.see('.iocam-shot');
      });
      await t.step('And again for the second', async () => {
        await press();
        await t.page.waitForFunction(() => document.querySelectorAll('.iocam-shot').length >= 2);
      });
      t.note('Measured with Chromium’s simulated camera; the handpiece button arrives as a key press (Space by default, "Learn button" changes it).');
    },
  },

  A052: { // dictate a note
    role: 'dentist',
    async setup(t) {
      await t.ctx.addInitScript(TALKING_SPEECH, 'two carpules of articaine, rubber dam, shade A2');
      return { p: await newPatient(t, 'Dicta') };
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=notes`, '[aria-label="Type what to add"]');
      await t.step('Notes: press Alt+M and say what happened: it’s written into the note', async () => {
        await t.key('Alt+m');
        await t.page.waitForFunction(() => /articaine/i.test(document.querySelector('textarea[aria-label="Clinical note"]')?.value || ''), null, { timeout: 20_000 });
      });
      await t.step('Press Ctrl/⌘+Enter: saved', async () => {
        await t.key(`${MOD}+Enter`);
        await t.page.waitForFunction(() => !(document.querySelector('textarea[aria-label="Clinical note"]')?.value || '').trim(), null, { timeout: 10_000 });
      });
      t.note('Measured with a simulated speech recogniser (the browser’s own speech recognition, played by the robot).');
    },
  },

  A182: { // connect an imaging bridge
    role: 'admin',
    async setup(t) {
      // Workstations other actions added are gone (removed after them), so this office has none yet.
      const left = await t.as('admin').get('/imaging/agents');
      for (const a of left) await t.as('admin').del(`/imaging/agents/${a.id}`).catch(() => {});
      return {};
    },
    async run(t) {
      await t.open('/schedule', '.sidebar');
      await t.step('Click Settings (bottom of the menu), then "Imaging bridges": with no workstation yet, the setup is open', async () => {
        await t.click('.sidebar a[href="/settings"]');
        await t.see('.settings-nav');
        await t.click('.settings-nav button:text-is("Imaging bridges")');
        await t.see('.bridge-setup input');
      });
      await t.step('Type the workstation’s name ("Op 2") and press Enter', async () => {
        await t.type('Op 2');
        await t.key('Enter');
        await t.see('.bridge-tile');
      });
      let pkg = null;
      await t.step('Click DEXIS, then "Add workstation and download": the install package (with its key) downloads', async () => {
        await t.click('.bridge-tile:has-text("DEXIS")');
        const dl = t.page.waitForEvent('download', { timeout: 15_000 });
        await t.click('.bridge-setup button:has-text("Add workstation and download")');
        pkg = await dl;
        await t.see('.bridge-setup :text("added and its package downloaded")');
      });
      // On Op 2 the package is unzipped and install.cmd starts the bridge (simulated: the robot reads the key from the
      // package's bridge-config.json and says hello with it, as the installed bridge would). Not counted: it's the PC.
      const files = readZip(readFileSync(await pkg.path()));
      const cfgFile = files.find((f) => f.name.endsWith('bridge-config.json'));
      if (!cfgFile) throw new Error(`no bridge-config.json in the package (${files.map((f) => f.name).join(', ')})`);
      const cfg = JSON.parse(cfgFile.data.toString('utf8'));
      const bridge = await fakeBridge(t, { token: cfg.token, sensor: null, apps: [{ id: 'dexis', name: 'DEXIS' }] });
      t.after(() => bridge.stop());
      const op2 = (await t.as('admin').get('/imaging/agents')).find((a) => a.name === 'Op 2');
      if (!op2?.online) throw new Error('Op 2 did not come online with the key from its package');
      t.note('The last part happens on the operatory PC (unzip, install.cmd): simulated by a robot bridge using the key from the downloaded package; Op 2 then shows “online”.');
    },
  },
};
