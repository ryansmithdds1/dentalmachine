import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money } from '../format.js';
import { ErrorBox, useSubmit, ConfirmButton } from '../components/ui.jsx';
import BillingQueue, { QUEUE_ORDER } from '../components/group/BillingQueue.jsx';
import PatientLookup from '../components/group/PatientLookup.jsx';
import GroupReports from '../components/group/GroupReports.jsx';
import RoleTemplates from '../components/group/RoleTemplates.jsx';
import '../components/group/group.css';

// A group of practices (a DSO): each office at a glance, the central billing office's queue and patient
// lookup (for the group's billing team), group reports, and keeping setup and roles in step across offices.
const pct = (n) => (n == null ? '—' : `${n}%`);
const COLS = [
  ['production', 'Production', money], ['collections', 'Collected', money], ['completed_visits', 'Visits', String], ['new_patients', 'New patients', String],
  ['production_per_visit', 'Per visit', (v) => (v == null ? '—' : money(v))], ['acceptance_pct', 'Case acceptance', pct], ['no_show_rate_pct', 'No-shows', pct],
  ['ar_total', 'Owed', money], ['ar_over_90_pct', 'Over 90 days', pct], ['overhead_pct', 'Overhead', pct],
];
// Higher is better except for these.
const LOWER_BETTER = new Set(['no_show_rate_pct', 'ar_over_90_pct', 'overhead_pct', 'ar_total']);

export default function Group() {
  const { user } = useAuth();
  const { data, reload } = useApi('/org');
  if (!data) return <div className="empty">Loading…</div>;
  return (
    <>
      <div className="page-header">
        <div>
          <h1>{data.org ? data.org.name : 'Practice group'}</h1>
          <div className="muted">{data.billing
            ? 'Your offices side by side, and the group’s billing work in one place. You work an item inside its own practice.'
            : 'Your offices side by side, and their setup kept in step. The group sees totals only — never another office’s patients.'}</div>
        </div>
      </div>
      {!data.org && <Start admin={user.role === 'admin'} onDone={reload} />}
      {data.org && !data.role && (
        <div className="card">This practice is part of <strong>{data.org.name}</strong>. Its owners can see this office’s totals and copy shared setup here.
          {user.role === 'admin' && <div style={{ marginTop: 8 }}><LeaveButton onDone={reload} /></div>}
        </div>
      )}
      {data.role && <Dashboard org={data} onChange={reload} />}
    </>
  );
}

function Start({ admin, onDone }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const create = useSubmit(async () => { await api.post('/org', { name }); onDone(); });
  const join = useSubmit(async () => { await api.post('/org/join', { code }); onDone(); });
  if (!admin) return <div className="card muted">This practice isn’t in a group. An administrator can start one or join one.</div>;
  return (
    <div className="grid grid-2">
      <form className="card" onSubmit={(e) => { e.preventDefault(); create.submit(); }}>
        <h2>Start a group</h2>
        <p className="muted" style={{ fontSize: 13 }}>For several offices under one owner, or a DSO. You’ll be its owner; other offices join with a code you give them.</p>
        <ErrorBox error={create.error} />
        <label>Group name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bright Smiles Dental Group" /></label>
        <div className="form-actions"><button className="primary" disabled={!name.trim() || create.busy}>Start group</button></div>
      </form>
      <form className="card" onSubmit={(e) => { e.preventDefault(); join.submit(); }}>
        <h2>Join a group</h2>
        <p className="muted" style={{ fontSize: 13 }}>Enter the code the group’s owner gave you. The group will see this office’s totals and can copy templates and fees here.</p>
        <ErrorBox error={join.error} />
        <label>Join code<input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="8 letters" maxLength={8} /></label>
        <div className="form-actions"><button className="primary" disabled={code.length < 8 || join.busy}>Join</button></div>
      </form>
    </div>
  );
}

function LeaveButton({ onDone }) {
  const leave = useSubmit(async () => { await api.post('/org/leave'); onDone(); });
  return <ConfirmButton ask="Take this practice out of the group?" yes="Leave the group" onConfirm={leave.submit}>Leave the group</ConfirmButton>;
}

const TABS = [['overview', 'Overview'], ['billing', 'Billing queue', (o) => o.billing], ['lookup', 'Patient lookup', (o) => o.billing], ['reports', 'Reports'], ['setup', 'Setup & roles', (o) => o.role === 'owner']];

