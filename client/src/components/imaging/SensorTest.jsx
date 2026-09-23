import { useEffect, useState } from 'react';
import { api, getToken } from '../../api.js';
import { ErrorBox, Modal } from '../ui.jsx';

// "Test sensor": one exposure through the workstation's bridge with no patient, showing each step and the
// picture that came back — proves the sensor, its TWAIN driver and the bridge work together.
export default function SensorTest({ agent, onClose }) {
  const [cmd, setCmd] = useState(null);
  const [state, setState] = useState(null);
  const [image, setImage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.post(`/imaging/agents/${agent.id}/test-sensor`).then(setCmd).catch(setError);
  }, [agent.id]);
  useEffect(() => {
    if (!cmd) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const c = await api.get(`/imaging/commands/${cmd.id}`);
        if (!alive) return;
        setState(c);
        if (c.status === 'done' && c.test_image) {
          const res = await fetch(`/api/imaging/commands/${cmd.id}/test-image`, { headers: { Authorization: `Bearer ${getToken()}` } });
          if (res.ok) setImage(URL.createObjectURL(await res.blob()));
        }
        if (['done', 'error', 'expired'].includes(c.status)) return;
      } catch (e) { if (alive) setError(e); }
      if (alive) setTimeout(tick, 900);
    };
    tick();
    return () => { alive = false; };
  }, [cmd]);
  useEffect(() => () => image && URL.revokeObjectURL(image), [image]);

  const status = state?.status;
  const steps = [
    ['Bridge picked it up', status && status !== 'pending'],
    [state?.progress?.message || 'Waiting for the sensor', status === 'done' || state?.progress?.state === 'uploading'],
    ['Image received', status === 'done'],
  ];
  return (
    <Modal title={`Test ${agent.sensor} on ${agent.name}`} onClose={onClose}>
      <ErrorBox error={error} />
      <ol className="sensor-steps">
        {steps.map(([text, done], i) => <li key={i} className={done ? 'done' : status === 'error' || status === 'expired' ? '' : 'active'}>{text}</li>)}
      </ol>
      {status === 'expired' && <div className="error">{agent.name} didn&apos;t pick up the test — is the imaging bridge running on that computer?</div>}
      {status === 'error' && <div className="error">{state.result}</div>}
      {status === 'done' && <div className="public-notice ok">{state.result}</div>}
      {image && <img className="sensor-test-img" src={image} alt="Test exposure" />}
      <div className="form-actions"><button type="button" onClick={onClose}>Close</button></div>
    </Modal>
  );
}
