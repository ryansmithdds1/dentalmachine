import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorBox } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';
import { usePT } from './paperwork-i18n.js';
import { EducationArticle } from './Kiosk.jsx';
import './paperwork.css';

// A take-home education link (/e/:token): the page the team showed or sent, as it was then. Opening it is
// recorded on the chart (proof the patient got it). General information only — nothing about the patient.
export default function EduPage() {
  const pt = usePT();
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    fetch(`/api/public/edu/${encodeURIComponent(token)}`)
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || r.statusText); setData(d); })
      .catch(setError);
  }, [token]);
  if (error) return <PublicLayout><ErrorBox error={error} /></PublicLayout>;
  if (!data) return <PublicLayout><p>{pt('Loading…')}</p></PublicLayout>;
  return <PublicLayout practice={data.practice}><div className="pw"><EducationArticle article={data} big={false} /></div></PublicLayout>;
}
