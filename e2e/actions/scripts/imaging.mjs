// Images: opening x-rays, adding pictures and documents.
/* global document, sessionStorage, btoa, Buffer */
import { newPatient } from '../lib/fixtures.mjs';

// A picture made in the browser and uploaded as the patient's x-ray (set-up only).
const upload = (t, pid, name) => t.page.evaluate(async ([p, n]) => {
  const c = document.createElement('canvas');
  c.width = 160; c.height = 120;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 160, 120);
  g.addColorStop(0, '#111'); g.addColorStop(1, '#eee');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 160, 120);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const res = await fetch(`/api/patients/${p}/documents?${new URLSearchParams({ filename: n, category: 'xray' })}`, { method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}`, 'Content-Type': 'image/png' }, body: blob });
  return res.json();
}, [pid, name]);

// Two pictures as a camera and a scanner would save them (a photo and a greyscale x-ray), made in the browser.
const pictures = async (t) => (await t.page.evaluate(async () => {
  const pic = async (grey, type) => {
    const c = document.createElement('canvas');
    c.width = 120; c.height = 90;
    const ctx = c.getContext('2d');
    for (let x = 0; x < 120; x += 10) { ctx.fillStyle = grey ? `rgb(${x * 2},${x * 2},${x * 2})` : `hsl(${x * 3},70%,50%)`; ctx.fillRect(x, 0, 10, 90); }
    const blob = await new Promise((r) => c.toBlob(r, type, 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };
  return [await pic(false, 'image/jpeg'), await pic(true, 'image/png')];
})).map((b64, i) => ({ name: i ? 'scan-0412.png' : 'IMG_2041.jpg', mimeType: i ? 'image/png' : 'image/jpeg', buffer: Buffer.from(b64, 'base64') }));

export default {
  A007: {
    role: 'dentist',
    async setup(t) {
      const p = await newPatient(t, 'Xavier');
      return { p };
    },
    async run(t, { p }) {
      // Uploading needs a page on the app's address first (set-up, not counted).
      await t.open(`/patients/${p.id}`, 'h1');
      const ids = [];
      for (const n of ['bw-rm.png', 'bw-rp.png', 'bw-lp.png']) ids.push((await upload(t, p.id, n)).id);
      const mount = await t.api.post(`/patients/${p.id}/mounts`, { template: 'bw4' });
      await t.api.put(`/mounts/${mount.id}`, { slots: { 0: ids[0], 1: ids[1], 2: ids[2] } });
      await t.open(`/patients/${p.id}?tab=documents`, '.mount-strip');
      await t.step('Press X: the newest x-ray set opens on its first image', async () => {
        await t.key('x');
        await t.see('.studio .image-viewer canvas');
      });
      const first = await t.page.textContent('.studio-viewer-head strong');
      await t.step('Press →: the next image', async () => {
        await t.key('ArrowRight');
        await t.page.waitForFunction((was) => document.querySelector('.studio-viewer-head strong')?.textContent !== was, first);
      });
    },
  },

  A031: {
    role: 'hygienist',
    setup: async (t) => ({ p: await newPatient(t, 'Dropped') }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=documents`, '[data-testid=documents-drop]');
      // The keyboard way (a top-20 job): U opens the file picker, where the files are chosen by typing their
      // names and Enter. Dragging them onto the page (one mouse action) does the same.
      await t.step('Press U and choose the two pictures in the file picker: added, each filed as photo or x-ray from the file itself', async () => {
        const files = await pictures(t);
        await t.pickFile(() => t.key('u'), files, { keyboard: true });
        await t.page.waitForFunction(() => document.querySelectorAll('.doc-tile').length === 2);
      });
      t.note('Or drag them from the desktop onto the page (one mouse action), or paste an image (Ctrl+V).');
    },
  },
};
