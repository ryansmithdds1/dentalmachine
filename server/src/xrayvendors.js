import { createHash } from 'node:crypto';

// X-ray AI vendors (backlog XR1): FDA-cleared detection services behind one adapter each. Disease on x-rays is
// only ever detected by one of these — never by a home-grown or general-purpose model.
//
// None of the three publishes a public API reference: access comes with a partner agreement (and a BAA). The
// request and response shapes below follow what each vendor describes publicly — Pearl Second Opinion returns
// labelled bounding boxes with metadata per image; Overjet outlines (segments) each finding and measures bone
// level in mm, asynchronously; VideaHealth analyses a batch of images and returns findings per tooth, often in
// FDI numbering. Every vendor-specific name lives in that vendor's object here (paths, headers, field names,
// label map), so fitting the partner's actual spec is a change to one object; the fixtures in
// test/xrayai.test.js pin the parsing. Verify against the partner spec before any real image is sent.
//
// What leaves the office: the image bytes, its content type and a random per-read reference. Never the patient's
// name, birth date, chart number or our database ids. Calls go through the fetch the app hands us (loggedFetch:
// Settings → Connection activity logs host, path, status and time — no bodies).

// Our finding kinds (xrayai.js KINDS). Each vendor's labels map onto these; anything unknown becomes 'other'
// with the vendor's label kept in the note so nothing is silently dropped.
const KIND_OF = (map, label) => map[String(label || '').toLowerCase()] || 'other';

export class VendorError extends Error {
  // kind: 'image' (this image was refused — e.g. not a radiograph), 'auth' (key/contract), 'down' (5xx, 429,
  // timeout, network): the first is the image's problem, the others the connection's.
  constructor(message, { status = null, kind = 'down' } = {}) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}
const kindForStatus = (s) => (s === 401 || s === 403 ? 'auth' : s === 429 || s >= 500 ? 'down' : s >= 400 ? 'image' : 'down');

// FDI (ISO 3950) → Universal, for vendors that number teeth the international way.
export function fdiToUniversal(t) {
  const n = Number(t);
  if (!Number.isInteger(n)) return null;
  const q = Math.floor(n / 10);
  const i = n % 10;
  if (q >= 1 && q <= 4 && i >= 1 && i <= 8) return String({ 1: 9 - i, 2: 8 + i, 3: 25 - i, 4: 24 + i }[q]);
  if (q >= 5 && q <= 8 && i >= 1 && i <= 5) return 'ABCDEFGHIJKLMNOPQRST'[{ 5: 5 - i, 6: 4 + i, 7: 15 - i, 8: 14 + i }[q]];
  return null;
}
const toothOf = (value, numbering) => {
  if (value == null || value === '') return null;
  if (/^fdi|iso/i.test(numbering || '')) return fdiToUniversal(value);
  const t = String(value).toUpperCase();
  return /^([1-9]|[12][0-9]|3[0-2]|[A-T])$/.test(t) ? t : null;
};
const surfacesOf = (s) => {
  const str = Array.isArray(s) ? s.join('') : String(s || '');
  const out = [...new Set(str.toUpperCase().replace(/[^MODBFLI]/g, ''))].join('');
  return out || null;
};
const round2 = (n) => Math.round(Math.max(0, Math.min(1, Number(n) || 0)) * 100) / 100;
// A box as fractions of the image [x, y, w, h], from pixels or fractions.
const fracBox = (x, y, w, h, width, height) => {
  const px = width > 0 && height > 0 && (x > 1 || y > 1 || w > 1 || h > 1);
  const b = px ? [x / width, y / height, w / width, h / height] : [x, y, w, h];
  return b.every((v) => Number.isFinite(v)) ? b.map((v) => Math.max(0, Math.min(1, v))) : null;
};
const outlineBox = (points, width, height) => {
  if (!Array.isArray(points) || points.length < 2) return null;
  const xs = points.map((p) => Number(p[0]));
  const ys = points.map((p) => Number(p[1]));
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return fracBox(x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0, width, height);
};
const IMAGE_TYPE = { bw: 'bitewing', bitewing: 'bitewing', pa: 'periapical', periapical: 'periapical', pan: 'panoramic', pano: 'panoramic', panoramic: 'panoramic', fmx: 'periapical', ceph: 'cephalometric', cbct: 'cbct' };
const imageTypeOf = (t) => IMAGE_TYPE[String(t || '').toLowerCase()] || (t ? String(t).toLowerCase().slice(0, 30) : null);

