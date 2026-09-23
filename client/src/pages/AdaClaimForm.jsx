import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useApi } from '../hooks.js';

// The ADA Dental Claim Form (2024) on plain paper, one sheet per ten services.
const PER_PAGE = 10;
const usd = (c) => (c == null || c === '' ? '' : (c / 100).toFixed(2));
const mdy = (d) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : '');
const Box = ({ n, label, children, className = '', style }) => (
  <div className={`ada-box ${className}`} style={style}>
    <div className="ada-label">{n != null && <b>{n}.</b>} {label}</div>
    <div className="ada-value">{children}</div>
  </div>
);
const Check = ({ on, children }) => <span className="ada-check"><i>{on ? 'X' : ''}</i>{children}</span>;
const UPPER = Array.from({ length: 16 }, (_, i) => String(i + 1));
const LOWER = Array.from({ length: 16 }, (_, i) => String(32 - i));
const P_UPPER = 'ABCDEFGHIJ'.split('');
const P_LOWER = 'TSRQPONMLK'.split('');

function Page({ f, lines, page, pages }) {
  const rows = [...lines, ...Array.from({ length: PER_PAGE - lines.length }, () => null)];
  const last = page === pages;
  const missing = new Set(f.box33);
  return (
    <div className="ada-page">
      <div className="ada-title">
        <strong>ADA Dental Claim Form</strong>
        <span>{[pages > 1 && `Page ${page} of ${pages}`, `Claim #${f.claim_id}`, f.control_number].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="ada-cols">
        <div className="ada-col">
          <div className="ada-section">HEADER INFORMATION</div>
          <Box n={1} label="Type of Transaction (Mark all applicable boxes)">
            <Check on={f.box1.statement}>Statement of Actual Services</Check> <Check on={f.box1.preauth}>Request for Predetermination/Preauthorization</Check> <Check on={f.box1.epsdt}>EPSDT / Title XIX</Check>
          </Box>
          <Box n={2} label="Predetermination/Preauthorization Number">{f.box2}</Box>
          <div className="ada-section">DENTAL BENEFIT PLAN INFORMATION</div>
          <Box n={3} label="Company/Plan Name, Address, City, State, Zip Code" className="tall">{f.box3.name}<br />{f.box3.address}</Box>
          <div className="ada-section">OTHER COVERAGE (Mark applicable box and complete items 5-11. If none, leave blank.)</div>
          <Box n={4} label="Dental? / Medical?"><Check on={f.box4.dental}>Dental</Check> <Check on={f.box4.medical}>Medical</Check></Box>
          <Box n={5} label="Name of Policyholder/Subscriber in #4 (Last, First, Middle Initial, Suffix)">{f.box5}</Box>
          <div className="ada-row">
            <Box n={6} label="Date of Birth (MM/DD/CCYY)">{mdy(f.box6)}</Box>
            <Box n={7} label="Gender">{f.box7}</Box>
            <Box n={8} label="Policyholder/Subscriber ID (Assigned by Plan)">{f.box8}</Box>
          </div>
          <div className="ada-row">
            <Box n={9} label="Plan/Group Number">{f.box9}</Box>
            <Box n={10} label="Patient's Relationship to Person named in #5">{f.box10}</Box>
          </div>
          <Box n={11} label="Other Insurance Company/Dental Benefit Plan Name, Address, City, State, Zip Code" className="tall">{f.box11 ? <>{f.box11.name}<br />{f.box11.address}</> : ''}</Box>
        </div>
        <div className="ada-col">
          <div className="ada-section">POLICYHOLDER/SUBSCRIBER INFORMATION (Assigned by Plan Named in #3)</div>
          <Box n={12} label="Policyholder/Subscriber Name (Last, First, Middle Initial, Suffix), Address, City, State, Zip Code" className="tall">{f.box12.name}<br />{f.box12.address}</Box>
          <div className="ada-row">
            <Box n={13} label="Date of Birth (MM/DD/CCYY)">{mdy(f.box13)}</Box>
            <Box n={14} label="Gender">{f.box14}</Box>
            <Box n={15} label="Policyholder/Subscriber ID (Assigned by Plan)">{f.box15}</Box>
          </div>
          <div className="ada-row">
            <Box n={16} label="Plan/Group Number">{f.box16}</Box>
            <Box n={17} label="Employer Name">{f.box17}</Box>
          </div>
          <div className="ada-section">PATIENT INFORMATION</div>
          <div className="ada-row">
            <Box n={18} label="Relationship to Policyholder/Subscriber in #12">{f.box18}</Box>
            <Box n={19} label="Reserved for Future Use">{f.box19}</Box>
          </div>
          <Box n={20} label="Name (Last, First, Middle Initial, Suffix), Address, City, State, Zip Code" className="tall">{f.box20.name}<br />{f.box20.address}</Box>
          <div className="ada-row">
            <Box n={21} label="Date of Birth (MM/DD/CCYY)">{mdy(f.box21)}</Box>
            <Box n={22} label="Gender">{f.box22}</Box>
            <Box n={23} label="Patient ID/Account # (Assigned by Dentist)">{f.box23}</Box>
          </div>
        </div>
      </div>

      <div className="ada-section">RECORD OF SERVICES PROVIDED</div>
      <table className="ada-services">
        <thead>
          <tr><th /><th>24. Procedure Date (MM/DD/CCYY)</th><th>25. Area of Oral Cavity</th><th>26. Tooth System</th><th>27. Tooth Number(s) or Letter(s)</th><th>28. Tooth Surface</th><th>29. Procedure Code</th><th>29a. Diag. Pointer</th><th>29b. Qty.</th><th>30. Description</th><th>31. Fee</th></tr>
        </thead>
        <tbody>
          {rows.map((l, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>{l ? mdy(l.date) : ''}</td><td>{l?.area}</td><td>{l?.tooth_system}</td><td>{l?.tooth}</td><td>{l?.surfaces}</td><td>{l?.code}</td><td>{l?.diag_pointer}</td><td>{l ? l.quantity : ''}</td><td className="left">{l?.description}</td><td className="num">{l ? usd(l.fee) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ada-row">
        <Box n={33} label="Missing Teeth Information (Place an “X” on each missing tooth.)" style={{ flex: 3 }}>
          <div className="ada-teeth">
            {[UPPER, LOWER].map((row, k) => <div key={k}>{row.map((t) => <span key={t} className={missing.has(t) ? 'x' : ''}>{t}</span>)}</div>)}
            {[P_UPPER, P_LOWER].map((row, k) => <div key={`p${k}`}>{row.map((t) => <span key={t} className={missing.has(t) ? 'x' : ''}>{t}</span>)}</div>)}
          </div>
        </Box>
        <div style={{ flex: 2, display: 'flex', flexDirection: 'column' }}>
          <Box n={34} label="Diagnosis Code List Qualifier (ICD-10 = AB)">{f.box34}</Box>
          <Box n="34a" label="Diagnosis Code(s) (Primary diagnosis in “A”)">{f.box34a.join('  ')}</Box>
        </div>
        <div style={{ flex: 1.3, display: 'flex', flexDirection: 'column' }}>
          <Box n="31a" label="Other Fee(s)">{last ? usd(f.box31a) : ''}</Box>
          <Box n={32} label="Total Fee"><strong>{last ? usd(f.box32) : 'continued'}</strong></Box>
        </div>
      </div>
      <Box n={35} label="Remarks">{f.box35}</Box>

      <div className="ada-cols">
        <div className="ada-col">
          <div className="ada-section">AUTHORIZATIONS</div>
          <Box n={36} label="I have been informed of the treatment plan and associated fees. I agree to be responsible for all charges for dental services and materials not paid by my dental benefit plan… Patient/Guardian Signature">{f.box36}</Box>
          <Box n={37} label="I hereby authorize and direct payment of the dental benefits otherwise payable to me, directly to the below named dentist or dental entity. Subscriber Signature">{f.box37}</Box>
          <div className="ada-section">BILLING DENTIST OR DENTAL ENTITY (Leave blank if dentist or dental entity is not submitting claim on behalf of the patient or insured/subscriber.)</div>
          <Box n={48} label="Name, Address, City, State, Zip Code" className="tall">{f.box48.name}<br />{f.box48.address}</Box>
          <div className="ada-row">
            <Box n={49} label="NPI">{f.box49}</Box>
            <Box n={50} label="License Number">{f.box50}</Box>
            <Box n={51} label="SSN or TIN">{f.box51}</Box>
          </div>
          <div className="ada-row">
            <Box n={52} label="Phone Number">{f.box52}</Box>
            <Box n="52a" label="Additional Provider ID">{f.box52a}</Box>
          </div>
        </div>
        <div className="ada-col">
          <div className="ada-section">ANCILLARY CLAIM/TREATMENT INFORMATION</div>
          <div className="ada-row">
            <Box n={38} label="Place of Treatment (e.g. 11=office; 22=O/P Hospital)">{f.box38}</Box>
            <Box n={39} label="Enclosures (Y or N)">{f.box39 ? 'Y' : 'N'}</Box>
          </div>
          <div className="ada-row">
            <Box n={40} label="Is Treatment for Orthodontics?"><Check on={!f.box40}>No</Check> <Check on={f.box40}>Yes</Check></Box>
            <Box n={41} label="Date Appliance Placed" />
            <Box n={42} label="Months of Treatment" />
          </div>
          <div className="ada-row">
            <Box n={43} label="Replacement of Prosthesis"><Check on={!f.box43}>No</Check> <Check on={f.box43}>Yes</Check></Box>
            <Box n={44} label="Date of Prior Placement" />
          </div>
          <Box n={45} label="Treatment Resulting from"><Check on={false}>Occupational illness/injury</Check> <Check on={false}>Auto accident</Check> <Check on={false}>Other accident</Check></Box>
          <div className="ada-row"><Box n={46} label="Date of Accident" /><Box n={47} label="Auto Accident State" /></div>
          <div className="ada-section">TREATING DENTIST AND TREATMENT LOCATION INFORMATION</div>
          <Box n={53} label="I hereby certify that the procedures as indicated by date are in progress (for procedures that require multiple visits) or have been completed. Signed (Treating Dentist) / Date">
            <span className="ada-sig">{f.box53.name}</span> <span style={{ float: 'right' }}>{mdy(f.box53.date)}</span>
          </Box>
          <div className="ada-row">
            <Box n={54} label="NPI">{f.box54}</Box>
            <Box n={55} label="License Number">{f.box55}</Box>
          </div>
          <div className="ada-row">
            <Box n={56} label="Address, City, State, Zip Code">{f.box56}</Box>
            <Box n="56a" label="Provider Specialty Code">{f.box56a}</Box>
          </div>
          <div className="ada-row">
            <Box n={57} label="Phone Number">{f.box57}</Box>
            <Box n={58} label="Additional Provider ID">{f.box58}</Box>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdaClaimForm() {
  const { id } = useParams();
  const { data: f, error } = useApi(`/claims/${id}/ada`);
  useEffect(() => {
    if (f) {
      document.title = `ADA claim #${f.claim_id}`;
      setTimeout(() => window.print(), 400);
    }
  }, [f]);
  if (error) return <div className="error">{error.message}</div>;
  if (!f) return <div className="empty">Loading…</div>;
  const pages = Array.from({ length: f.pages }, (_, i) => f.lines.slice(i * PER_PAGE, (i + 1) * PER_PAGE));
  return (
    <div className="ada-doc">
      <div className="no-print" style={{ margin: '12px auto', maxWidth: '8.5in' }}>
        <button onClick={() => window.print()}>Print</button>
        <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>Prints on plain letter paper, the layout payers accept for the ADA Dental Claim Form. Sign box 53 before mailing.</span>
      </div>
      {pages.map((lines, i) => <Page key={i} f={f} lines={lines} page={i + 1} pages={f.pages} />)}
    </div>
  );
}