function Dashboard({ org, onChange }) {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter(([, , show]) => !show || show(org));
  const tab = tabs.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview';
  const { data: summary, reload: reloadSummary } = useApi(org.billing ? '/org/billing/summary' : null);
  const me = { ...org, me: user.id };
  const go = (next, extra = {}) => setParams({ tab: next, ...extra });
  return (
    <>
      <div className="tabs" role="tablist">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => go(k)}>
            {l}{k === 'billing' && summary?.mine ? <span className="count" title="Assigned to you">{summary.mine}</span> : null}
          </button>
        ))}
      </div>
      {tab === 'overview' && <Overview org={org} summary={summary} onQueue={(queue, practice) => go('billing', { queue, practice: String(practice) })} />}
      {tab === 'billing' && <BillingQueue org={me} summary={summary} onChanged={reloadSummary} initialQueue={params.get('queue') || 'outstanding'} initialPractice={params.get('practice') || ''} />}
      {tab === 'lookup' && <PatientLookup />}
      {tab === 'reports' && <GroupReports org={org} />}
      {tab === 'setup' && (
        <>
          <Push org={org} />
          <Manage org={org} onChange={onChange} me={user.id} />
          <RoleTemplates />
        </>
      )}
    </>
  );
}

// A tile per office: this month's numbers and, for the billing team, the work waiting there.
const CHIPS = [['outstanding', 'waiting on payer'], ['denied', 'denied', 'danger'], ['unsent', 'not sent', 'warn'], ['era', 'unmatched payments', 'warn'], ['credits', 'credit balances']];
function Tiles({ roll, summary, org, onQueue }) {
  const billing = new Map((summary?.practices || []).map((p) => [p.practice_id, p]));
  return (
    <div className="grp-tiles">
      {(roll?.practices || []).map((p) => {
        const b = billing.get(p.practice_id);
        return (
          <div key={p.practice_id} className="card grp-tile">
            <div className="grp-tile-head">
              <h3>{p.name}</h3>
              {p.practice_id === org.user_practice_id ? <span className="grp-you">You’re here</span> : p.city ? <span className="muted" style={{ fontSize: 12 }}>{p.city}</span> : null}
            </div>
            <div className="grp-tile-nums">
              <div><div className="k">Production</div><div className="v">{money(p.production).replace('.00', '')}</div></div>
              <div><div className="k">Collected</div><div className="v">{money(p.collections).replace('.00', '')}</div></div>
              <div><div className="k">Owed 90+</div><div className="v" style={p.ar_over_90_pct > 20 ? { color: 'var(--danger)' } : {}}>{p.ar_over_90_pct == null ? '—' : `${p.ar_over_90_pct}%`}</div></div>
            </div>
            {b && (
              <div className="grp-chips">
                {CHIPS.filter(([k]) => b.queues[k].count).map(([k, l, tone]) => (
                  <button key={k} className={`grp-chip ${tone || ''}`} onClick={() => onQueue(k, p.practice_id)} title={`${money(b.queues[k].amount)} · open the queue`}><b>{b.queues[k].count}</b>{l}</button>
                ))}
                {QUEUE_ORDER.every((k) => !b.queues[k].count) && <span className="muted" style={{ fontSize: 12 }}>Billing queues clear</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Overview({ org, summary, onQueue }) {
  const today = new Date().toLocaleDateString('en-CA');
  const [range, setRange] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const { data: roll, error } = useApi(`/org/rollup?from=${range.from}&to=${range.to}`);
  const best = (k) => {
    const vals = (roll?.practices || []).map((p) => p[k]).filter((v) => v != null);
    if (vals.length < 2) return null;
    return LOWER_BETTER.has(k) ? Math.min(...vals) : Math.max(...vals);
  };
  return (
    <>
      <Tiles roll={roll} summary={summary} org={org} onQueue={onQueue} />
      <div className="card inline" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <label className="inline">From <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label className="inline">To <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        <span className="muted" style={{ fontSize: 12 }}>Best office on each measure is highlighted.</span>
      </div>
      <ErrorBox error={error} />
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Office</th>{COLS.map(([k, l]) => <th key={k} className="num">{l}</th>)}</tr></thead>
            <tbody>
              {roll?.practices.map((p) => (
                <tr key={p.practice_id}>
                  <td><strong>{p.name}</strong>{p.city ? <div className="muted" style={{ fontSize: 11 }}>{p.city}</div> : null}</td>
                  {COLS.map(([k, , f]) => <td key={k} className="num" style={p[k] != null && p[k] === best(k) ? { color: 'var(--ok)', fontWeight: 600 } : {}}>{p[k] == null ? '—' : f(p[k])}</td>)}
                </tr>
              ))}
              {roll && (
                <tr style={{ borderTop: '2px solid var(--border)' }}>
                  <td><strong>Group</strong></td>
                  {COLS.map(([k, , f]) => <td key={k} className="num"><strong>{roll.totals[k] == null ? '' : f(roll.totals[k])}</strong></td>)}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Push({ org }) {
  const { user } = useAuth();
  const [from, setFrom] = useState(user.practice_id);
  const [kinds, setKinds] = useState([]);
  const [to, setTo] = useState([]);
  const [result, setResult] = useState(null);
  const push = useSubmit(async () => {
    setResult((await api.post('/org/push', { from_practice_id: Number(from), kinds, to_practice_ids: to })).results);
  });
  const others = org.practices.filter((p) => p.id !== Number(from));
  const toggle = (list, set, v) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h2>Copy setup across offices</h2>
      <ErrorBox error={push.error} />
      <div className="form-grid">
        <label>From<select value={from} onChange={(e) => { setFrom(e.target.value); setTo([]); }}>{org.practices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>What</div>
          {Object.entries(org.pushable).map(([k, l]) => <label key={k} className="checkbox"><input type="checkbox" checked={kinds.includes(k)} onChange={() => toggle(kinds, setKinds, k)} /> {l}</label>)}
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>To (none ticked = every other office)</div>
          {others.map((p) => <label key={p.id} className="checkbox"><input type="checkbox" checked={to.includes(p.id)} onChange={() => toggle(to, setTo, p.id)} /> {p.name}</label>)}
        </div>
      </div>
      {result && <div className="public-notice ok" style={{ marginTop: 8 }}>Copied to {result.length} office{result.length === 1 ? '' : 's'}: {result.map((r) => `${org.practices.find((p) => p.id === r.practice_id)?.name} (${Object.entries(r.counts).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ')})`).join('; ')}.</div>}
      <div className="form-actions"><ConfirmButton className="primary" disabled={!kinds.length || push.busy || !others.length} ask="Copy this setup to the chosen offices? Matching items there are replaced." yes="Copy and replace" onConfirm={push.submit}>Copy</ConfirmButton></div>
    </div>
  );
}

function Manage({ org, onChange, me }) {
  const [code, setCode] = useState(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [billing, setBilling] = useState(false);
  const gen = useSubmit(async () => setCode(await api.post('/org/join-code')));
  const add = useSubmit(async () => { await api.post('/org/members', { email, role, billing }); setEmail(''); setBilling(false); onChange(); });
  const act = useSubmit(async (fn) => { await fn(); onChange(); });
  return (
    <div className="grid grid-2" style={{ marginTop: 12 }}>
      <div className="card">
        <h2>Offices</h2>
        <ErrorBox error={gen.error || act.error} />
        {org.practices.map((p) => (
          <div key={p.id} className="inline" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
            <span>{p.name}{p.city ? <span className="muted"> · {p.city}</span> : null}</span>
            <ConfirmButton className="small" ask={`Remove ${p.name} from the group?`} yes="Remove" onConfirm={() => act.submit(() => api.del(`/org/practices/${p.id}`))}>Remove</ConfirmButton>
          </div>
        ))}
        <div style={{ marginTop: 10 }}>
          <button className="small" onClick={gen.submit}>Get a join code</button>
          {code && <div className="public-notice" style={{ marginTop: 8 }}>Give this to the other office’s administrator (Group → Join a group). It works once, until {new Date(code.expires).toLocaleDateString()}: <strong style={{ fontFamily: 'monospace', fontSize: 16 }}>{code.code}</strong></div>}
        </div>
      </div>
      <div className="card">
        <h2>Who can see the group</h2>
        <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>Viewers see totals. The billing team also works the billing queues and can look up patients across offices (each lookup is recorded).</p>
        <ErrorBox error={add.error} />
        {org.members.map((m) => (
          <div key={m.id} className="inline" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
            <span>{m.name} <span className="muted" style={{ fontSize: 12 }}>{m.practice} · {m.role}{m.role !== 'owner' && Number(m.billing) ? ' · billing team' : ''}</span></span>
            <span className="inline" style={{ gap: 6 }}>
              {m.role !== 'owner' && (
                <label className="checkbox" style={{ fontSize: 12 }} title="Works the group’s billing queues and can look patients up across the group">
                  <input type="checkbox" checked={!!Number(m.billing)} onChange={(e) => act.submit(() => api.put(`/org/members/${m.id}`, { billing: e.target.checked }))} /> Billing team
                </label>
              )}
              {m.id !== me && <button className="small" onClick={() => act.submit(() => api.del(`/org/members/${m.id}`))}>Remove</button>}
            </span>
          </div>
        ))}
        <form className="inline" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); add.submit(); }}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email of someone at a member office" style={{ flex: '1 1 220px' }} />
          <select value={role} onChange={(e) => setRole(e.target.value)}><option value="viewer">Viewer</option><option value="owner">Owner</option></select>
          {role !== 'owner' && <label className="checkbox" style={{ fontSize: 12 }}><input type="checkbox" checked={billing} onChange={(e) => setBilling(e.target.checked)} /> Billing team</label>}
          <button className="small" disabled={!email || add.busy}>Add</button>
        </form>
      </div>
    </div>
  );
}
