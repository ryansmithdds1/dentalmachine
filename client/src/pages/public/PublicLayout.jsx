import { setLang, useLang, useT } from './i18n.js';

// Shell for patient-facing pages: friendly, mobile-first, no staff navigation. logo: the practice's own (online
// booking); compact: inside another site (the booking widget), with less chrome. wide: a page meant to fill a
// computer screen (a treatment plan presented across the desk); actions: buttons beside the title (Print).
export default function PublicLayout({ title, practice, children, logo = null, compact = false, wide = false, actions = null }) {
  const t = useT();
  const lang = useLang();
  return (
    <div className={`public-page${compact ? ' compact' : ''}${wide ? ' wide' : ''}`}>
      <header className="public-header">
        <div className="public-brand">{logo ? <img src={logo} alt="" className="public-logo" /> : '🦷'} {practice?.name || t('Your dental office')}</div>
        <div className="inline" style={{ gap: 12 }}>
          {practice?.phone && <a href={`tel:${practice.phone}`}>{practice.phone}</a>}
          <button type="button" className="link lang-toggle" onClick={() => setLang(lang === 'es' ? 'en' : 'es')} lang={lang === 'es' ? 'en' : 'es'}>
            {lang === 'es' ? 'English' : 'Español'}
          </button>
        </div>
      </header>
      <main className="public-main">
        {title && (actions
          ? <div className="public-title-row"><h1>{title}</h1><div className="public-title-actions">{actions}</div></div>
          : <h1 style={{ marginBottom: 16 }}>{title}</h1>)}
        {children}
      </main>
      {!compact && <footer className="public-footer">{t('Secured by Dental Machine')}</footer>}
    </div>
  );
}

// A page that couldn't load from its link: the server's plain words (translated when we have them), and for a
// link that's wrong or used up, what to do next. Never says more than the server did about whose link it was.
export function PublicError({ error, hint = true }) {
  const t = useT();
  if (!error) return null;
  const raw = error.message || String(error);
  const message = raw === 'Not found' ? t('We couldn’t find that page.') : t(raw);
  const gone = hint && (error.status === 404 || error.status === 410) && !/call|office|llam/i.test(message);
  return (
    <div className="error" role="alert">
      {message}{/[.!?]$/.test(message) ? '' : '.'}
      {gone && <> {t('Please call the office and we’ll send you a new link.')}</>}
    </div>
  );
}