// ---------------------------------------------------------------------------------------------------------
// Pearl — Second Opinion. One synchronous call per image: the image in, labelled boxes (pixels) out.
const PEARL_KINDS = {
  caries: 'caries', calculus: 'calculus', periapical_radiolucency: 'periapical', bone_loss: 'bone_loss', margin_discrepancy: 'open_margin',
  filling: 'restoration', restoration: 'restoration', crown: 'crown', root_canal: 'root_canal', implant: 'implant', impaction: 'impacted', impacted_tooth: 'impacted',
};
export const pearl = {
  id: 'pearl', name: 'Pearl Second Opinion', defaultBase: 'https://api.hellopearl.com', async: false,
  submit: ({ base, key, data, mime, ref }) => ({
    url: `${base}/v1/second-opinion/analyze`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'Idempotency-Key': ref },
      body: JSON.stringify({ client_reference: ref, image: { content_type: mime, data: Buffer.from(data).toString('base64') }, include: ['pathology', 'restorations', 'measurements'] }),
    },
  }),
  parse(out) {
    const w = Number(out.image?.width) || 0;
    const h = Number(out.image?.height) || 0;
    const issues = out.quality?.issues || [];
    return {
      vendor_ref: out.analysis_id || null, image_type: imageTypeOf(out.image?.modality), quality: issues.length ? issues.join(', ').replace(/_/g, ' ') : null,
      findings: (out.detections || []).map((d) => {
        const kind = KIND_OF(PEARL_KINDS, d.class);
        const b = d.bbox || {};
        const pct = Math.round(round2(d.score) * 100);
        return {
          vendor_ref: d.id != null ? String(d.id) : null, kind, tooth: toothOf(d.tooth?.number, d.tooth?.system), surfaces: surfacesOf(d.surfaces), confidence: round2(d.score),
          box: fracBox(Number(b.x), Number(b.y), Number(b.w), Number(b.h), w, h), measurement_mm: d.measurements?.bone_level_mm ?? null,
          note: `Pearl Second Opinion: ${d.severity ? `${d.severity} ` : ''}${String(d.class || 'finding').replace(/_/g, ' ')} (${pct}%)`,
        };
      }),
    };
  },
};

// ---------------------------------------------------------------------------------------------------------
// Overjet — the image is posted as it is; the analysis is fetched when ready. Findings are outlines (pixels);
// bone level comes in mm.
const OVERJET_KINDS = {
  caries: 'caries', calculus: 'calculus', parl: 'periapical', boneloss: 'bone_loss', bone_loss: 'bone_loss', margindiscrepancy: 'open_margin', margin_discrepancy: 'open_margin',
  filling: 'restoration', crown: 'crown', rct: 'root_canal', implant: 'implant', impacted: 'impacted',
};
export const overjet = {
  id: 'overjet', name: 'Overjet', defaultBase: 'https://api.overjet.ai', async: true,
  submit: ({ base, key, data, mime, ref }) => ({
    url: `${base}/v2/radiographs`,
    init: { method: 'POST', headers: { 'Content-Type': mime, Authorization: `Bearer ${key}`, 'X-Client-Reference': ref }, body: data },
  }),
  jobId: (out) => out.id,
  poll: ({ base, key, id }) => ({ url: `${base}/v2/radiographs/${encodeURIComponent(id)}/analysis`, init: { method: 'GET', headers: { Authorization: `Bearer ${key}` } } }),
  state: (out) => ({ complete: 'done', completed: 'done', failed: 'failed', rejected: 'failed' }[String(out.status || '').toLowerCase()] || 'waiting'),
  failure: (out) => out.error || out.quality_check?.reason || 'the analysis failed',
  parse(out) {
    const w = Number(out.width) || 0;
    const h = Number(out.height) || 0;
    const qc = out.quality_check;
    return {
      vendor_ref: out.id || null, image_type: imageTypeOf(out.radiograph_type), quality: qc && qc.passed === false ? qc.reason || 'did not pass the quality check' : null,
      findings: (out.findings || []).map((f) => {
        const kind = KIND_OF(OVERJET_KINDS, f.type);
        return {
          vendor_ref: f.finding_id != null ? String(f.finding_id) : null, kind, tooth: toothOf(f.tooth_number, f.numbering), surfaces: surfacesOf(f.surfaces), confidence: round2(f.confidence),
          box: outlineBox(f.outline, w, h), measurement_mm: f.bone_level_mm ?? null,
          note: `Overjet: ${f.stage ? `${f.stage} ` : ''}${f.type || 'finding'}${f.bone_level_mm != null ? `, bone level ${f.bone_level_mm} mm` : ''} (${Math.round(round2(f.confidence) * 100)}%)`,
        };
      }),
    };
  },
};

