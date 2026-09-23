import { useParams } from 'react-router-dom';
import PublicLayout from './PublicLayout.jsx';
import { useT } from './i18n.js';

export default function PayResult() {
  const t = useT();
  const { result } = useParams();
  const ok = result === 'success' || result === 'card-saved';
  return (
    <PublicLayout title={t(result === 'card-saved' ? 'Card saved' : ok ? 'Thank you!' : 'Payment not completed')}>
      <div className={`public-notice${ok ? ' ok' : ''}`}>
        {t(result === 'card-saved'
          ? 'Your card is saved securely with our card processor. Payment-plan installments will be charged on their due dates, and you can ask us to remove the card at any time.'
          : ok
            ? 'Your payment was received and will appear on your account shortly.'
            : 'No payment was taken. You can use the same link again, or call the office if you need help.')}
      </div>
    </PublicLayout>
  );
}
