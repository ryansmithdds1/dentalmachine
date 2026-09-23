import { useParams } from 'react-router-dom';
import PublicLayout from './PublicLayout.jsx';

export default function PayResult() {
  const { result } = useParams();
  const ok = result === 'success';
  return (
    <PublicLayout title={ok ? 'Thank you!' : 'Payment not completed'}>
      <div className={`public-notice${ok ? ' ok' : ''}`}>
        {ok
          ? 'Your payment was received and will appear on your account shortly.'
          : 'No payment was taken. You can use the same link again, or call the office if you need help.'}
      </div>
    </PublicLayout>
  );
}
