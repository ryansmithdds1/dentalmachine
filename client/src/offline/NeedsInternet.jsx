import { cloneElement } from 'react';
import { WifiOff } from 'lucide-react';
import { useOnline } from './useOffline.js';

// Wraps a button (or other control) that can't work without the internet — card payments, claims,
// eligibility, texting. Offline it's disabled and says why, instead of failing when clicked.
//   <NeedsInternet><button onClick={charge}>Charge card</button></NeedsInternet>
export function NeedsInternet({ children, what = 'This' }) {
  const online = useOnline();
  if (online) return children;
  return cloneElement(children, {
    disabled: true,
    title: `${what} needs the internet`,
    'aria-disabled': true,
    'data-needs-internet': '',
  });
}

// A short line for a panel that can't load offline (eligibility, messages…).
export function NeedsInternetNote({ what = 'This' }) {
  return (
    <div className="offline-needs muted" role="status">
      <WifiOff size={14} aria-hidden="true" /> {what} needs the internet
    </div>
  );
}
