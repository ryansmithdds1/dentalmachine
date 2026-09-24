import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Radio, Square, RefreshCw, Trash2, Columns2, Printer, ImageDown, Activity, ChevronLeft, ChevronRight, Plus, Video } from 'lucide-react';
import { api, getToken } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useLiveEvents } from '../../live.js';
import { fmtDate } from '../../format.js';
import { ErrorBox, Modal } from '../ui.jsx';
import ImageViewer from '../ImageViewer.jsx';
import SensorTest from './SensorTest.jsx';
import IntraoralCamera from './IntraoralCamera.jsx';
import { MOUNTS, slotLabels, slotAspect, sameSpot } from './mounts.js';
import { useThumb } from './thumbs.js';
import { thumbStyle, withDefaults } from './imageproc.js';
import { readWs, saveWs } from './workstation.js';

// The imaging studio: a full-screen light box for one mount (FMX, bitewings…) beside a diagnostic viewer.
// With a sensor on this workstation it drives the capture: the spot for the next exposure glows, a click
// aims the sensor at another spot, "Retake" replaces one image (the first stays in the chart), and each
// exposure lands with the sensor's live status shown. Any spot can be compared with the same spot from
// earlier visits, and the whole mount printed or saved as one picture.

export default function ImagingStudio({ patient, docs, canEdit, initial, onClose, onDocsChanged }) {
  const { data: mounts, reload } = useApi(`/patients/${patient.id}/mounts`);
  const { data: agents } = useApi('/imaging/agents');
  const [mountId, setMountId] = useState(initial?.mountId || null);
  const [selected, setSelected] = useState(initial?.slot ?? null);
  const [capture, setCapture] = useState(null);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [wsId, setWsId] = useState(readWs);
  const [template, setTemplate] = useState(initial?.template || 'fmx18');
  const [picking, setPicking] = useState(null);
  const [compare, setCompare] = useState(false);
  const [compareWith, setCompareWith] = useState(null);
  const [testing, setTesting] = useState(false);
  const [adjusts, setAdjusts] = useState({});
  const [camera, setCamera] = useState(!!initial?.camera);
  const started = useRef(false);

  useLiveEvents((e) => {
    if (e.patient_id !== patient.id) return;
    if (e.type === 'mounts' || e.type === 'documents') { reload(); onDocsChanged?.(); }
  });

  const current = mounts?.find((m) => m.id === mountId) || (mountId ? null : mounts?.[0]) || null;
  const labels = current ? slotLabels(current.template) : [];
  const agent = agents?.find((a) => String(a.id) === String(wsId)) || null;
  const sensorReady = !!(agent?.sensor && agent.online && canEdit);
  const docById = useMemo(() => new Map((docs || []).map((d) => [d.id, d])), [docs]);
  const adjustOf = (id) => adjusts[id] ?? docById.get(id)?.adjust ?? null;
  const filledSlots = labels.map((_, i) => i).filter((i) => current?.slots[i] != null);
  const nextSlot = capture && current && capture.mount_id === current.id ? (capture.target?.slot ?? labels.findIndex((_, i) => current.slots[i] == null)) : -1;
  const selectedDocId = selected != null ? current?.slots[selected] : null;
  const selectedDoc = selectedDocId ? (docById.get(selectedDocId) || { id: selectedDocId, mime: 'image/png', filename: labels[selected], category: 'xray' }) : null;
  const history = selected != null && current ? sameSpot(mounts, labels[selected], current.id) : [];

  useEffect(() => { if (mounts && !mountId && mounts[0]) setMountId(mounts[0].id); }, [mounts, mountId]);
  useEffect(() => { setCompareWith(history[0]?.docId ?? null); }, [selected, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow a running capture: the sensor's status ("Ready for UR molar — expose the sensor") and where
  // the next image will go. Mount changes arrive as live events.
  useEffect(() => {
    if (!capture?.id) return undefined;
    let alive = true;
    let t;
    const tick = async () => {
      try {
        const c = await api.get(`/imaging/commands/${capture.id}`);
        if (!alive) return;
        if (c.filled !== capture.filled) { reload(); onDocsChanged?.(); }
        if (['done', 'error', 'expired'].includes(c.status)) {
          setCapture(null);
          reload();
          onDocsChanged?.();
          if (c.status === 'expired') setError(new Error(`${capture.workstation} didn't pick up the capture — is the imaging bridge running on that computer?`));
          else if (c.status === 'error') setError(new Error(c.result || 'Capture failed'));
          else setNotice(c.result || 'Capture finished');
          return;
        }
        setCapture((x) => x && { ...x, ...c });
      } catch { /* keep following */ }
      if (alive) t = setTimeout(tick, 900);
    };
    t = setTimeout(tick, 500);
    return () => { alive = false; clearTimeout(t); };
  }, [capture?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback(async ({ slot, retake, newTemplate } = {}) => {
    setError(null);
    setNotice(null);
    try {
      const body = { agent_id: agent.id, ...(newTemplate ? { template: newTemplate } : { mount_id: current.id }), ...(slot != null ? { slot, retake: !!retake } : {}) };
      const c = await api.post(`/patients/${patient.id}/imaging/capture`, body);
      setMountId(c.mount_id);
      setCapture({ id: c.id, mount_id: c.mount_id, workstation: c.workstation, status: 'pending', target: c.target, filled: null });
      reload();
    } catch (e) { setError(e); }
  }, [agent, current, patient.id, reload]);

  // Opened from "Capture from sensor": start straight away.
  useEffect(() => {
    if (started.current || !initial?.capture || !agents || !mounts) return;
    started.current = true;
    if (sensorReady) start({ newTemplate: initial.template || template });
    else setError(new Error(agent ? `${agent.name}'s imaging bridge is offline or has no sensor` : 'Choose this computer\'s workstation first'));
  }, [agents, mounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = async () => {
    try { await api.post(`/imaging/commands/${capture.id}/stop`); } catch (e) { setError(e); }
    setCapture(null);
    setNotice('Capture stopped');
  };
  const aim = async (slot, retake = false) => {
    setError(null);
    if (capture && capture.mount_id === current.id) {
      try {
        const out = await api.put(`/imaging/commands/${capture.id}/target`, { slot, retake });
        setCapture((c) => c && { ...c, target: out.target });
      } catch (e) { setError(e); }
    } else start({ slot, retake });
  };
  const setSlot = async (i, docId) => {
    try {
      const m = await api.put(`/mounts/${current.id}`, { slots: { ...current.slots, [i]: docId } });
      setPicking(null);
      reload();
      return m;
    } catch (e) { setError(e); return null; }
  };
  const newMount = async (tpl) => {
    try {
      const m = await api.post(`/patients/${patient.id}/mounts`, { template: tpl });
      setMountId(m.id);
      setSelected(null);
      reload();
    } catch (e) { setError(e); }
  };
  const removeMount = async () => {
    if (!confirm('Delete this mount? The images stay in the chart.')) return;
    await api.del(`/mounts/${current.id}`).catch(setError);
    setMountId(null);
    setSelected(null);
    reload();
  };

  const clickSlot = (i) => {
    if (current.slots[i] != null) { setSelected(i); return; }
    if (capture && capture.mount_id === current.id) { aim(i); return; }
    if (canEdit) setPicking(i);
  };
  const step = (d) => {
    if (!filledSlots.length) return;
    const at = filledSlots.indexOf(selected);
    setSelected(filledSlots[(at + d + filledSlots.length) % filledSlots.length]);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.target.closest?.('input, select, textarea, .modal')) return;
      if (e.key === 'Escape') {
        if (document.fullscreenElement) return;
        // Opened straight onto an image (X on the Documents tab): Esc goes back to where you were.
        if (selected != null && !initial?.quick) setSelected(null); else onClose();
      }
      if (e.target.closest?.('.image-viewer')) return;
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    document.body.classList.add('studio-open');
    return () => document.body.classList.remove('studio-open');
  }, []);

  const choose = (id) => { setWsId(id); saveWs(id); };
  // With a photo series open, camera shots fill its empty spots in order.
  const photoNext = current?.template === 'photos8' ? labels.findIndex((_, i) => current.slots[i] == null) : -1;
  const photoMount = photoNext >= 0 ? { next: labels[photoNext] } : null;
  const onPhoto = async (doc) => {
    if (doc && photoNext >= 0) await setSlot(photoNext, doc.id);
    reload();
    onDocsChanged?.();
  };
  const capturing = capture && capture.mount_id === current?.id;
  const progress = capture?.progress;
  const status = !capture ? null
    : capture.status === 'pending' ? `Starting ${agent?.sensor || 'the sensor'} on ${capture.workstation}…`
      : progress?.state === 'uploading' ? 'Image received — filing it…'
        : progress?.state === 'error' ? progress.message
          : nextSlot >= 0 ? `Ready for ${labels[nextSlot]}${capture.target?.retake ? ' (retake)' : ''} — expose the sensor` : progress?.message || 'Waiting for the sensor';
  const filledCount = filledSlots.length;
  const retakes = filledSlots.filter((i) => docById.get(current.slots[i])?.retake_of).length;

  return (
    <div className="studio" role="dialog" aria-modal="true" aria-label="Imaging studio">
      <header className="studio-top">
        <button type="button" className="studio-icon" onClick={onClose} aria-label="Close imaging"><X size={18} /></button>
        <div className="studio-title">
          <strong>{patient.preferred_name || patient.first_name} {patient.last_name}</strong>
          <span>{patient.dob ? `DOB ${fmtDate(patient.dob)} · ` : ''}#{patient.id}</span>
        </div>
        {mounts?.length > 0 && (
          <select className="studio-select" aria-label="Mount" value={current?.id || ''} onChange={(e) => { setMountId(Number(e.target.value)); setSelected(null); }}>
            {mounts.map((m) => <option key={m.id} value={m.id}>{MOUNTS[m.template]?.label || m.template} · {fmtDate(m.taken_at)}</option>)}
          </select>
        )}
        {canEdit && (
          <select className="studio-select" aria-label="New mount" value="" onChange={(e) => e.target.value && newMount(e.target.value)}>
            <option value="">+ New mount</option>
            {Object.entries(MOUNTS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </select>
        )}
        <div className="studio-spacer" />
        {agents?.length > 0 && canEdit && (
          <div className="studio-capture">
            <select className="studio-select" aria-label="This workstation" value={agent?.id || ''} onChange={(e) => choose(e.target.value)}>
              <option value="">This computer…</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.online ? '' : ' (offline)'}</option>)}
            </select>
            {agent && (
              <span className={`studio-sensor${agent.online && agent.sensor ? ' on' : ''}`} title={agent.sensor ? `${agent.sensor}${agent.sensor_info?.exposure?.kvp ? ` · ${agent.sensor_info.exposure.kvp} kVp` : ''}` : 'No sensor set up in this bridge'}>
                <i />{agent.sensor ? agent.sensor.replace(/\s*\(.*\)$/, '') : 'No sensor'}{!agent.online ? ' · offline' : ''}
              </span>
            )}
            {agent?.sensor && agent.online && (
              <button type="button" className="studio-btn ghost" onClick={() => setTesting(true)} title="Take one test exposure (no patient)"><Activity size={15} /> Test</button>
            )}
            {capture ? (
              <button type="button" className="studio-btn stop" onClick={stop}><Square size={14} /> Stop</button>
            ) : sensorReady && (
              current && Object.keys(current.slots).length < labels.length ? (
                <button type="button" className="studio-btn go" onClick={() => start()}><Radio size={15} /> Capture</button>
              ) : (
                <span className="studio-newcap">
                  <select className="studio-select" aria-label="Series to capture" value={template} onChange={(e) => setTemplate(e.target.value)}>
                    {Object.entries(MOUNTS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
                  </select>
                  <button type="button" className="studio-btn go" onClick={() => start({ newTemplate: template })}><Radio size={15} /> Capture new</button>
                </span>
              )
            )}
          </div>
        )}
        {canEdit && (
          <button type="button" className={`studio-btn ghost${camera ? ' on' : ''}`} onClick={() => { setCamera(!camera); setSelected(null); }} title="Intraoral camera"><Video size={15} /> Camera</button>
        )}
        {current && filledCount > 0 && (
          <>
            <button type="button" className="studio-icon" title="Save the mount as one picture" aria-label="Save mount as image" onClick={() => exportMount(current, labels, patient, adjustOf, 'download').catch(setError)}><ImageDown size={18} /></button>
            <button type="button" className="studio-icon" title="Print the mount" aria-label="Print mount" onClick={() => exportMount(current, labels, patient, adjustOf, 'print').catch(setError)}><Printer size={18} /></button>
          </>
        )}
      </header>

      {capture && (
        <div className={`studio-banner${progress?.state === 'error' ? ' bad' : ''}`} aria-live="polite">
          <span className="pulse" />
          <strong>{status}</strong>
          {capture.total ? <span className="studio-count">{capture.filled ?? 0} / {capture.total}</span> : null}
          <span className="studio-banner-hint">{capturing ? 'Click any empty spot to aim there · hover an image to retake it' : ''}</span>
        </div>
      )}
      {(error || notice) && (
        <div className="studio-msgs">
          <ErrorBox error={error} />
          {notice && !error && <div className="studio-notice" onClick={() => setNotice(null)}>{notice}</div>}
        </div>
      )}

      <div className={`studio-body${selectedDoc || camera ? ' with-viewer' : ''}`}>
        <section className="lightbox" aria-label="Mount">
          {!current && mounts && (
            <div className="lightbox-empty">
              <p>No mounts yet for {patient.first_name}.</p>
              {sensorReady ? <p>Choose a series above and press <strong>Capture new</strong> to take x-rays from {agent.sensor}.</p> : canEdit ? <p>Start one with <strong>+ New mount</strong>, then place images in it.</p> : null}
            </div>
          )}
          {current && (
            <>
              <div className="lightbox-meta">
                <span>{MOUNTS[current.template]?.label} · {fmtDate(current.taken_at)}</span>
                <span>{filledCount} of {labels.length} images{retakes ? ` · ${retakes} retaken` : ''}</span>
                {canEdit && !capture && <button type="button" className="studio-link" onClick={removeMount}>Delete mount</button>}
              </div>
              <MountBoard mount={current} labels={labels} selected={selected} next={nextSlot} capturing={capturing} canEdit={canEdit} sensorReady={sensorReady}
                adjustOf={adjustOf} docById={docById} onClick={(i) => { if (current.slots[i] != null) setCamera(false); clickSlot(i); }} onRetake={(i) => aim(i, true)} onClear={(i) => setSlot(i, null)} compact={!!selectedDoc || camera} />
            </>
          )}
        </section>

        {camera && !selectedDoc && (
          <section className="studio-viewer">
            <IntraoralCamera patient={patient} photoMount={photoMount} onCaptured={onPhoto} />
          </section>
        )}
        {selectedDoc && (
          <section className="studio-viewer">
            <div className="studio-viewer-head">
              <button type="button" className="studio-icon" onClick={() => step(-1)} aria-label="Previous image"><ChevronLeft size={18} /></button>
              <div>
                <strong>{labels[selected]}</strong>
                <span>{fmtDate(docById.get(selectedDocId)?.taken_at || current.taken_at)}{docById.get(selectedDocId)?.retake_of ? ' · retake' : ''}</span>
              </div>
              <button type="button" className="studio-icon" onClick={() => step(1)} aria-label="Next image"><ChevronRight size={18} /></button>
              <div className="studio-spacer" />
              {history.length > 0 && (
                <button type="button" className={`studio-btn ghost${compare ? ' on' : ''}`} onClick={() => setCompare(!compare)} title="Compare this spot with earlier visits"><Columns2 size={15} /> Compare ({history.length})</button>
              )}
              {canEdit && sensorReady && <button type="button" className="studio-btn ghost" onClick={() => aim(selected, true)} title="Take this one again"><RefreshCw size={15} /> Retake</button>}
              <button type="button" className="studio-icon" onClick={() => setSelected(null)} aria-label="Close viewer"><X size={18} /></button>
            </div>
            <div className={`studio-viewers${compare && compareWith ? ' two' : ''}`}>
              <ImageViewer key={selectedDocId} doc={selectedDoc} canEdit={canEdit} dark height="100%" compact={compare && !!compareWith} autoFocus
                onPrev={() => step(-1)} onNext={() => step(1)} onSaved={({ id, adjust }) => { setAdjusts((a) => ({ ...a, [id]: adjust })); onDocsChanged?.(); }} />
              {compare && compareWith && (
                <div className="studio-compare">
                  <select className="studio-select" aria-label="Compare with" value={compareWith} onChange={(e) => setCompareWith(Number(e.target.value))}>
                    {history.map((h) => <option key={h.docId} value={h.docId}>{fmtDate(h.mount.taken_at)} · {MOUNTS[h.mount.template]?.label}</option>)}
                  </select>
                  <ImageViewer key={compareWith} doc={docById.get(compareWith) || { id: compareWith, mime: 'image/png', filename: labels[selected], category: 'xray' }} canEdit={canEdit} dark compact height="100%" />
                </div>
              )}
            </div>
            <ExposureLine doc={docById.get(selectedDocId)} canEdit={canEdit} onSaved={onDocsChanged} />
          </section>
        )}
      </div>

      {picking != null && (
        <Modal title={`Choose an image for ${labels[picking]}`} onClose={() => setPicking(null)}>
          {sensorReady && <button type="button" className="primary" style={{ marginBottom: 12 }} onClick={() => { const i = picking; setPicking(null); aim(i); }}><Radio size={14} /> Capture this spot from {agent.sensor.replace(/\s*\(.*\)$/, '')}</button>}
          {(docs || []).filter((d) => /^image\/|dicom/.test(d.mime)).length === 0 ? <div className="muted">No images in the chart yet.</div> : (
            <div className="pick-grid">
              {(docs || []).filter((d) => /^image\/|dicom/.test(d.mime)).map((d) => <PickThumb key={d.id} doc={d} onPick={() => setSlot(picking, d.id)} />)}
            </div>
          )}
        </Modal>
      )}
      {testing && agent && <SensorTest agent={agent} onClose={() => setTesting(false)} />}
    </div>
  );
}

export function MountBoard({ mount, labels, selected, next, capturing, canEdit, sensorReady, adjustOf, docById, onClick, onRetake, onClear, compact }) {
  let n = 0;
  // Spot size follows the space: the widest row must fit across, and all the rows down.
  const rows = MOUNTS[mount.template]?.rows || [];
  const rowAr = Math.max(1, ...rows.map((row) => row.reduce((sum, label) => sum + slotAspect(label, mount.template), 0)));
  const maxCount = Math.max(1, ...rows.map((row) => row.length));
  return (
    <div className={`lightbox-board${compact ? ' compact' : ''}`} style={{ '--row-ar': rowAr, '--max-count': maxCount, '--rows': rows.length }}>
      {rows.map((row, r) => (
        <div key={r} className="lightbox-row">
          {row.map((label) => {
            const i = n++;
            const docId = mount.slots[i];
            return (
              <Spot key={i} i={i} label={label} docId={docId} aspect={slotAspect(label, mount.template)} selected={selected === i} next={next === i}
                capturing={capturing} canEdit={canEdit} sensorReady={sensorReady} adjust={docId ? adjustOf(docId) : null} retake={!!docById.get(docId)?.retake_of}
                onClick={() => onClick(i)} onRetake={() => onRetake(i)} onClear={() => onClear(i)} />
            );
          })}
        </div>
      ))}
      {labels.length === 0 && <div className="lightbox-empty">Unknown mount layout</div>}
    </div>
  );
}

function Spot({ i, label, docId, aspect, selected, next, capturing, canEdit, sensorReady, adjust, retake, onClick, onRetake, onClear }) {
  const src = useThumb(docId);
  const st = thumbStyle(adjust);
  const rotated = withDefaults(adjust).rotate % 180 !== 0;
  return (
    <div className={`spot${docId ? ' filled' : ''}${selected ? ' selected' : ''}${next ? ' next' : ''}`} style={{ '--ar': aspect }}
      onClick={onClick} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())} role="button" tabIndex={0}
      aria-label={`${label}${docId ? '' : ' (empty)'}${next ? ', next exposure' : ''}`}>
      {src ? <img key={docId} className="arrive" src={src} alt={label} style={{ filter: st.filter, transform: `translate(-50%, -50%) ${st.transform || ''}`, ...(rotated ? { width: `${100 / aspect}%`, height: `${100 * aspect}%` } : {}) }} /> : docId ? <span className="spot-loading" /> : null}
      <span className="spot-n">{i + 1}</span>
      <span className="spot-label">{label}</span>
      {retake && <span className="spot-badge">Retake</span>}
      {next && <span className="spot-next">{capturing ? 'Next' : ''}</span>}
      {!docId && capturing && !next && <span className="spot-aim">Aim here</span>}
      {docId && canEdit && (
        <span className="spot-actions" onClick={(e) => e.stopPropagation()}>
          {sensorReady && <button type="button" title="Retake this image" aria-label={`Retake ${label}`} onClick={onRetake}><RefreshCw size={13} /></button>}
          <button type="button" title="Take out of the mount (stays in the chart)" aria-label={`Remove ${label} from mount`} onClick={onClear}><Trash2 size={13} /></button>
        </span>
      )}
      {!docId && !capturing && canEdit && <span className="spot-add"><Plus size={16} /></span>}
    </div>
  );
}

function PickThumb({ doc, onPick }) {
  const src = useThumb(doc.id);
  return (
    <button type="button" className="pick" onClick={onPick} title={doc.filename}>
      {src ? <img src={src} alt={doc.filename} style={thumbStyle(doc.adjust)} /> : <span className="spot-loading" />}
      <span>{fmtDate(doc.taken_at || doc.created_at)}{doc.tooth ? ` · #${doc.tooth}` : ''}</span>
    </button>
  );
}

// kVp, mA and time for the radiation log (filled from the workstation's sensor settings at capture).
function ExposureLine({ doc, canEdit, onSaved }) {
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState(null);
  if (!doc || doc.category !== 'xray') return null;
  const e = doc.exposure || {};
  const text = [e.kvp && `${e.kvp} kVp`, e.ma && `${e.ma} mA`, e.seconds && `${e.seconds} s`].filter(Boolean).join(' · ');
  const save = async (ev) => {
    ev.preventDefault();
    try {
      await api.put(`/documents/${doc.id}`, { exposure: { ...e, ...edit } });
      setEdit(null);
      onSaved?.();
    } catch (err) { setError(err); }
  };
  return (
    <div className="exposure-line">
      <span className="muted">Exposure</span>
      {edit ? (
        <form onSubmit={save} className="exposure-form">
          <label>kVp<input type="number" step="1" value={edit.kvp ?? ''} onChange={(x) => setEdit({ ...edit, kvp: x.target.value })} /></label>
          <label>mA<input type="number" step="0.1" value={edit.ma ?? ''} onChange={(x) => setEdit({ ...edit, ma: x.target.value })} /></label>
          <label>sec<input type="number" step="0.01" value={edit.seconds ?? ''} onChange={(x) => setEdit({ ...edit, seconds: x.target.value })} /></label>
          <button className="small primary">Save</button>
          <button type="button" className="small" onClick={() => setEdit(null)}>Cancel</button>
        </form>
      ) : (
        <>
          <span>{text || 'not recorded'}{e.sensor ? ` · ${e.sensor}` : ''}</span>
          {canEdit && <button type="button" className="studio-link" onClick={() => setEdit({ kvp: e.kvp, ma: e.ma, seconds: e.seconds })}>{text ? 'Edit' : 'Record'}</button>}
        </>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

// The mount as one picture (for a referral, the patient, or the insurance claim): dark light box,
// every image in its spot with its saved orientation and brightness, and a header naming the patient.
async function exportMount(mount, labels, patient, adjustOf, mode) {
  const H = 300;
  const GAP = 16;
  const rows = MOUNTS[mount.template].rows;
  let n = 0;
  const layout = rows.map((row) => row.map((label) => ({ label, i: n++, w: Math.round(H * slotAspect(label, mount.template)) })));
  const width = Math.max(...layout.map((row) => row.reduce((s, c) => s + c.w, 0) + GAP * (row.length - 1))) + GAP * 2;
  const top = 64;
  const height = top + rows.length * (H + GAP + 18) + GAP;
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a0d14';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  ctx.font = '600 22px Inter, system-ui, sans-serif';
  ctx.fillText(`${patient.first_name} ${patient.last_name}`, GAP, 36);
  ctx.font = '15px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#9aa4b5';
  ctx.fillText(`${MOUNTS[mount.template].label} · ${fmtDate(mount.taken_at)}${patient.dob ? ` · DOB ${fmtDate(patient.dob)}` : ''}`, GAP, 56);
  const load = async (id) => {
    const res = await fetch(`/api/documents/${id}/image`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) return null;
    const url = URL.createObjectURL(await res.blob());
    const img = new Image();
    await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; img.src = url; });
    URL.revokeObjectURL(url);
    return img.naturalWidth ? img : null;
  };
  let y = top + GAP;
  for (const row of layout) {
    const rowW = row.reduce((s, c) => s + c.w, 0) + GAP * (row.length - 1);
    let x = (width - rowW) / 2;
    for (const cell of row) {
      ctx.strokeStyle = '#2a3242';
      ctx.strokeRect(x + 0.5, y + 0.5, cell.w - 1, H - 1);
      const id = mount.slots[cell.i];
      const img = id ? await load(id) : null;
      if (img) {
        const a = withDefaults(adjustOf(id));
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cell.w, H);
        ctx.clip();
        ctx.translate(x + cell.w / 2, y + H / 2);
        ctx.rotate((a.rotate * Math.PI) / 180);
        if (a.flipH) ctx.scale(-1, 1);
        const [iw, ih] = a.rotate % 180 ? [img.naturalHeight, img.naturalWidth] : [img.naturalWidth, img.naturalHeight];
        const s = Math.min(cell.w / iw, H / ih);
        ctx.filter = [a.brightness && `brightness(${100 + a.brightness}%)`, a.contrast && `contrast(${100 + a.contrast * 1.5}%)`, a.invert && 'invert(1)'].filter(Boolean).join(' ') || 'none';
        ctx.drawImage(img, (-img.naturalWidth * s) / 2, (-img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
        ctx.restore();
      }
      ctx.fillStyle = '#9aa4b5';
      ctx.font = '13px Inter, system-ui, sans-serif';
      ctx.fillText(cell.label, x, y + H + 15);
      x += cell.w + GAP;
    }
    y += H + GAP + 18;
  }
  const url = canvas.toDataURL('image/png');
  const name = `${patient.last_name}-${patient.first_name}-${mount.template}-${mount.taken_at}.png`.replace(/[^\w.-]+/g, '_');
  if (mode === 'download') {
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    return;
  }
  const w = window.open('', '_blank');
  if (!w) throw new Error('Allow pop-ups to print the mount');
  w.document.write(`<!doctype html><title>${name}</title><style>@page{size:landscape;margin:10mm}body{margin:0}img{width:100%}</style><img src="${url}">`);
  w.document.close();
  let printed = false;
  const print = () => {
    if (printed) return;
    printed = true;
    try { w.focus(); w.print(); } catch { /* the window was closed */ }
  };
  w.onload = print;
  setTimeout(print, 600);
}
