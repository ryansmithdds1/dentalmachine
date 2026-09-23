import { setLang, useLang, useT } from './i18n.js';

// Shell for patient-facing pages: friendly, mobile-first, no staff navigation.
export default function PublicLayout({ title, practice, children }) {
  const t = useT();
  const lang = useLang();
  return (
    <div className="public-page">
      <header className="public-header">
        <div className="public-brand">🦷 {practice?.name || t('Your dental office')}</div>
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
      <footer className="public-footer">{t('Secured by Dental Machine')}</footer>
    </div>
  );
}
