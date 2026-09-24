import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useActivePatient } from '../../activePatient.jsx';
import { useCommands, useShortcuts } from '../../shortcuts.js';
import { toast } from '../../toast.js';
import ConsentPanel, { openPaperwork } from './ConsentPanel.jsx';

// Forms & consents from anywhere (mounted once in the staff app), for the active patient:
//   Ctrl/⌘K → "Hand iPad to Jane"      — what's due for her next visit goes straight to the office iPad (1 step)
//   Ctrl/⌘K → "Text forms to Jane"     — the same by text or email (no treatment named in the message)
//   Ctrl/⌘K → "Forms & consents for Jane", or Alt+F — the side panel (QR code, this screen, education…)
// Any screen can open the panel: openPaperwork(patientId, { appointmentId }).
export default function PaperworkCommands() {
  const { can } = useAuth();
  const { patientId, recent } = useActivePatient();
  const [panel, setPanel] = useState(null);
  const active = recent.find((r) => r.id === patientId) || null;
  const state = useRef({});
  state.current = { patientId, active };

  useEffect(() => {
    const onOpen = (e) => setPanel({ patientId: e.detail.patientId, appointmentId: e.detail.appointmentId ?? null, autoAction: e.detail.action ?? null, at: Date.now() });
    window.addEventListener('dm:paperwork', onOpen);
    return () => window.removeEventListener('dm:paperwork', onOpen);
  }, []);

  const quickSend = async (channel) => {
    const { patientId: pid, active: who } = state.current;
    if (!pid) return;
    try {
      const r = await api.post(`/patients/${pid}/paperwork/send`, { channel });
      if (channel === 'kiosk') toast(`${r.forms} form${r.forms === 1 ? '' : 's'} on ${r.kiosk?.name || 'the iPad'} for ${who?.first_name || 'the patient'} — hand it over`);
      else toast(r.message?.status === 'sent' ? `Forms sent ${r.message.channel === 'sms' ? 'by text' : 'by email'} to ${who?.first_name || 'the patient'}` : `Couldn’t send: ${r.message?.error || 'try another way'}`, { tone: r.message?.status === 'sent' ? 'ok' : 'error' });
    } catch (e) {
      if (e.details?.nothing_due) toast(`Nothing is due for ${who?.first_name || 'this patient'}’s next visit`);
      else if (e.details?.choose_kiosk || e.status === 400) { toast(e.message, { tone: 'error' }); openPaperwork(pid); } else toast(`Couldn’t send the forms: ${e.message}`, { tone: 'error' });
    }
  };

  const name = active ? `${active.first_name} ${active.last_name}` : '';
  const allowed = !!active && can('patients:write');
  useCommands(allowed ? [
    { id: 'paperwork-ipad', label: `Hand iPad to ${name} — forms & consents`, hint: 'What’s due for their next visit, on the office iPad (no birth date needed)', run: () => quickSend('kiosk') },
    { id: 'paperwork-text', label: `Text forms to ${name}`, hint: 'What’s due for their next visit, as a link by text or email', run: () => quickSend('auto') },
    { id: 'paperwork-panel', label: `Forms & consents for ${name}`, hint: 'Alt+F — iPad, text, QR code, this screen, education', run: () => openPaperwork(active.id) },
  ] : []);
  useShortcuts([{ combo: 'alt+f', handler: () => active && openPaperwork(active.id), label: 'Forms & consents for the active patient', section: 'Active patient', enabled: allowed }]);

  if (!panel) return null;
  return <ConsentPanel key={`${panel.patientId}:${panel.appointmentId}:${panel.at}`} patientId={panel.patientId} appointmentId={panel.appointmentId} autoAction={panel.autoAction} onClose={() => setPanel(null)} />;
}
