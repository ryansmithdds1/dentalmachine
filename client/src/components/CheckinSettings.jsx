import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useAuth } from '../auth.jsx';

// Settings → Mobile check-in: the QR poster for the front door, and how texting HERE works.
export default function CheckinSettings() {
  const { practice } = useAuth();
  const url = `${window.location.origin}/checkin/${practice.slug || `p${practice.id}`}`;
  const [qr, setQr] = useState(null);
  useEffect(() => { QRCode.toDataURL(url, { margin: 1, width: 480 }).then(setQr); }, [url]);
  const print = () => {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.title = 'Check in here';
    w.document.body.style.cssText = 'font-family: system-ui, sans-serif; text-align: center; padding: 48px;';
    const h1 = w.document.createElement('h1');
    h1.textContent = `Welcome to ${practice.name}`;
    h1.style.fontSize = '40px';
    const p1 = w.document.createElement('p');
    p1.textContent = 'Check in from your phone: scan this code';
    p1.style.fontSize = '24px';
    const img = w.document.createElement('img');
    img.src = qr;
    img.style.width = '360px';
    const p2 = w.document.createElement('p');
    p2.textContent = practice.sms_number ? `…or text HERE to ${practice.sms_number}` : '';
    p2.style.fontSize = '24px';
    w.document.body.append(h1, p1, img, p2);
    img.onload = () => w.print();
  };
  return (
    <div className="card">
      <h2>Mobile check-in</h2>
      <p className="muted" style={{ fontSize: 13 }}>
        Patients check in from their phone — by texting <strong>HERE</strong> to your texting number, or by scanning this code at the door and entering their mobile number and date of birth (a parent checks in the children).
        The schedule updates live, and “Text we’re ready” on the visit lets them wait in the car.
      </p>
      <div className="inline" style={{ gap: 16, alignItems: 'center' }}>
        {qr && <img src={qr} alt="Check-in QR code" style={{ width: 160, height: 160 }} />}
        <div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{url}</div>
          <button className="primary small" style={{ marginTop: 8 }} disabled={!qr} onClick={print}>Print the door poster</button>
        </div>
      </div>
    </div>
  );
}
