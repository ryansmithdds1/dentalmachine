import { getToken, getLocationId, ApiError } from '../../api.js';

// Uploads a photo of the stamped deposit slip (sent as the raw file, like documents are).
export async function uploadDepositPhoto(depositId, file) {
  const token = getToken();
  const res = await fetch(`/api/daily-deposits/${depositId}/photos`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(getLocationId() ? { 'X-Location-Id': getLocationId() } : {}) },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || res.statusText, data.details);
  return data;
}

// A random id made when the deposit screen opens: submitting twice (double click, retry) gives back the first deposit.
export const newSubmitKey = () => globalThis.crypto?.randomUUID?.() || `dep-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const STATUS_LABEL = { submitted: 'Submitted', in_bank: 'In the bank', reconciled: 'Reconciled', exception: 'Needs attention', reopened: 'Reopened', taken: 'Taken' };