// ---------------------------------------------------------------------------------------------------------
// VideaHealth — an analysis of one or more images, fetched when ready; findings per tooth (FDI or Universal),
// regions as fractions of the image.
const VIDEA_KINDS = {
  caries: 'caries', calculus: 'calculus', periapical_lesion: 'periapical', bone_loss: 'bone_loss', margin_discrepancy: 'open_margin', restoration: 'restoration',
  crown: 'crown', root_canal: 'root_canal', implant: 'implant', impacted_tooth: 'impacted',
};
export const videahealth = {
  id: 'videahealth', name: 'VideaHealth', defaultBase: 'https://api.videa.ai', async: true,
  submit: ({ base, key, data, mime, ref }) => ({
    url: `${base}/v1/analyses`,
    init: {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Idempotency-Key': ref },
      body: JSON.stringify({ images: [{ reference: ref, content_type: mime, data: Buffer.from(data).toString('base64') }] }),
    },
  }),
  jobId: (out) => out.analysis_id,
  poll: ({ base, key, id }) => ({ url: `${base}/v1/analyses/${encodeURIComponent(id)}`, init: { method: 'GET', headers: { Authorization: `Bearer ${key}` } } }),
  state: (out) => ({ completed: 'done', error: 'failed', failed: 'failed' }[String(out.state || '').toLowerCase()] || 'waiting'),
  failure: (out) => out.error?.message || out.error || 'the analysis failed',
  parse(out, ref) {
    const img = (out.images || []).find((i) => i.reference === ref) || out.images?.[0] || {};
    return {
      vendor_ref: out.analysis_id || null, image_type: imageTypeOf(img.image_class), quality: img.quality_issue || null,
      findings: (img.findings || []).map((f) => {
        const kind = KIND_OF(VIDEA_KINDS, f.type);
        const r = f.region || {};
        return {
          vendor_ref: f.id != null ? String(f.id) : null, kind, tooth: toothOf(f.tooth, f.tooth_numbering), surfaces: surfacesOf(f.surfaces), confidence: round2(f.probability),
          box: fracBox(Number(r.left), Number(r.top), Number(r.width), Number(r.height), 0, 0), measurement_mm: f.measurement_mm ?? null,
          note: `VideaHealth: ${String(f.type || 'finding').toLowerCase().replace(/_/g, ' ')} (${Math.round(round2(f.probability) * 100)}%)`,
        };
      }),
    };
  },
};

export const VENDORS = { pearl, overjet, videahealth };
export const vendorId = (s) => {
  const v = String(s || '').toLowerCase();
  if (/pearl/.test(v)) return 'pearl';
  if (/overjet/.test(v)) return 'overjet';
  if (/videa/.test(v)) return 'videahealth';
  return null;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(fetchImpl, { url, init }, vendor) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new VendorError(`${vendor.name} didn’t answer (${err.name === 'TimeoutError' ? 'timed out' : err.message})`, { kind: 'down' });
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const kind = kindForStatus(res.status);
    const why = kind === 'auth' ? 'the key was refused — check the contract and XRAY_AI_KEY' : out.error?.message || out.error || out.message || `error ${res.status}`;
    throw new VendorError(`${vendor.name}: ${why}`, { status: res.status, kind });
  }
  return out;
}

