import { useSearchParams } from 'react-router-dom';
import { Banknote, Landmark, History, ShieldAlert } from 'lucide-react';
import { useAuth } from '../auth.jsx';
import { useCommands } from '../shortcuts.js';
import DepositBuilder from '../components/deposits/DepositBuilder.jsx';
import CashDrawers from '../components/deposits/CashDrawers.jsx';
import DepositHistory from '../components/deposits/DepositHistory.jsx';
import CashIntegrity from '../components/deposits/CashIntegrity.jsx';
import '../components/deposits/deposits.css';

// Deposits and cash (DC1-DC3, docs/cash-handling.md): today's deposit, cash drawers, every deposit followed to
// the bank, and the owner's Cash integrity report.
export default function Deposits() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const owner = user?.role === 'admin';
  const tabs = [['today', 'Today’s deposit', Landmark], ['drawers', 'Cash drawers', Banknote], ['history', 'History', History], ...(owner ? [['integrity', 'Cash integrity', ShieldAlert]] : [])];
  const tab = tabs.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'today';
  useCommands(tabs.map(([k, name]) => ({ id: `deposits-${k}`, label: `Deposits: ${name}`, run: () => setParams({ tab: k }) })));
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Deposits and cash</h1>
          <div className="muted">Every day’s cash and checks counted, checked against the ledger, and followed to the bank.</div>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(([k, name, Icon]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setParams({ tab: k })}><Icon size={15} /> {name}</button>
        ))}
      </div>
      {tab === 'today' && <DepositBuilder />}
      {tab === 'drawers' && <CashDrawers />}
      {tab === 'history' && <DepositHistory />}
      {tab === 'integrity' && owner && <CashIntegrity />}
    </>
  );
}
