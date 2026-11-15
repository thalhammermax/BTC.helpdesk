import { useEffect, useState } from 'react';
import { api } from '../api';

export default function Login() {
  const params = new URLSearchParams(window.location.search);
  const returnTo = params.get('returnTo') ?? '/';
  const error = params.get('error');
  const [cfg, setCfg] = useState<{ devLogin: boolean; entraConfigured: boolean }>();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('ADMIN');
  useEffect(() => { api<typeof cfg>('/auth/config').then(setCfg).catch(() => undefined); }, []);

  const devLogin = async () => {
    await api('/auth/dev-login', { json: { email, role } });
    window.location.href = returnTo;
  };
  return (
    <div className="login-wrap">
      <div className="card login-card stack">
        <div className="brand" style={{ justifyContent: 'center', padding: 0 }}><span className="brand-mark">?</span>Help Desk</div>
        <p className="muted" style={{ margin: 0 }}>Sign in with your work account to submit and track support requests.</p>
        {error && <div className="error">{error}</div>}
        <a className="ms-btn" href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>
          <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
          Sign in with Microsoft
        </a>
        {cfg && !cfg.entraConfigured && <div className="hint">Microsoft Entra is not configured on the server yet (ENTRA_CLIENT_ID).</div>}
        {cfg?.devLogin && (
          <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 14, textAlign: 'left' }}>
            <div className="hint">Development sign-in (DEV_LOGIN=true, never enabled in production)</div>
            <input placeholder="email@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option>ADMIN</option><option>AGENT</option><option>REQUESTER</option>
            </select>
            <button className="btn" onClick={devLogin} disabled={!email}>Dev sign-in</button>
          </div>
        )}
      </div>
    </div>
  );
}
