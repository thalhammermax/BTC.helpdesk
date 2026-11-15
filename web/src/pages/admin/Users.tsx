import { useState } from 'react';
import { ago, api, label, type User } from '../../api';
import { ErrorBox, useLoad } from '../../components/ui';

export default function Users() {
  const [q, setQ] = useState('');
  const { data: users, error, reload } = useLoad(() => api<User[]>(`/users?q=${encodeURIComponent(q)}`), [q]);
  const [err, setErr] = useState<string>();
  const patch = async (u: User, p: Partial<User>) => {
    try { setErr(undefined); await api(`/users/${u.id}`, { method: 'PATCH', json: p }); reload(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <>
      <h1>Users</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Users are created automatically when they first sign in with Microsoft or email the help desk. Roles come from the
        <strong> Helpdesk.Admin</strong> / <strong>Helpdesk.Agent</strong> app roles in Microsoft Entra.
      </p>
      <div className="filters"><input type="search" placeholder="Search users…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <ErrorBox error={error ?? err} />
      <table className="list">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Available</th><th>Active</th><th>Last sign-in</th></tr></thead>
        <tbody>
          {users?.map((u) => (
            <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
              <td>{u.name}</td>
              <td className="muted">{u.email}</td>
              <td>
                <select value={u.role} onChange={(e) => patch(u, { role: e.target.value as User['role'] })} style={{ width: 'auto' }}>
                  {['REQUESTER', 'AGENT', 'ADMIN'].map((r) => <option key={r} value={r}>{label(r)}</option>)}
                </select>
              </td>
              <td>{u.role !== 'REQUESTER' && <input type="checkbox" checked={u.available} onChange={() => patch(u, { available: !u.available })} aria-label="Available" />}</td>
              <td><input type="checkbox" checked={u.active} onChange={() => patch(u, { active: !u.active })} aria-label="Active" /></td>
              <td className="muted">{u.lastLoginAt ? ago(u.lastLoginAt) : 'never'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
