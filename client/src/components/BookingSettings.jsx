import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ErrorBox } from './ui.jsx';
import OnlineSchedSettings from './OnlineSchedSettings.jsx';

// Settings → Online booking links: the booking page, a button for the office's website, a QR code, and the
// "Book" button on the Google listing. Each is tagged so Online requests shows where a booking came from.
export default function BookingSettings() {
  const { practice } = useAuth();
  const origin = window.location.origin;
  const url = practice.slug ? `${origin}/book/${practice.slug}` : null;
  const [qr, setQr] = useState(null);
  const [google, setGoogle] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { if (url) QRCode.toDataURL(`${url}?src=qr`, { margin: 1, width: 360 }).then(setQr); }, [url]);
  if (!url || !practice.online_booking) return <div className="card"><h2>Online booking</h2><p className="muted">Turn on online booking and choose your booking address in Settings → Practice & security first.</p></div>;
  return (
    <>
    <div className="card">
      <h2>Online booking links</h2>
      <ErrorBox error={err} />
      <label>Your booking page<input readOnly value={url} onFocus={(e) => e.target.select()} /></label>
      <div className="inline" style={{ gap: 16, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {qr && <img src={qr} alt="Booking QR code" style={{ width: 120, height: 120 }} />}
        <div style={{ fontSize: 13 }}>
          <div>QR code for flyers, business cards and the front desk.</div>
          <div style={{ marginTop: 8 }}>
            <strong>Google:</strong> put a “Book” button on your listing in Search and Maps.{' '}
            <button className="small" onClick={async () => { setErr(null); try { setGoogle((await api.post('/reputation/google/booking-link')).uri); } catch (e) { setErr(e); } }}>Add the Book button</button>
            {google && <div className="muted" style={{ fontSize: 12 }}>Done — Google may take a day to show it.</div>}
            <div className="muted" style={{ fontSize: 11 }}>Needs your Google Business Profile connected (Reviews).</div>
          </div>
        </div>
      </div>
    </div>
    <OnlineSchedSettings />
    </>
  );
}
