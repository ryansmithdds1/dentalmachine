import { Component } from 'react';

// Browser errors go to the server, which passes them to error monitoring (when it's set up). Only the
// message, stack and page path are sent, a handful per page load at most.
let reported = 0;
export function reportError(err) {
  if (reported >= 5 || !err) return;
  reported++;
  const body = { name: err.name, message: String(err.message || err).slice(0, 500), stack: String(err.stack || '').slice(0, 4000), path: window.location.pathname };
  fetch('/api/client-errors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
}

export function installErrorReporting() {
  window.addEventListener('error', (e) => reportError(e.error || new Error(e.message)));
  window.addEventListener('unhandledrejection', (e) => {
    // Failed API calls are already shown to the user and logged by the server.
    if (e.reason?.name === 'ApiError' || e.reason?.status) return;
    reportError(e.reason instanceof Error ? e.reason : new Error(String(e.reason)));
  });
}

// A screen that crashes shows a way back instead of a blank page.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    reportError(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" role="alert" style={{ maxWidth: 560, margin: '48px auto' }}>
        <h2>Something went wrong on this screen</h2>
        <p className="muted">It has been reported. Your data is safe — nothing was saved halfway.</p>
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="primary" onClick={() => window.location.reload()}>Reload</button>
          <button onClick={() => { window.location.href = '/'; }}>Go to Today</button>
        </div>
      </div>
    );
  }
}