// One adapter for one vendor: analyze(image) → { vendor_ref, image_type, quality, findings[] } in our shape.
export function vendorAdapter(vendor, { base, key, fetchImpl, pollMs = 2000, maxPolls = 45, sandbox = false }) {
  const root = String(base || vendor.defaultBase).replace(/\/+$/, '');
  return {
    mode: sandbox ? 'sandbox' : vendor.id, vendor: vendor.id, enabled: true, sandbox, cleared: !sandbox,
    label: sandbox ? `${vendor.name} (sandbox — made-up findings for demos)` : vendor.name,
    async analyze({ data, mime, ref, tooth }) {
      const req = vendor.submit({ base: root, key, data, mime, ref });
      if (sandbox && tooth) req.init.headers['X-Sandbox-Tooth'] = String(tooth);
      let out = await call(fetchImpl, req, vendor);
      if (vendor.async) {
        const id = vendor.jobId(out);
        if (!id) throw new VendorError(`${vendor.name} didn’t return an analysis id`, { kind: 'down' });
        for (let i = 0; ; i++) {
          out = await call(fetchImpl, vendor.poll({ base: root, key, id }), vendor);
          const state = vendor.state(out);
          if (state === 'done') break;
          if (state === 'failed') throw new VendorError(`${vendor.name}: ${vendor.failure(out)}`, { kind: 'image' });
          if (i >= maxPolls) throw new VendorError(`${vendor.name} is still working on it — it will be tried again`, { kind: 'down' });
          await wait(pollMs);
        }
      }
      return vendor.parse(out, ref);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Sandbox: each vendor's API played locally, in that vendor's own shapes, so demos and tests run the real
// request building and parsing. Findings are made up (the same every time for the same image); the image
// never leaves the server and nothing is logged as an outside call.
function sandboxFindings(data, tooth) {
  const hash = createHash('sha256').update(Buffer.from(data)).digest();
  const seed = (n) => hash[n % hash.length] / 255;
  const t = Number(tooth) >= 1 && Number(tooth) <= 30 ? Number(tooth) : 3 + Math.floor(seed(1) * 12);
  const list = [
    { kind: 'caries', tooth: t, surfaces: seed(2) > 0.5 ? 'MO' : 'DO', confidence: 0.82, box: [0.22 + seed(3) * 0.2, 0.34, 0.09, 0.08], stage: 'progressed' },
    { kind: 'calculus', tooth: t + 1, confidence: 0.71, box: [0.55, 0.52 + seed(4) * 0.1, 0.07, 0.05] },
    { kind: 'restoration', tooth: t + 2, surfaces: 'O', confidence: 0.95, box: [0.7, 0.3, 0.12, 0.1] },
  ];
  if (seed(5) > 0.4) list.push({ kind: 'bone_loss', tooth: t, confidence: 0.64, box: [0.3, 0.6, 0.18, 0.12], mm: 3.5 });
  return list;
}
const REVERSE = (map) => Object.fromEntries(Object.entries(map).reverse().map(([k, v]) => [v, k]));
const universalToFdi = (t) => {
  for (let q = 1; q <= 4; q++) for (let i = 1; i <= 8; i++) if (fdiToUniversal(q * 10 + i) === String(t)) return q * 10 + i;
  return null;
};
export function sandboxFetch(vendor) {
  const jobs = new Map();
  const W = 1000;
  const H = 800;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const bodyImage = (init) => {
    if (vendor.id === 'overjet') return Buffer.from(init.body);
    const b = JSON.parse(init.body);
    return Buffer.from((b.image || b.images?.[0]).data, 'base64');
  };
  return async (url, init = {}) => {
    const u = new URL(url);
    const tooth = init.headers?.['X-Sandbox-Tooth'];
    if (init.method === 'POST') {
      const list = sandboxFindings(bodyImage(init), tooth);
      const id = `sbx_${createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 20)}`;
      if (vendor.id === 'pearl') {
        const names = REVERSE(PEARL_KINDS);
        return json(200, {
          analysis_id: id, image: { width: W, height: H, modality: 'bitewing' }, quality: { usable: true, issues: [] },
          detections: list.map((f, i) => ({ id: `${id}-${i}`, class: names[f.kind], tooth: { number: f.tooth, system: 'universal' }, surfaces: f.surfaces ? f.surfaces.split('') : [], score: f.confidence, severity: f.stage, bbox: { x: f.box[0] * W, y: f.box[1] * H, w: f.box[2] * W, h: f.box[3] * H }, measurements: f.mm ? { bone_level_mm: f.mm } : {} })),
        });
      }
      jobs.set(id, list);
      return json(202, vendor.id === 'overjet' ? { id, status: 'processing' } : { analysis_id: id, state: 'queued', reference: JSON.parse(init.body).images[0].reference });
    }
    const id = decodeURIComponent(u.pathname.split('/').filter(Boolean).at(vendor.id === 'overjet' ? -2 : -1));
    const list = jobs.get(id);
    if (!list) return json(404, { error: 'unknown analysis' });
    if (vendor.id === 'overjet') {
      const names = { caries: 'Caries', calculus: 'Calculus', restoration: 'Filling', bone_loss: 'BoneLoss' };
      return json(200, {
        id, status: 'complete', radiograph_type: 'BW', width: W, height: H, quality_check: { passed: true },
        findings: list.map((f, i) => ({ finding_id: i + 1, type: names[f.kind], tooth_number: String(f.tooth), numbering: 'universal', surfaces: f.surfaces || '', confidence: f.confidence, stage: f.stage, bone_level_mm: f.mm ?? null, outline: [[f.box[0] * W, f.box[1] * H], [(f.box[0] + f.box[2]) * W, f.box[1] * H], [(f.box[0] + f.box[2]) * W, (f.box[1] + f.box[3]) * H], [f.box[0] * W, (f.box[1] + f.box[3]) * H]] })),
      });
    }
    const names = REVERSE(VIDEA_KINDS);
    return json(200, {
      analysis_id: id, state: 'completed',
      images: [{ reference: null, image_class: 'bitewing', findings: list.map((f, i) => ({ id: i + 1, type: names[f.kind].toUpperCase(), tooth: String(universalToFdi(f.tooth) ?? f.tooth), tooth_numbering: universalToFdi(f.tooth) ? 'FDI' : 'universal', surfaces: f.surfaces ? f.surfaces.split('') : [], probability: f.confidence, measurement_mm: f.mm ?? null, region: { left: f.box[0], top: f.box[1], width: f.box[2], height: f.box[3] } })) }],
    });
  };
}
