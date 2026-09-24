import { setLang, useLang, useT } from './i18n.js';

// Shell for patient-facing pages: friendly, mobile-first, no staff navigation. logo: the practice's own (online
// booking); compact: inside another site (the booking widget), with less chrome.
export default function PublicLayout({ title, practice, children, logo = null, compact = false }) {
  const t = useT();
  const lang = useLang();
  return (
    <div className={`public-page${compact ? ' compact' : ''}`}>
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
        {title && <h1 style={{ marginBottom: 16 }}>{title}</h1>}
        {children}
      </main>
      {!compact && <footer className="public-footer">{t('Secured by Dental Machine')}</footer>}
    </div>
  );
}
