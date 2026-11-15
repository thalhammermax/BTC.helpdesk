import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, ApiError, type Me } from './api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import TicketList from './pages/TicketList';
import TicketDetail from './pages/TicketDetail';
import NewTicket from './pages/NewTicket';
import Rules from './pages/admin/Rules';
import Teams from './pages/admin/Teams';
import Users from './pages/admin/Users';
import Categories from './pages/admin/Categories';
import Canned from './pages/admin/Canned';
import SettingsPage from './pages/admin/Settings';
import MailLog from './pages/admin/MailLog';

const MeCtx = createContext<{ me: Me; setMe: (m: Me) => void } | null>(null);
export const useMe = () => useContext(MeCtx)!;

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const loc = useLocation();
  useEffect(() => {
    api<Me>('/me')
      .then((m) => { setMe(m); document.title = m.helpdeskName; })
      .catch((e) => setMe(e instanceof ApiError && e.status === 401 ? null : null));
  }, []);

  if (me === undefined) return <div className="login-wrap muted">Loading…</div>;
  if (me === null) {
    if (loc.pathname !== '/login') return <Navigate to={`/login?returnTo=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
    return <Login />;
  }
  return (
    <MeCtx.Provider value={{ me, setMe }}>
      <div className="shell">
        <Sidebar />
        <main className="main">
          <Routes>
            <Route path="/" element={me.isAgent ? <Dashboard /> : <Navigate to="/tickets" replace />} />
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="/tickets" element={<TicketList />} />
            <Route path="/tickets/new" element={<NewTicket />} />
            <Route path="/tickets/:id" element={<TicketDetail />} />
            {me.role === 'ADMIN' && (
              <>
                <Route path="/admin/rules" element={<Rules />} />
                <Route path="/admin/teams" element={<Teams />} />
                <Route path="/admin/users" element={<Users />} />
                <Route path="/admin/categories" element={<Categories />} />
                <Route path="/admin/canned" element={<Canned />} />
                <Route path="/admin/settings" element={<SettingsPage />} />
                <Route path="/admin/mail" element={<MailLog />} />
              </>
            )}
            <Route path="*" element={<div className="card">Page not found.</div>} />
          </Routes>
        </main>
      </div>
    </MeCtx.Provider>
  );
}

function Sidebar() {
  const { me, setMe } = useMe();
  const loc = useLocation();
  const view = new URLSearchParams(loc.search).get('view');
  const viewLink = (v: string, text: string) => (
    <NavLink to={`/tickets?view=${v}`} className={() => (loc.pathname === '/tickets' && view === v ? 'active' : '')}>
      {text}
    </NavLink>
  );
  const logout = async () => {
    const { logoutUrl } = await api<{ logoutUrl: string }>('/auth/logout', { method: 'POST' });
    window.location.href = logoutUrl;
  };
  const toggleAvailable = async () => {
    const r = await api<{ available: boolean }>('/me', { method: 'PATCH', json: { available: !me.available } });
    setMe({ ...me, available: r.available });
  };
  return (
    <nav className="sidebar">
      <div className="brand"><span className="brand-mark">?</span>{me.helpdeskName}</div>
      <NavLink to="/tickets/new" className="btn primary" style={{ justifyContent: 'center', marginBottom: 8, color: 'var(--accent-ink)' }}>+ New ticket</NavLink>
      {me.isAgent ? (
        <>
          <NavLink to="/" end>Dashboard</NavLink>
          <div className="nav-section">Tickets</div>
          {viewLink('mine', 'Assigned to me')}
          {viewLink('unassigned', 'Unassigned')}
          {viewLink('myteams', 'My teams')}
          {viewLink('overdue', 'Overdue')}
          {viewLink('all', 'All tickets')}
          {viewLink('requested', 'My requests')}
        </>
      ) : (
        <>
          <div className="nav-section">Support</div>
          {viewLink('requested', 'My tickets')}
        </>
      )}
      {me.role === 'ADMIN' && (
        <>
          <div className="nav-section">Admin</div>
          <NavLink to="/admin/rules">Auto-assign rules</NavLink>
          <NavLink to="/admin/teams">Teams</NavLink>
          <NavLink to="/admin/users">Users</NavLink>
          <NavLink to="/admin/categories">Categories</NavLink>
          <NavLink to="/admin/canned">Canned responses</NavLink>
          <NavLink to="/admin/settings">Settings &amp; SLA</NavLink>
          <NavLink to="/admin/mail">Inbound mail log</NavLink>
        </>
      )}
      <div className="spacer" />
      <div className="userbox">
        <div>
          <div style={{ fontWeight: 600 }}>{me.name}</div>
          <div className="small muted">{me.email}</div>
        </div>
        {me.isAgent && (
          <label className="check small" title="Unavailable agents are skipped by auto-assignment">
            <input type="checkbox" checked={me.available} onChange={toggleAvailable} /> Available for assignment
          </label>
        )}
        <button className="btn sm" onClick={logout}>Sign out</button>
      </div>
    </nav>
  );
}
