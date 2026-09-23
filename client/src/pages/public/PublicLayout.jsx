// Shell for patient-facing pages: friendly, mobile-first, no staff navigation.
export default function PublicLayout({ title, practice, children }) {
  return (
    <div className="public-page">
      <header className="public-header">
        <div className="public-brand">🦷 {practice?.name || 'Your dental office'}</div>
        {practice?.phone && <a href={`tel:${practice.phone}`}>{practice.phone}</a>}
      </header>
      <main className="public-main">
        {title && <h1 style={{ marginBottom: 16 }}>{title}</h1>}
        {children}
      </main>
      <footer className="public-footer">Secured by Dental Machine</footer>
    </div>
  );
}
