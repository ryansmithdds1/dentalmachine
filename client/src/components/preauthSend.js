import { api, getToken, saveBlob, ApiError } from '../api.js';
import { toast } from '../toast.js';

// Pre-authorizations (workflow 38, docs/workflows/specs/38-preauths.md): sent straight to the clearinghouse the way
// claims go (POST /daily/preauths/:id/send). Without a clearinghouse connection the server says so (409), and the
// 837 file downloads instead to upload by hand — the old way, now only the fallback. Nothing fails silently: every
// outcome is a toast, and a clearinghouse that can't be reached is also a Needs attention item (server side).
export async function sendPreauth(pa) {
  try {
    const out = await api.post(`/daily/preauths/${pa.id}/send`);
    toast(out.already_sent ? `Pre-authorization #${pa.id} was already sent` : `Pre-authorization #${pa.id} sent to ${out.clearinghouse || 'the clearinghouse'}`);
    return { sent: true, preauth: out.preauth };
  } catch (e) {
    // 409: no clearinghouse set up; 404: this server doesn't have the send route yet. Either way, the file.
    if (e.status === 409 || e.status === 404) {
      await downloadFile(pa);
      toast(`Pre-authorization #${pa.id} saved as an 837 file — upload it to your clearinghouse`, { ms: 8000 });
      return { sent: false, file: true };
    }
    toast(e.message, { tone: 'error', ms: 8000 });
    throw e;
  }
}

// The 837 predetermination file (POST: it marks the pre-authorization sent).
async function downloadFile(pa) {
  const res = await fetch(`/api/preauths/${pa.id}/837`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(res.status, err.error || res.statusText, err.details);
  }
  saveBlob(await res.blob(), `predetermination-${pa.id}.837`);
}
