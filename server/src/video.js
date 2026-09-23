import { randomBytes } from 'node:crypto';
import { HttpError } from './auth.js';

// Video visits (teledentistry) by link: the provider's own room (Doxy.me, Zoom…) when they have one,
// otherwise a fresh private Jitsi Meet room, which needs no account. VIDEO_BASE_URL can point at your own Jitsi.
export function videoRoomFor(provider, base = process.env.VIDEO_BASE_URL || 'https://meet.jit.si') {
  if (provider?.video_room_url) return provider.video_room_url;
  return `${base.replace(/\/$/, '')}/DentalMachine-${randomBytes(9).toString('base64url')}`;
}

export function cleanRoomUrl(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!/^https:\/\/[^\s]+$/i.test(s) || s.length > 300) throw new HttpError(400, 'The video room must be an https:// link');
  return s;
}
