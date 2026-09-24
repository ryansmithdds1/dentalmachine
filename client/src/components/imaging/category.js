// What kind of document a dropped or pasted file is, so nobody has to pick a type for each upload:
// DICOM and grey-scale images are x-rays, colour pictures (camera JPEGs, screenshots) are photos, PDFs are
// whatever this person last filed a PDF as (a document unless they changed one), and a clear word in the
// name wins over all of that ("consent.pdf", "insurance card.jpg", "referral letter.pdf", "pano.jpg").

const BY_NAME = [
  [/consent/i, 'consent'],
  [/insurance|ins[_ -]?card|member[_ -]?card|\bcard\b/i, 'insurance_card'],
  [/referr/i, 'referral'],
  [/x-?ray|radiograph|\bpano|\bfmx\b|\bbwx?\b|bitewing|\bpa\d*\b|periapical|\bceph|\bcbct\b|\.dcm$/i, 'xray'],
  [/intraoral|\bphoto|smile|selfie/i, 'photo'],
];

export const isDicom = (file) => /\.dcm$/i.test(file.name || '') || file.type === 'application/dicom';

// Grey-scale when the colour channels barely differ anywhere in a small copy of the picture.
async function looksGrey(file) {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bmp = await createImageBitmap(file);
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, size, size);
    bmp.close?.();
    const px = ctx.getImageData(0, 0, size, size).data;
    let spread = 0;
    for (let i = 0; i < px.length; i += 4) spread += Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]);
    return spread / (px.length / 4) < 8;
  } catch {
    return null;
  }
}

// `lastPdf` is the category this person last chose for a PDF (remembered per person).
export async function guessCategory(file, { lastPdf = 'document' } = {}) {
  const named = BY_NAME.find(([re]) => re.test(file.name || ''));
  if (named) return named[1];
  if (isDicom(file)) return 'xray';
  const type = file.type || '';
  if (type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) return lastPdf;
  if (/^image\/tiff$/.test(type) || /\.tiff?$/i.test(file.name || '')) return 'xray';
  if (/^image\//.test(type)) {
    const grey = await looksGrey(file);
    return grey ? 'xray' : 'photo';
  }
  return /\.(stl|ply|obj)$/i.test(file.name || '') ? 'other' : 'document';
}
