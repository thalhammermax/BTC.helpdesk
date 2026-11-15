import { useState } from 'react';
import { api, label, type Team, type User } from '../../api';
import { ErrorBox, Modal, useLoad } from '../../components/ui';

type Draft = { id?: string; name: string; description: string; email: string; strategy: Team['strategy']; memberIds: string[] };

export default function Teams() {
  const { data: teams, error, reload } = useLoad(() => api<Team[]>('/teams'));
  const { data: agents } = useLoad(() => api<User[]>('/users?role=AGENT,ADMIN'));
  const [edit, setEdit] = useState<Draft | null>(null);
  const [err, setErr] = useState<string>();
  const save = async () => {
    if (!edit) return;
    const { id, ...body } = edit;
    try { await api(id ? `/teams/${id}` : '/teams', { method: id ? 'PUT' : 'POST', json: body }); setEdit(null); reload(); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <>
      <div className="topline">
        <h1>Teams</h1>
        <button className="btn primary" onClick={() => setEdit({ name: '', description: '', email: '', strategy: 'ROUND_ROBIN', memberIds: [] })}>+ New team</button>
      </div>
      <ErrorBox error={error} />
      <table className="list">
        <thead><tr><th>Team</th><th>Assignment strategy</th><th>Members</th><th>Open tickets</th><th /></tr></thead>
        <tbody>
          {teams?.map((t) => (
            <tr key={t.id}>
              <td><strong>{t.name}</strong><div className="small muted">{t.description}</div></td>
              <td>{label(t.strategy)}</td>
              <td className="small">{t.members.map((m) => m.user.name).join(', ') || <span className="muted">No members</span>}</td>
              <td>{t._count?.tickets ?? 0}</td>
              <td>
                <button className="btn sm" onClick={() => setEdit({ id: t.id, name: t.name, description: t.description ?? '', email: t.email ?? '', strategy: t.strategy, memberIds: t.members.map((m) => m.user.id) })}>Edit</button>{' '}
                <button className="btn sm danger" onClick={async () => { if (confirm(`Delete team ${t.name}? Its tickets keep their assignee but lose the team.`)) { await api(`/teams/${t.id}`, { method: 'DELETE' }); reload(); } }}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <Modal title={edit.id ? 'Edit team' : 'New team'} onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
          <div className="stack">
            <ErrorBox error={err} />
            <label className="field">Name<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="field">Description<input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
            <label className="field">How should tickets routed to this team be assigned?
              <select value={edit.strategy} onChange={(e) => setEdit({ ...edit, strategy: e.target.value as Team['strategy'] })}>
                <option value="ROUND_ROBIN">Round robin — rotate evenly through available members</option>
                <option value="LEAST_LOADED">Least loaded — member with the fewest open tickets</option>
                <option value="NONE">Leave unassigned in the team queue</option>
              </select>
            </label>
            <div className="field" style={{ fontSize: 12, color: 'var(--text-2)' }}>Members (agents)
              <div className="card" style={{ maxHeight: 240, overflow: 'auto', padding: 10, boxShadow: 'none' }}>
                {agents?.length === 0 && <span className="muted">No agents yet. Users become agents through the Helpdesk.Agent app role in Entra.</span>}
                {agents?.map((a) => (
                  <label key={a.id} className="check" style={{ padding: '3px 0' }}>
                    <input type="checkbox" checked={edit.memberIds.includes(a.id)}
                      onChange={(e) => setEdit({ ...edit, memberIds: e.target.checked ? [...edit.memberIds, a.id] : edit.memberIds.filter((x) => x !== a.id) })} />
                    {a.name} <span className="muted small">{a.email}{a.available ? '' : ' · away'}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
