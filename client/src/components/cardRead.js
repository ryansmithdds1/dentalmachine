import { api, getToken } from '../api.js';
import { toBase64 } from './AiFileRead.jsx';

// Insurance card photos → what the AI read, ready for the policy form. Phone photos are several MB; a card
// needs far less, so pictures are shrunk in the browser (longest side 1600px, JPEG) before they're sent.
const MAX_SIDE = 1600;

async function shrink(blob) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(blob.type) || typeof createImageBitmap !== 'function') return { file_base64: await toBase64(blob), mime: blob.type };
  try {
    const img = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    if (scale === 1 && blob.size < 700_000) return { file_base64: await toBase64(blob), mime: blob.type };
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return { file_base64: await toBase64(out), mime: 'image/jpeg' };
  } catch {
    // Some formats can't be drawn (a HEIC the browser can't open): send as is and let the server say.
    return { file_base64: await toBase64(blob), mime: blob.type };
  }
}

// files: the front, then (optionally) the back — Files from a picker or Blobs of stored photos.
export async function readCard(patientId, files) {
  const [front, back] = await Promise.all(files.slice(0, 2).map(shrink));
  return api.post(`/patients/${patientId}/insurance-card/read`, { front, ...(back ? { back } : {}) });
}

// Card photos already in the chart (sent from a form or the portal).
export async function storedCards(documentIds) {
  return Promise.all(documentIds.slice(0, 2).map(async (id) => {
    const res = await fetch(`/api/documents/${id}/file`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error('Couldn’t open the card photo');
    return res.blob();
  }));
}
