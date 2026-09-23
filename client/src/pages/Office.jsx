import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtDate, fmtDateTime, money } from '../format.js';
import { Modal } from '../components/ui.jsx';
import { LabCaseForm, TaskForm, LAB_STATUSES } from '../components/OfficeForms.jsx';

// Team to-do list and lab case tracking.
export default function Office() {
  const { can } = useAuth();
  const [mine, setMine] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const { data: tasks, reload: reloadTasks } = useApi(`/tasks?${mine ? 'mine=true&' : ''}${showDone ? 'status=done' : ''}`);
  const [labFilter, setLabFilter] = useState('open');
  const { data: labs, reload: reloadLabs } = useApi(can('clinical:read') ? `/lab-cases${labFilter === 'open' ? '?open=true' : ''}` : null);
  const [modal, setModal] = useState(null);
  const today = new Date().toISOString().slice(0, 10);

  const toggle = async (t) => {
    await api.put(`/tasks/${t.id}`, { status: t.status === 'done' ? 'open' : 'done' });
    reloadTasks();
  };

  return (
    <>
      <div className="page-header"><h1>To-do & lab cases</h1></div>
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="page-header" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Tasks</h2>
            <div className="actions">
              <div className="seg">
                <button className={!mine ? 'active' : ''} onClick={() => setMine(false)}>Everyone</button>
                <button className={mine ? 'active' : ''} onClick={() => setMine(true)}>Mine</button>
              </div>
              <button className="small" onClick={() => setShowDone(!showDone)}>{showDone ? 'Show open' : 'Show done'}</button>
              <button className="primary" onClick={() => setModal({ type: 'task' })}>+ Task</button>
            </div>
          </div>
          {tasks?.length === 0 && <div className="empty">{showDone ? 'Nothing completed yet.' : 'All caught up. 🎉'}</div>}
          {tasks?.map((t) => (
            <div key={t.id} className="task-row">
              <input type="checkbox" checked={t.status === 'done'} onChange={() => toggle(t)} aria-label="Done" />
              <div style={{ flex: 1 }}>
                <button className="link" style={{ textAlign: 'left', whiteSpace: 'normal', color: 'var(--text)' }} onClick={() => setModal({ type: 'task', item: t })}>
                  {t.priority === 'high' && <span className="badge danger" style={{ marginRight: 6 }}>High</span>}{t.title}
                </button>
                <div className="muted" style={{ fontSize: 12 }}>
                  {t.patient_id && <><Link to={`/patients/${t.patient_id}`}>{t.first_name} {t.last_name}</Link> · </>}
                  {t.assigned_to_name || 'Anyone'}
                  {t.due_date && <span style={{ color: t.due_date < today && t.status === 'open' ? 'var(--danger)' : undefined }}> · due {fmtDate(t.due_date)}</span>}
                  {t.completed_at && ` · done ${fmtDateTime(t.completed_at.replace('T', ' '))}`}
                </div>
              </div>
            </div>
          ))}
        </div>

        {can('clinical:read') && (
          <div className="card" style={{ padding: 0 }}>
            <div className="page-header" style={{ padding: '14px 16px', marginBottom: 0 }}>
              <h2 style={{ margin: 0 }}>Lab cases</h2>
              <div className="actions">
                <div className="seg">
                  <button className={labFilter === 'open' ? 'active' : ''} onClick={() => setLabFilter('open')}>Open</button>
                  <button className={labFilter === 'all' ? 'active' : ''} onClick={() => setLabFilter('all')}>All</button>
                </div>
                {can('clinical:write') && <button className="primary" onClick={() => setModal({ type: 'lab' })}>+ Lab case</button>}
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Patient</th><th>Case</th><th>Lab</th><th>Due</th><th>Status</th></tr></thead>
                <tbody>
                  {labs?.map((l) => (
                    <tr key={l.id} className="clickable" onClick={() => can('clinical:write') && setModal({ type: 'lab', item: l })}>
                      <td><Link to={`/patients/${l.patient_id}`} onClick={(e) => e.stopPropagation()}>{l.first_name} {l.last_name}</Link></td>
                      <td>{l.description}{l.tooth ? ` #${l.tooth}` : ''}{l.shade ? <span className="muted"> · {l.shade}</span> : ''}{l.cost ? <div className="muted">{money(l.cost)}</div> : null}</td>
                      <td>{l.lab_name}</td>
                      <td style={{ color: l.overdue ? 'var(--danger)' : undefined }}>
                        {fmtDate(l.due_date)}
                        {l.at_risk && <div className="badge danger" title="The seat appointment is on or before the lab's due date">Seat at risk</div>}
                        {l.appointment_time && <div className="muted" style={{ fontSize: 11 }}>Seat {fmtDateTime(l.appointment_time)}</div>}
                      </td>
                      <td><span className={`badge ${l.status === 'received' || l.status === 'delivered' ? 'ok' : l.overdue ? 'danger' : 'warn'}`}>{LAB_STATUSES.find((s) => s[0] === l.status)?.[1]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {labs?.length === 0 && <div className="empty">No lab cases.</div>}
            </div>
          </div>
        )}
      </div>

      {modal?.type === 'task' && (
        <Modal title={modal.item ? 'Task' : 'New task'} onClose={() => setModal(null)}>
          <TaskForm task={modal.item} onDone={() => { setModal(null); reloadTasks(); }} />
        </Modal>
      )}
      {modal?.type === 'lab' && (
        <Modal title={modal.item ? 'Lab case' : 'New lab case'} onClose={() => setModal(null)}>
          <LabCaseForm labCase={modal.item} onDone={() => { setModal(null); reloadLabs(); }} />
        </Modal>
      )}
    </>
  );
}
